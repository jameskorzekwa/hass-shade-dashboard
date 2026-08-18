"""Tests for direct in-sync group moves (no PowerView scenes)."""

from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.core import Context, HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.shade_dashboard import _async_move_group
from custom_components.shade_dashboard.const import (
    DOMAIN,
    MOVE_FAILED_EVENT,
    OVERRIDE_MANAGER_KEY,
    SHADES,
    TRACKER_KEY,
    abstract_entity,
)
from custom_components.shade_dashboard.gateway import GatewayTracker, _shade_position


def _verify_tracker(available: bool = True) -> GatewayTracker:
    t = _tracker()
    t._entity_to_id = {"cover.a": 1, "cover.b": 2}
    t.hass = MagicMock()
    t.hass.data = {}
    t.hass.states.get.return_value = None if available else _unavail()
    t.hass.services.async_call = AsyncMock()
    t._put_positions = AsyncMock(return_value=True)
    return t


def _unavail():
    m = MagicMock()
    m.state = "unavailable"
    return m


def _tracker() -> GatewayTracker:
    with patch(
        "custom_components.shade_dashboard.gateway.async_get_clientsession",
        return_value=MagicMock(),
    ):
        return GatewayTracker(MagicMock(), host="gw")


def _mock_put(tracker: GatewayTracker) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=resp)
    cm.__aexit__ = AsyncMock(return_value=False)
    put = MagicMock(return_value=cm)
    tracker._session = MagicMock(put=put)
    return put


async def test_move_group_one_synced_positions_call() -> None:
    """A whole group goes out as a single positions?ids=<all> PUT."""
    t = _tracker()
    t._entity_to_id = {"cover.a": 1, "cover.b": 2, "cover.c": 3}
    put = _mock_put(t)

    ok = await t.async_move_group(["cover.a", "cover.b", "cover.c"], 1.0)

    assert ok is True
    assert put.call_args.args[0] == "http://gw/home/shades/positions?ids=1,2,3"
    assert put.call_args.kwargs["json"] == {"positions": {"primary": 1.0}}


async def test_move_group_skips_calibrating_members() -> None:
    """A member locked mid-calibration is left out of the synced move."""
    t = _tracker()
    t._entity_to_id = {"cover.a": 1, "cover.b": 2}
    t._calibrating = {"cover.a": time.monotonic() + 100}
    put = _mock_put(t)

    await t.async_move_group(["cover.a", "cover.b"], 0.0)

    assert put.call_args.args[0] == "http://gw/home/shades/positions?ids=2"


async def test_move_group_no_gateway_members_no_call() -> None:
    t = _tracker()
    t._entity_to_id = {}
    put = _mock_put(t)
    assert await t.async_move_group(["cover.x"], 1.0) is False
    put.assert_not_called()


async def test_fire_and_forget_rejection_cancels_attribution() -> None:
    """A definitive HTTP rejection cannot hide a later manual movement."""
    t = _tracker()
    t._entity_to_id = {"cover.a": 1}
    t._put_positions = AsyncMock(return_value=False)
    manager = MagicMock()
    t.hass.data = {OVERRIDE_MANAGER_KEY: manager}

    assert await t.async_move_group(["cover.a"], 0.0) is False

    manager.cancel_source_move.assert_called_once_with("cover.a", 0)


async def test_service_splits_tracked_and_untracked() -> None:
    """The service batches PowerView members and routes the RYSE shade to cover."""
    hass = MagicMock()
    tracker = MagicMock()
    tracker.async_move_group = AsyncMock()
    tracker.has_gateway_id = lambda src: src != SHADES["mbr1"]
    hass.data = {TRACKER_KEY: tracker}
    hass.services.async_call = AsyncMock()

    call = MagicMock()
    call.data = {
        "entity_id": [abstract_entity("ko1"), abstract_entity("mbr1")],
        "position": 100,
        "verify": False,
    }
    await _async_move_group(hass, call)

    # tracked office shade -> one synced gateway move at primary 1.0
    tracker.async_move_group.assert_awaited_once()
    sources, primary = tracker.async_move_group.await_args.args
    assert sources == [SHADES["ko1"]]
    assert primary == 1.0
    # untracked main bedroom -> its own cover
    hass.services.async_call.assert_awaited_once()
    dom, svc, data = hass.services.async_call.await_args.args[:3]
    assert (dom, svc) == ("cover", "set_cover_position")
    assert data == {"entity_id": abstract_entity("mbr1"), "position": 100}


