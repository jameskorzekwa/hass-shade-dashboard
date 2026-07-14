"""Tests for the unified shade cover abstraction."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from homeassistant.const import STATE_CLOSING
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.shade_dashboard.const import (
    DOMAIN,
    LIVE_EVENT,
    SHADES,
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
    cover.hass.services.async_call = AsyncMock()
    cover._live = 50  # have a live reading, so no pre-command hold/state write

    await cover.async_close_cover()

    cover.hass.services.async_call.assert_awaited_once()
    domain, service, data = cover.hass.services.async_call.await_args.args[:3]
    assert domain == "cover"
    assert service == "close_cover"
    assert data["entity_id"] == source
