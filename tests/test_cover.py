"""Tests for the unified shade cover abstraction."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.const import STATE_CLOSING, STATE_OPENING
from homeassistant.core import Event, HomeAssistant, State
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.shade_dashboard.const import (
    DOMAIN,
    LIVE_EVENT,
    OVERRIDE_MANAGER_KEY,
    SHADES,
    TRACKER_KEY,
    _tracked_entities,
    abstract_entity,
)
from custom_components.shade_dashboard.cover import ShadeCover


async def _setup(hass: HomeAssistant) -> None:
    # seed the real source covers so the abstractions can follow them
    for source in SHADES.values():
        hass.states.async_set(source, "open", {"current_position": 100, "friendly_name": source})
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    # the conftest tracker is a MagicMock; a bare mock's is_calibrating(...)
    # returns a truthy MagicMock, which would block every command
    tracker = hass.data.get(TRACKER_KEY)
    if tracker is not None and hasattr(tracker.is_calibrating, "return_value"):
        tracker.is_calibrating.return_value = False


async def test_a_cover_per_shade(hass: HomeAssistant) -> None:
    """One abstraction cover exists per shade (all 22, tracked + untracked)."""
    await _setup(hass)
    for slot in SHADES:
        assert hass.states.get(abstract_entity(slot)) is not None


async def test_tracked_cover_follows_live_gateway(hass: HomeAssistant) -> None:
    """A tracked cover shows the live gateway position (clamped at rest)."""
    await _setup(hass)
    source = _tracked_entities()[0]
    slot = next(s for s, e in SHADES.items() if e == source)
    ent = abstract_entity(slot)

    # mid-travel: raw live position + closing state (position falling)
    hass.bus.async_fire(LIVE_EVENT, {"positions": {source: 80}, "moving": [source]})
    await hass.async_block_till_done()
    hass.bus.async_fire(LIVE_EVENT, {"positions": {source: 40}, "moving": [source]})
    await hass.async_block_till_done()
    st = hass.states.get(ent)
    assert st.attributes["current_position"] == 40
    assert st.state == STATE_CLOSING

    # stopped near closed: clamps to a clean 0 and does NOT fall back to a stale
    # source position (the whole point of server-side tracking)
    hass.states.async_set(source, "open", {"current_position": 78})  # stale HA value
    hass.bus.async_fire(LIVE_EVENT, {"positions": {source: 2}, "moving": []})
    await hass.async_block_till_done()
    st = hass.states.get(ent)
    assert st.attributes["current_position"] == 0
    assert st.state == "closed"


async def test_untracked_cover_mirrors_source(hass: HomeAssistant) -> None:
    """The RYSE (untracked) cover mirrors its source cover's position + state."""
    await _setup(hass)
    source = SHADES["mbr1"]
    ent = abstract_entity("mbr1")

    hass.states.async_set(source, STATE_CLOSING, {"current_position": 100})
    await hass.async_block_till_done()
    st = hass.states.get(ent)
    assert st.state == STATE_CLOSING
    assert st.attributes["current_position"] == 100

    hass.states.async_set(source, "closed", {"current_position": 0})
    await hass.async_block_till_done()
    assert hass.states.get(ent).attributes["current_position"] == 0


async def test_meta_resolves_when_source_appears_late(hass: HomeAssistant) -> None:
    """Name + features are picked up even if the source loads after us."""
    # set up with the RYSE source ABSENT (its HomeKit bridge loads late)
    for source in SHADES.values():
        if source != SHADES["mbr1"]:
            hass.states.async_set(source, "open", {"current_position": 100})
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    ent = abstract_entity("mbr1")
    # not yet resolved: no name, full feature default
    assert hass.states.get(ent).attributes.get("friendly_name") is None

    # source appears (supported_features 7 = OPEN|CLOSE|SET_POSITION, no STOP)
    hass.states.async_set(
        SHADES["mbr1"],
        "open",
        {"current_position": 100, "friendly_name": "Main Bedroom Shades", "supported_features": 7},
    )
    await hass.async_block_till_done()
    st = hass.states.get(ent)
    assert st.attributes["friendly_name"] == "Main Bedroom Shades"
    assert st.attributes["supported_features"] == 7  # STOP masked out