async def test_service_dispatches_untracked_before_verified_wait() -> None:
    """The RYSE shade starts immediately while PowerView verification runs."""
    hass = MagicMock()
    tracker = MagicMock()
    tracker.has_gateway_id = lambda src: src != SHADES["mbr1"]
    verification_started = asyncio.Event()
    finish_verification = asyncio.Event()

    async def verify(*_args) -> None:
        verification_started.set()
        await finish_verification.wait()

    tracker.async_move_group_verified = AsyncMock(side_effect=verify)
    hass.data = {TRACKER_KEY: tracker}
    hass.services.async_call = AsyncMock()
    call = MagicMock()
    call.data = {
        "entity_id": [abstract_entity("ko1"), abstract_entity("mbr1")],
        "position": 100,
        "verify": True,
    }

    task = asyncio.create_task(_async_move_group(hass, call))
    try:
        await asyncio.wait_for(verification_started.wait(), timeout=1)
        hass.services.async_call.assert_awaited_once()
    finally:
        finish_verification.set()
        await task


async def test_move_group_service_is_awaited_end_to_end(hass: HomeAssistant) -> None:
    """Calling the service via HA's dispatch actually runs it (regression: a
    lambda handler returned an un-awaited coroutine -> silent no-op)."""
    hass.states.async_set(SHADES["ko1"], "open", {"current_position": 100})
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    tracker = hass.data[TRACKER_KEY]
    tracker.has_gateway_id = lambda src: True
    tracker.async_move_group = AsyncMock()
    tracker.async_move_group_verified = AsyncMock()

    await hass.services.async_call(
        "shade_dashboard",
        "move_group",
        {"entity_id": [abstract_entity("ko1")], "position": 100},
        blocking=True,
    )

    tracker.async_move_group_verified.assert_awaited_once()
    tracker.async_move_group.assert_not_awaited()
    sources, primary = tracker.async_move_group_verified.await_args.args
    assert sources == [SHADES["ko1"]]
    assert primary == 1.0


async def test_verified_move_success_no_notify() -> None:
    """All shades within tolerance of target -> no retry, no notification."""
    t = _verify_tracker()
    t._wait_settled = AsyncMock(return_value={1: 100, 2: 98})  # both ~open (target 100)
    failed = await t.async_move_group_verified(["cover.a", "cover.b"], 1.0)
    assert failed == []
    assert t._put_positions.await_count == 1  # no retry
    t.hass.services.async_call.assert_not_awaited()  # no notification


async def test_verified_move_straggler_recovers_on_retry() -> None:
    """A shade that missed the first move but arrives on the retry -> success."""
    t = _verify_tracker()
    t._wait_settled = AsyncMock(side_effect=[{1: 100, 2: 40}, {1: 100, 2: 99}])
    failed = await t.async_move_group_verified(["cover.a", "cover.b"], 1.0)
    assert failed == []
    assert t._put_positions.await_count == 2  # initial + retry
    assert t._put_positions.await_args_list[1].args[0] == [2]  # retry only re-drives the straggler
    t.hass.services.async_call.assert_not_awaited()


async def test_new_command_cancels_stale_verified_retry() -> None:
    """An older verifier cannot retry over a newer opposite command."""
    t = _verify_tracker()
    t._entity_to_id = {"cover.a": 1}
    t.hass.data = {}
    waiting = asyncio.Event()
    release = asyncio.Event()

    async def wait_settled(_ids, _target):
        waiting.set()
        await release.wait()
        return {1: 40}

    t._wait_settled = AsyncMock(side_effect=wait_settled)
    old_move = asyncio.create_task(t.async_move_group_verified(["cover.a"], 0.0))
    await asyncio.wait_for(waiting.wait(), timeout=1)

    await t.async_move_group(["cover.a"], 1.0)
    release.set()

    assert await old_move == []
    assert [call.args[1] for call in t._put_positions.await_args_list] == [0.0, 1.0]
    t.hass.services.async_call.assert_not_awaited()


async def test_verified_move_persistent_failure_notifies() -> None:
    """A shade that never arrives (even after retry) -> event + notification."""
    t = _verify_tracker()
    t._wait_settled = AsyncMock(side_effect=[{1: 100, 2: 40}, {1: 100, 2: 40}])
    failed = await t.async_move_group_verified(["cover.a", "cover.b"], 1.0)
    assert failed == ["cover.b"]
    assert t._put_positions.await_count == 2
    assert t.hass.bus.async_fire.call_args.args[0] == MOVE_FAILED_EVENT
    assert t.hass.bus.async_fire.call_args.args[1]["entities"] == ["cover.b"]
    t.hass.services.async_call.assert_awaited()  # persistent_notification


async def test_unconfirmed_put_failure_never_recalibrates() -> None:
    """A communication failure is not evidence that healthy shade limits drifted."""
    t = _verify_tracker()
    t._entity_to_id = {"cover.a": 1}
    t._put_positions = AsyncMock(return_value=None)
    t._wait_settled = AsyncMock(side_effect=[{1: 40}, {1: 40}])
    t.async_recalibrate = AsyncMock(return_value=True)
    manager = MagicMock()
    manager.is_source_overridden.return_value = False
    t.hass.data = {OVERRIDE_MANAGER_KEY: manager}

    assert await t.async_move_group_verified(["cover.a"], 1.0) == ["cover.a"]

    t.async_recalibrate.assert_not_awaited()
    assert manager.cancel_source_move.call_count >= 1
    message = t.hass.services.async_call.await_args.args[2]["message"]
    assert "did not confirm either command" in message


async def test_member_becoming_unavailable_is_not_retried_or_failed() -> None:
    """An outage during verification removes that shade from the operation."""
    t = _verify_tracker()
    t._entity_to_id = {"cover.a": 1}
    source_state = MagicMock(state="open")
    t.hass.states.get.return_value = source_state

    async def become_unavailable(_ids, _target):
        source_state.state = "unavailable"
        return {}

    t._wait_settled = AsyncMock(side_effect=become_unavailable)

    assert await t.async_move_group_verified(["cover.a"], 0.0) == []
    assert t._put_positions.await_count == 1
    t.hass.services.async_call.assert_not_awaited()


async def test_verification_read_recovers_from_transient_error() -> None:
    """One failed GET does not abort verification after a command was issued."""
    t = _tracker()
    t._read_positions = AsyncMock(side_effect=[RuntimeError("temporary"), {1: 100}])
    with (
        patch("custom_components.shade_dashboard.gateway.asyncio.sleep", new=AsyncMock()),
        patch("custom_components.shade_dashboard.gateway.time.monotonic", side_effect=[0, 1, 2, 7]),
    ):
        assert await t._wait_settled([1], 100) == {1: 100}


async def test_single_verified_failure_starts_recalibration() -> None:
    """One endpoint failure after retry starts a rate-limited recalibration."""
    t = _verify_tracker()
    t._entity_to_id = {"cover.a": 1}
    t._wait_settled = AsyncMock(side_effect=[{1: 40}, {1: 40}])
    t.async_recalibrate = AsyncMock(return_value=True)

    with patch("custom_components.shade_dashboard.gateway.time.monotonic", return_value=3600.0):
        failed = await t.async_move_group_verified(["cover.a"], 1.0)

    assert failed == ["cover.a"]
    t.async_recalibrate.assert_awaited_once_with("cover.a")
    message = t.hass.services.async_call.await_args.args[2]["message"]
    assert "Automatic recalibration was started" in message