async def test_command_routes_to_source() -> None:
    """Commanding the abstraction routes a cover service to the real device."""
    source = _tracked_entities()[0]
    slot = next(s for s, e in SHADES.items() if e == source)
    cover = ShadeCover(slot, source, tracked=True)
    cover.hass = MagicMock()
    manager = MagicMock()
    manager.is_automation_context.return_value = False
    tracker = MagicMock()
    tracker.is_calibrating.return_value = False
    cover.hass.data = {OVERRIDE_MANAGER_KEY: manager, TRACKER_KEY: tracker}
    cover.hass.services.async_call = AsyncMock()
    cover._live = 50  # have a live reading, so no pre-command hold/state write

    await cover.async_close_cover()

    cover.hass.services.async_call.assert_awaited_once()
    domain, service, data = cover.hass.services.async_call.await_args.args[:3]
    assert domain == "cover"
    assert service == "close_cover"
    assert data["entity_id"] == source
    manager.set_overridden.assert_called_once_with(cover.entity_id, True)
    tracker.supersede_source_move.assert_called_once_with(source)


async def test_untracked_close_reverses_opening_via_nudge(hass: HomeAssistant) -> None:
    """RYSE reverses through 1% when its stale 0% position would discard close."""
    source = SHADES["mbr1"]
    cover = ShadeCover("mbr1", source, tracked=False)
    cover.hass = hass
    cover.async_write_ha_state = MagicMock()
    manager = MagicMock()
    manager.is_automation_context.return_value = False
    hass.data[OVERRIDE_MANAGER_KEY] = manager
    hass.states.async_set(source, STATE_OPENING, {"current_position": 0, "friendly_name": source})

    service_call = AsyncMock()
    with patch.object(type(hass.services), "async_call", service_call):
        await cover.async_close_cover()

        service_call.assert_awaited_once_with(
            "cover",
            "set_cover_position",
            {"entity_id": source, "position": 1},
            blocking=False,
        )
        manager.expect_source_move.assert_called_with(source, 1)

        service_call.reset_mock()
        old_state = hass.states.get(source)
        new_state = State(source, "open", {"current_position": 1, "friendly_name": source})
        hass.states.async_set(source, new_state.state, new_state.attributes)
        await cover._source_changed(
            Event("state_changed", {"entity_id": source, "old_state": old_state, "new_state": new_state})
        )

        service_call.assert_awaited_once_with(
            "cover",
            "close_cover",
            {"entity_id": source},
            blocking=False,
        )
        manager.expect_source_move.assert_called_with(source, 0)

    cover._cancel_optimistic_timer()


async def test_duplicate_user_command_during_ryse_followup_sets_override() -> None:
    """Suppressing a duplicate hardware command must not suppress manual intent."""
    source = SHADES["mbr1"]
    cover = ShadeCover("mbr1", source, tracked=False)
    cover.hass = MagicMock()
    cover.hass.services.async_call = AsyncMock()
    cover._endpoint_followup = 0
    manager = MagicMock()
    manager.is_automation_context.return_value = False
    cover.hass.data = {OVERRIDE_MANAGER_KEY: manager}

    await cover.async_close_cover()

    manager.set_overridden.assert_called_once_with(cover.entity_id, True)
    cover.hass.services.async_call.assert_not_awaited()


async def test_manual_ryse_reversal_cancels_automatic_endpoint_followup() -> None:
    """A user reversal cannot later trigger the integration's stale close followup."""
    source = SHADES["mbr1"]
    cover = ShadeCover("mbr1", source, tracked=False)
    cover.hass = MagicMock()
    cover.async_write_ha_state = MagicMock()
    cover._endpoint_followup = 0
    manager = MagicMock()
    manager.source_move_is_expected.return_value = False
    cover.hass.data = {OVERRIDE_MANAGER_KEY: manager}
    old_state = State(source, "open", {"current_position": 100})
    new_state = State(source, STATE_OPENING, {"current_position": 100})

    await cover._source_changed(
        Event("state_changed", {"entity_id": source, "old_state": old_state, "new_state": new_state})
    )

    assert cover._endpoint_followup is None
    manager.set_overridden.assert_called_once_with(cover.entity_id, True)


async def test_manual_command_and_resume_service_toggle_override(hass: HomeAssistant) -> None:
    """A direct shade command persists an override until the clear service runs."""
    await _setup(hass)
    entity = abstract_entity("ko1")

    await hass.services.async_call("cover", "close_cover", {"entity_id": entity}, blocking=True)
    await hass.async_block_till_done()
    assert hass.states.get(entity).attributes["automation_override"] is True

    await hass.services.async_call(DOMAIN, "clear_override", {"entity_id": entity}, blocking=True)
    await hass.async_block_till_done()
    assert hass.states.get(entity).attributes["automation_override"] is False


async def test_resume_during_motion_does_not_immediately_recreate_override() -> None:
    """Clearing an override attributes the remainder of the current movement."""
    source = SHADES["ko1"]
    cover = ShadeCover("ko1", source, tracked=True)
    cover.hass = MagicMock()
    cover._live_moving = True
    cover._prev_live = 80
    cover._live = 60
    manager = MagicMock()
    cover.hass.data = {OVERRIDE_MANAGER_KEY: manager}

    await cover.async_clear_override()

    manager.expect_source_move.assert_called_once_with(source)
    manager.set_overridden.assert_called_once_with(cover.entity_id, False)