async def test_failed_move_recalibration_honors_cooldown() -> None:
    """Repeated failures cannot recalibrate the same shade inside the cooldown."""
    t = _verify_tracker()
    t._entity_to_id = {"cover.a": 1}
    t._last_recal = {"cover.a": 3500.0}
    t._wait_settled = AsyncMock(side_effect=[{1: 40}, {1: 40}])
    t.async_recalibrate = AsyncMock(return_value=True)

    with patch("custom_components.shade_dashboard.gateway.time.monotonic", return_value=3600.0):
        await t.async_move_group_verified(["cover.a"], 1.0)

    t.async_recalibrate.assert_not_awaited()
    message = t.hass.services.async_call.await_args.args[2]["message"]
    assert "recalibrated recently" in message


async def test_multiple_verified_failures_do_not_recalibrate() -> None:
    """A likely gateway-wide failure never starts multiple calibrations."""
    t = _verify_tracker()
    t._wait_settled = AsyncMock(side_effect=[{1: 40, 2: 40}, {1: 40, 2: 40}])
    t.async_recalibrate = AsyncMock(return_value=True)

    await t.async_move_group_verified(["cover.a", "cover.b"], 1.0)

    t.async_recalibrate.assert_not_awaited()
    message = t.hass.services.async_call.await_args.args[2]["message"]
    assert "Multiple shades failed together" in message


async def test_verified_move_skips_unavailable_members() -> None:
    """An unavailable (offline) shade is left out of the move entirely."""
    t = _tracker()
    t._entity_to_id = {"cover.a": 1, "cover.b": 2}
    t.hass = MagicMock()
    t.hass.data = {}
    t.hass.states.get.side_effect = lambda e: _unavail() if e == "cover.a" else None
    t.hass.services.async_call = AsyncMock()
    t._put_positions = AsyncMock(return_value=True)
    t._wait_settled = AsyncMock(return_value={2: 100})
    await t.async_move_group_verified(["cover.a", "cover.b"], 1.0)
    assert t._put_positions.await_args.args[0] == [2]  # only the available shade


async def test_move_group_service_verify_routes_to_verified() -> None:
    """The service's verify flag calls the verified path."""
    hass = MagicMock()
    tracker = MagicMock()
    tracker.has_gateway_id = lambda src: True
    tracker.async_move_group = AsyncMock()
    tracker.async_move_group_verified = AsyncMock()
    hass.data = {TRACKER_KEY: tracker}
    hass.services.async_call = AsyncMock()
    call = MagicMock()
    call.data = {"entity_id": [abstract_entity("ko1")], "position": 0, "verify": True}
    await _async_move_group(hass, call)
    tracker.async_move_group_verified.assert_awaited_once()
    tracker.async_move_group.assert_not_awaited()


async def test_automatic_move_skips_overridden_shade() -> None:
    """Automation mode filters overridden members before issuing the group move."""
    hass = MagicMock()
    tracker = MagicMock()
    tracker.has_gateway_id.return_value = True
    tracker.async_move_group_verified = AsyncMock()
    overrides = MagicMock()
    overrides.is_overridden.side_effect = lambda entity: entity == abstract_entity("ko1")
    hass.data = {TRACKER_KEY: tracker, OVERRIDE_MANAGER_KEY: overrides}
    call = MagicMock()
    call.context = Context()
    call.data = {
        "entity_id": [abstract_entity("ko1"), abstract_entity("ko2")],
        "position": 0,
        "verify": True,
        "respect_overrides": True,
    }

    await _async_move_group(hass, call)

    sources = tracker.async_move_group_verified.await_args.args[0]
    assert sources == [SHADES["ko2"]]
    overrides.mark_automation_context.assert_called_once_with(call.context)
    overrides.set_overridden.assert_not_called()


async def test_manual_group_move_sets_each_override() -> None:
    """Dashboard group controls count as manual moves for every member."""
    hass = MagicMock()
    tracker = MagicMock()
    tracker.has_gateway_id.return_value = True
    tracker.async_move_group = AsyncMock()
    tracker.async_move_group_verified = AsyncMock()
    overrides = MagicMock()
    hass.data = {TRACKER_KEY: tracker, OVERRIDE_MANAGER_KEY: overrides}
    call = MagicMock()
    call.context = Context()
    entities = [abstract_entity("ko1"), abstract_entity("ko2")]
    call.data = {"entity_id": entities, "position": 100}

    await _async_move_group(hass, call)

    assert [item.args for item in overrides.set_overridden.call_args_list] == [
        (abstract_entity("ko1"), True),
        (abstract_entity("ko2"), True),
    ]


async def test_manual_group_move_skips_unavailable_member() -> None:
    """A shade that cannot receive a dashboard command is not overridden."""
    hass = MagicMock()
    tracker = MagicMock()
    tracker.has_gateway_id.return_value = True
    tracker.async_move_group_verified = AsyncMock()
    overrides = MagicMock()
    unavailable = abstract_entity("ko1")
    available = abstract_entity("ko2")
    hass.states.get.side_effect = lambda entity: MagicMock(state="unavailable" if entity == unavailable else "open")
    hass.data = {TRACKER_KEY: tracker, OVERRIDE_MANAGER_KEY: overrides}
    call = MagicMock()
    call.context = Context()
    call.data = {"entity_id": [unavailable, available], "position": 100}

    await _async_move_group(hass, call)

    overrides.set_overridden.assert_called_once_with(available, True)
    assert tracker.async_move_group_verified.await_args.args[0] == [SHADES["ko2"]]


async def test_manual_group_move_skips_calibrating_member() -> None:
    """A locked shade is neither commanded nor overridden by a group action."""
    hass = MagicMock()
    tracker = MagicMock()
    tracker.has_gateway_id.return_value = True
    tracker.is_calibrating.side_effect = lambda source: source == SHADES["ko1"]
    tracker.async_move_group_verified = AsyncMock()
    overrides = MagicMock()
    hass.states.get.return_value = MagicMock(state="open")
    hass.data = {TRACKER_KEY: tracker, OVERRIDE_MANAGER_KEY: overrides}
    call = MagicMock()
    call.context = Context()
    call.data = {"entity_id": [abstract_entity("ko1"), abstract_entity("ko2")], "position": 100}

    await _async_move_group(hass, call)

    overrides.set_overridden.assert_called_once_with(abstract_entity("ko2"), True)
    assert tracker.async_move_group_verified.await_args.args[0] == [SHADES["ko2"]]


async def test_gateway_hardware_move_sets_override() -> None:
    """A PowerView position change with no expected command is manual."""
    tracker = _tracker()
    tracker._id_to_entity = {1: "cover.a"}
    tracker._prev_pos = {"cover.a": 100}
    tracker._get = AsyncMock(return_value=[{"id": 1, "positions": {"primary": 0.8}}])
    tracker._maybe_check_calibration = AsyncMock()
    overrides = MagicMock()
    overrides.source_move_is_expected.return_value = False
    tracker.hass.data = {OVERRIDE_MANAGER_KEY: overrides}

    await tracker._poll_once()

    overrides.set_source_overridden.assert_not_called()
    assert tracker._command_generation["cover.a"] == 1

    tracker._get.return_value = [{"id": 1, "positions": {"primary": 0.6}}]
    await tracker._poll_once()

    overrides.set_source_overridden.assert_called_once_with("cover.a")


async def test_gateway_poll_error_discards_stale_override_baseline() -> None:
    """The first position after a gateway outage cannot create an override."""
    tracker = _tracker()
    tracker._id_to_entity = {1: "cover.a"}
    tracker._prev_pos = {"cover.a": 100}
    tracker._manual_candidates = {"cover.a": (100, 80)}

    async def fail_poll() -> None:
        tracker._stop.set()
        raise RuntimeError("gateway unavailable")

    tracker._poll_once = fail_poll
    await tracker._run()
    assert tracker._prev_pos == {}
    assert tracker._manual_candidates == {}

    tracker._get = AsyncMock(return_value=[{"id": 1, "positions": {"primary": 0.0}}])
    tracker._maybe_check_calibration = AsyncMock()
    overrides = MagicMock()
    overrides.source_move_is_expected.return_value = False
    tracker.hass.data = {OVERRIDE_MANAGER_KEY: overrides}

    await GatewayTracker._poll_once(tracker)

    overrides.set_source_overridden.assert_not_called()