async def test_automatic_untracked_group_move_does_not_set_override(hass: HomeAssistant) -> None:
    """The automatic move context reaches the RYSE wrapper entity service."""
    await _setup(hass)
    entity = abstract_entity("mbr1")
    tracker = hass.data[TRACKER_KEY]
    tracker.has_gateway_id.side_effect = lambda source: source != SHADES["mbr1"]

    await hass.services.async_call(
        DOMAIN,
        "move_group",
        {"entity_id": entity, "position": 0, "respect_overrides": True},
        blocking=True,
    )
    await hass.async_block_till_done()

    assert hass.states.get(entity).attributes["automation_override"] is False

    source = SHADES["mbr1"]
    hass.states.async_set(source, STATE_CLOSING, {"current_position": 100, "friendly_name": source})
    await hass.async_block_till_done()
    assert hass.states.get(entity).attributes["automation_override"] is False

    hass.states.async_set(source, "open", {"current_position": 40, "friendly_name": source})
    await hass.async_block_till_done()
    assert hass.states.get(entity).attributes["automation_override"] is True


async def test_untracked_hardware_move_sets_override(hass: HomeAssistant) -> None:
    """A RYSE movement not issued by this integration is treated as manual."""
    await _setup(hass)
    source = SHADES["mbr1"]
    entity = abstract_entity("mbr1")

    hass.states.async_set(source, STATE_CLOSING, {"current_position": 100, "friendly_name": source})
    await hass.async_block_till_done()

    assert hass.states.get(entity).attributes["automation_override"] is True


async def test_untracked_unavailable_recovery_is_not_manual(hass: HomeAssistant) -> None:
    """A RYSE position change hidden by an outage starts a fresh baseline."""
    await _setup(hass)
    source = SHADES["mbr1"]
    entity = abstract_entity("mbr1")

    hass.states.async_set(source, "unavailable", {})
    await hass.async_block_till_done()
    hass.states.async_set(source, "closed", {"current_position": 0, "friendly_name": source})
    await hass.async_block_till_done()

    assert hass.states.get(entity).attributes["automation_override"] is False

    hass.states.async_set(source, STATE_OPENING, {"current_position": 0, "friendly_name": source})
    await hass.async_block_till_done()
    assert hass.states.get(entity).attributes["automation_override"] is True


async def test_untracked_optimistic_target_during_travel(hass: HomeAssistant) -> None:
    """Commanding the RYSE shade shows the TARGET while it travels.

    The device reports endpoint positions only — during travel its
    current_position sits at the start value, which used to snap the card's
    fabric back mid-move. The abstraction must sit on the commanded target
    until the device lands, then hand off to the real value.
    """
    await _setup(hass)
    source = SHADES["mbr1"]
    ent = abstract_entity("mbr1")

    await hass.services.async_call("cover", "set_cover_position", {"entity_id": ent, "position": 40}, blocking=True)
    await hass.async_block_till_done()
    # source still reports the stale start (100, "open") -> we show the target
    assert hass.states.get(ent).attributes["current_position"] == 40

    # device starts moving; position still stale -> keep showing the target
    hass.states.async_set(source, "closing", {"current_position": 100, "friendly_name": source})
    await hass.async_block_till_done()
    assert hass.states.get(ent).attributes["current_position"] == 40

    # device lands on (about) the target -> real value takes over
    hass.states.async_set(source, "open", {"current_position": 41, "friendly_name": source})
    await hass.async_block_till_done()
    assert hass.states.get(ent).attributes["current_position"] == 41


async def test_untracked_optimistic_clears_when_stopped_elsewhere(hass: HomeAssistant) -> None:
    """If the shade stops somewhere else (stop/supersede), reality wins."""
    await _setup(hass)
    source = SHADES["mbr1"]
    ent = abstract_entity("mbr1")

    await hass.services.async_call("cover", "set_cover_position", {"entity_id": ent, "position": 0}, blocking=True)
    await hass.async_block_till_done()
    assert hass.states.get(ent).attributes["current_position"] == 0

    # travels, then stops well short of the target (e.g. user hit stop)
    hass.states.async_set(source, "closing", {"current_position": 100, "friendly_name": source})
    await hass.async_block_till_done()
    hass.states.async_set(source, "open", {"current_position": 55, "friendly_name": source})
    await hass.async_block_till_done()
    assert hass.states.get(ent).attributes["current_position"] == 55