async def test_gateway_unavailable_source_discards_reconnect_positions() -> None:
    """Zeroed reconnect data cannot override an open shade after an outage."""
    tracker = _tracker()
    tracker._id_to_entity = {1: "cover.a"}
    tracker._prev_pos = {"cover.a": 100}
    tracker._get = AsyncMock(return_value=[{"id": 1, "positions": {"primary": 0.0}}])
    tracker._maybe_check_calibration = AsyncMock()
    source_state = MagicMock(state="unavailable")
    tracker.hass.states.get.return_value = source_state
    overrides = MagicMock()
    overrides.source_move_is_expected.return_value = False
    tracker.hass.data = {OVERRIDE_MANAGER_KEY: overrides}

    await tracker._poll_once()

    assert tracker._prev_pos == {}
    overrides.set_source_overridden.assert_not_called()

    source_state.state = "open"
    tracker._get.return_value = [{"id": 1, "positions": {"primary": 1.0}}]
    await tracker._poll_once()

    assert tracker._prev_pos == {"cover.a": 100}
    overrides.set_source_overridden.assert_not_called()


async def test_gateway_zero_spike_before_unavailable_never_overrides() -> None:
    """A reconnect spike cannot win a race with the source unavailable state."""
    tracker = _tracker()
    tracker._id_to_entity = {1: "cover.a"}
    tracker._prev_pos = {"cover.a": 100}
    tracker._get = AsyncMock(return_value=[{"id": 1, "positions": {"primary": 0.0}}])
    tracker._maybe_check_calibration = AsyncMock()
    source_state = MagicMock(state="open")
    tracker.hass.states.get.return_value = source_state
    overrides = MagicMock()
    overrides.source_move_is_expected.return_value = False
    tracker.hass.data = {OVERRIDE_MANAGER_KEY: overrides}

    await tracker._poll_once()
    overrides.set_source_overridden.assert_not_called()

    source_state.state = "unavailable"
    await tracker._poll_once()
    assert tracker._manual_candidates == {}

    source_state.state = "open"
    tracker._get.return_value = [{"id": 1, "positions": {"primary": 1.0}}]
    await tracker._poll_once()

    assert tracker._prev_pos == {"cover.a": 100}
    overrides.set_source_overridden.assert_not_called()


async def test_partial_snapshot_only_overrides_confirmed_mover() -> None:
    """A missing member gets a baseline while another real movement is confirmed."""
    tracker = _tracker()
    tracker._id_to_entity = {1: "cover.a", 2: "cover.b"}
    tracker._prev_pos = {"cover.a": 100, "cover.b": 100}
    tracker._get = AsyncMock(return_value=[{"id": 1, "positions": {"primary": 0.8}}])
    tracker._maybe_check_calibration = AsyncMock()
    tracker.hass.states.get.return_value = MagicMock(state="open")
    overrides = MagicMock()
    overrides.source_move_is_expected.return_value = False
    tracker.hass.data = {OVERRIDE_MANAGER_KEY: overrides}

    await tracker._poll_once()

    tracker._get.return_value = [
        {"id": 1, "positions": {"primary": 0.6}},
        {"id": 2, "positions": {"primary": 1.0}},
    ]
    await tracker._poll_once()

    overrides.set_source_overridden.assert_called_once_with("cover.a")
    assert tracker._prev_pos == {"cover.a": 60, "cover.b": 100}


async def test_automatic_command_cancels_unconfirmed_manual_candidate() -> None:
    """A command arriving between two polls takes ownership of the movement."""
    tracker = _tracker()
    tracker._id_to_entity = {1: "cover.a"}
    tracker._prev_pos = {"cover.a": 100}
    tracker._get = AsyncMock(return_value=[{"id": 1, "positions": {"primary": 0.8}}])
    tracker._maybe_check_calibration = AsyncMock()
    tracker.hass.states.get.return_value = MagicMock(state="open")
    overrides = MagicMock()
    overrides.source_move_is_expected.side_effect = [False, True]
    tracker.hass.data = {OVERRIDE_MANAGER_KEY: overrides}

    await tracker._poll_once()
    tracker._get.return_value = [{"id": 1, "positions": {"primary": 0.6}}]
    await tracker._poll_once()

    assert tracker._manual_candidates == {}
    overrides.set_source_overridden.assert_not_called()


async def test_gateway_missing_position_discards_stale_baseline() -> None:
    """An incomplete successful response is an outage, not a move to zero."""
    tracker = _tracker()
    tracker._id_to_entity = {1: "cover.a"}
    tracker._prev_pos = {"cover.a": 100}
    tracker._get = AsyncMock(return_value=[{"id": 1, "positions": {}}])
    tracker._maybe_check_calibration = AsyncMock()
    tracker.hass.states.get.return_value = None
    overrides = MagicMock()
    overrides.source_move_is_expected.return_value = False
    tracker.hass.data = {OVERRIDE_MANAGER_KEY: overrides}

    await tracker._poll_once()

    assert tracker._prev_pos == {}
    overrides.set_source_overridden.assert_not_called()


def test_gateway_rejects_malformed_positions() -> None:
    """Boolean, nonnumeric, and out-of-range readings cannot become positions."""
    for primary in (None, True, False, "0.5", -0.01, 1.01):
        assert _shade_position({"positions": {"primary": primary}}) is None
    assert _shade_position({"positions": {"primary": 0.0}}) == 0
    assert _shade_position({"positions": {"primary": 1.0}}) == 100


async def test_verification_ignores_unavailable_source_position() -> None:
    """Reconnect data cannot make a verified move look successful."""
    tracker = _tracker()
    tracker._id_to_entity = {1: "cover.a"}
    tracker._get = AsyncMock(return_value=[{"id": 1, "positions": {"primary": 0.0}}])
    tracker.hass.states.get.return_value = MagicMock(state="unavailable")

    assert await tracker._read_positions([1]) == {}


def test_group_entities_resolution() -> None:
    from custom_components.shade_dashboard.const import abstract_entity, group_entities

    west = group_entities("west_glare")
    # LR west (u4-7, l3-6) + office (ko1-2) + upstairs hallway (uh1-3) = 13
    assert len(west) == 13
    for slot in ["u4", "u7", "l3", "l6", "ko1", "ko2", "uh1", "uh3"]:
        assert abstract_entity(slot) in west
    # all_no_bedroom = everything except the RYSE main bedroom
    allnb = group_entities("all_no_bedroom")
    assert abstract_entity("mbr1") not in allnb
    assert len(allnb) == 21
    assert group_entities("south_glare") == group_entities("south")
    assert group_entities("nope") is None


async def test_move_group_service_accepts_group(hass: HomeAssistant) -> None:
    """A named group resolves to its covers through HA's dispatch."""
    from custom_components.shade_dashboard.const import SHADES

    for slot in ("u1", "u2", "u3", "l1", "l2"):
        hass.states.async_set(SHADES[slot], "open", {"current_position": 100})
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    tracker = hass.data[TRACKER_KEY]
    tracker.has_gateway_id = lambda src: True
    tracker.async_move_group_verified = AsyncMock()

    await hass.services.async_call(
        "shade_dashboard", "move_group", {"group": "south_glare", "position": 0, "verify": True}, blocking=True
    )
    tracker.async_move_group_verified.assert_awaited_once()
    sources = tracker.async_move_group_verified.await_args.args[0]
    assert set(sources) == {SHADES[s] for s in ("u1", "u2", "u3", "l1", "l2")}
