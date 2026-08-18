"""Tests for recalibrate + calibration-drift detection."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.shade_dashboard.const import (
    CALIBRATE_EVENT,
    CALIBRATE_HEX,
    OVERRIDE_MANAGER_KEY,
    TRACKER_KEY,
)
from custom_components.shade_dashboard.cover import ShadeCover
from custom_components.shade_dashboard.gateway import (
    CAL_CHECK_INTERVAL,
    CALIBRATE_LOCK,
    GatewayTracker,
)


def _tracker() -> GatewayTracker:
    with patch(
        "custom_components.shade_dashboard.gateway.async_get_clientsession",
        return_value=MagicMock(),
    ):
        return GatewayTracker(MagicMock(), host="gw")


def _mock_post(tracker: GatewayTracker, result: dict) -> MagicMock:
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json = AsyncMock(return_value=result)
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=resp)
    cm.__aexit__ = AsyncMock(return_value=False)
    post = MagicMock(return_value=cm)
    tracker._session = MagicMock(post=post)
    return post


async def test_recalibrate_posts_calibrate_frame() -> None:
    """async_recalibrate POSTs the calibrate frame to the shade's bleName."""
    t = _tracker()
    t._entity_to_ble = {"cover.living_room_hallway_shade_1_2": "DUE:A6C5"}
    post = _mock_post(t, {"err": 0, "responses": [{"err": 0}]})

    ok = await t.async_recalibrate("cover.living_room_hallway_shade_1_2")

    assert ok is True
    url = post.call_args.args[0]
    assert url == "http://gw/home/shades/exec?shades=DUE:A6C5"
    assert post.call_args.kwargs["json"] == {"hex": CALIBRATE_HEX}


async def test_recalibrate_unknown_entity() -> None:
    """No bleName mapping -> returns False, sends nothing."""
    t = _tracker()
    t._entity_to_ble = {}
    post = _mock_post(t, {"err": 0})
    assert await t.async_recalibrate("cover.nope") is False
    post.assert_not_called()


async def test_drift_detection_flags_and_recalibrates_the_outlier() -> None:
    """A shade that never opens while the fleet does is auto-recalibrated."""
    t = _tracker()
    # A fresh HA process has less uptime than the cooldown; no previous
    # recalibration must not be mistaken for one at monotonic timestamp zero.
    now = 3600.0
    fleet = {f"cover.s{i}": 100 for i in range(4)}  # opened fully
    fleet["cover.stuck"] = 4  # collapsed range
    t._reach = {e: [(now, v)] for e, v in fleet.items()}
    t._last_change = {e: now for e in fleet}  # all have moved recently

    t.async_recalibrate = AsyncMock(return_value=True)
    t.hass = MagicMock()
    t.hass.states.get.return_value = None  # kill switch absent -> auto on
    t.hass.services.async_call = AsyncMock()

    await t._maybe_check_calibration(now)

    t.async_recalibrate.assert_awaited_once_with("cover.stuck")
    fired = t.hass.bus.async_fire.call_args
    assert fired.args[0] == CALIBRATE_EVENT
    assert fired.args[1]["entity_id"] == "cover.stuck"


async def test_drift_detection_skips_when_fleet_not_opened() -> None:
    """If nothing has opened (can't judge), do not flag anything."""
    t = _tracker()
    now = 1_000_000.0
    t._reach = {f"cover.s{i}": [(now, 10)] for i in range(5)}  # nobody opened
    t._last_change = {f"cover.s{i}": now for i in range(5)}
    t.async_recalibrate = AsyncMock()
    t.hass = MagicMock()

    await t._maybe_check_calibration(now)
    t.async_recalibrate.assert_not_awaited()


async def test_drift_check_is_throttled() -> None:
    """The check only runs once per interval."""
    t = _tracker()
    t._last_cal_check = 5000.0
    t.async_recalibrate = AsyncMock()
    # a 'now' just after the last check -> should early-return before any work
    await t._maybe_check_calibration(5000.0 + CAL_CHECK_INTERVAL - 1)
    t.async_recalibrate.assert_not_awaited()


async def test_auto_recal_kill_switch_off_notifies_only() -> None:
    """With the kill switch off, drift notifies but does not move the shade."""
    t = _tracker()
    now = 1_000_000.0
    fleet = {f"cover.s{i}": 100 for i in range(4)}
    fleet["cover.stuck"] = 4
    t._reach = {e: [(now, v)] for e, v in fleet.items()}
    t._last_change = {e: now for e in fleet}
    t.async_recalibrate = AsyncMock()
    t.hass = MagicMock()
    off = MagicMock()
    off.state = "off"
    t.hass.states.get.return_value = off  # kill switch OFF
    t.hass.services.async_call = AsyncMock()

    await t._maybe_check_calibration(now)

    t.async_recalibrate.assert_not_awaited()  # did NOT move the shade
    t.hass.services.async_call.assert_awaited()  # but DID notify


async def test_recalibrate_locks_then_blocks_reentry() -> None:
    """A shade is locked mid-calibration and a second recalibrate is ignored."""
    t = _tracker()
    t._entity_to_ble = {"cover.x": "DUE:A6C5"}
    post = _mock_post(t, {"err": 0})
    t.hass = MagicMock()

    assert await t.async_recalibrate("cover.x") is True
    assert t.is_calibrating("cover.x") is True
    # a second call while locked does nothing (no extra POST)
    assert await t.async_recalibrate("cover.x") is False
    assert post.call_count == 1


def test_calibration_lock_covers_full_hardware_cycle() -> None:
    """The lock outlasts the observed three-minute calibration sequence."""
    t = _tracker()
    with patch(
        "custom_components.shade_dashboard.gateway.time.monotonic",
        side_effect=[0.0, 200.0, CALIBRATE_LOCK + 1],
    ):
        t._set_calibrating("cover.x", CALIBRATE_LOCK)
        assert t.is_calibrating("cover.x") is True
        assert t.is_calibrating("cover.x") is False


def test_calibration_expiry_refresh_is_event_loop_safe() -> None:
    """The delayed state refresh is marked as an event-loop callback."""
    cover = ShadeCover("ko1", "cover.kyle_s_office_shade_1", tracked=True)
    cover.hass = MagicMock()
    cover.async_write_ha_state = MagicMock()
    event = MagicMock()
    event.data = {"entity_id": "cover.kyle_s_office_shade_1", "seconds": CALIBRATE_LOCK}

    with patch("custom_components.shade_dashboard.cover.async_call_later") as call_later:
        cover._calibrating_event(event)

    refresh = call_later.call_args.args[2]
    assert getattr(refresh, "_hass_callback", False) is True
    refresh(None)
    assert cover.async_write_ha_state.call_count == 2


async def test_recalibrate_unlocks_on_gateway_rejection() -> None:
    """If the gateway rejects the frame, the shade is not left locked."""
    t = _tracker()
    t._entity_to_ble = {"cover.x": "DUE:A6C5"}
    _mock_post(t, {"err": 4, "errMsg": "nope"})
    t.hass = MagicMock()
    manager = MagicMock()
    t.hass.data = {OVERRIDE_MANAGER_KEY: manager}
    assert await t.async_recalibrate("cover.x") is False
    assert t.is_calibrating("cover.x") is False
    manager.cancel_source_move.assert_called_once_with("cover.x", None, kind="calibration")


async def test_start_restores_persisted_calibration_lock() -> None:
    """Restarting HA cannot unlock a calibration still moving the hardware."""
    t = _tracker()
    manager = MagicMock()
    manager.active_moves.return_value = [("cover.x", 200)]
    t.hass.data = {OVERRIDE_MANAGER_KEY: manager}
    t._build_map = AsyncMock()
    t.hass.loop.create_task = MagicMock()
    t._run = MagicMock(return_value=MagicMock())

    await t.start()

    assert t.is_calibrating("cover.x") is True
    manager.active_moves.assert_called_once_with("calibration")


async def test_cover_schedules_refresh_for_restored_calibration_lock() -> None:
    """A cover added after lock restoration still refreshes at expiry."""
    cover = ShadeCover("ko1", "cover.kyle_s_office_shade_1", tracked=True)
    tracker = MagicMock()
    tracker.calibration_remaining.return_value = 120
    cover.hass = MagicMock()
    cover.hass.data = {TRACKER_KEY: tracker}
    cover.async_on_remove = MagicMock()
    cover._schedule_calibration_refresh = MagicMock()

    with patch("custom_components.shade_dashboard.cover.async_track_state_change_event", return_value=MagicMock()):
        await cover.async_added_to_hass()

    cover._schedule_calibration_refresh.assert_called_once_with(120)


async def test_cover_blocks_commands_while_calibrating() -> None:
    """Open/close/set/stop are refused (routed nowhere) during calibration."""
    cover = ShadeCover("ko1", "cover.kyle_s_office_shade_1", tracked=True)
    tracker = MagicMock()
    tracker.is_calibrating.return_value = True
    cover.hass = MagicMock()
    cover.hass.data = {TRACKER_KEY: tracker}
    cover.hass.services.async_call = AsyncMock()
    cover._live = 50  # skip the pre-command hold path

    await cover.async_open_cover()
    await cover.async_close_cover()
    await cover.async_set_cover_position(position=30)
    await cover.async_stop_cover()

    cover.hass.services.async_call.assert_not_awaited()  # nothing routed to the real device
    assert cover.extra_state_attributes["calibrating"] is True

    # once the lock clears, a command goes through
    tracker.is_calibrating.return_value = False
    await cover.async_close_cover()
    cover.hass.services.async_call.assert_awaited()


@pytest.mark.parametrize("tracked", [True, False])
async def test_cover_recalibrate_service(tracked: bool) -> None:
    """The cover service delegates to the tracker only for PowerView shades."""
    cover = ShadeCover("ko1", "cover.kyle_s_office_shade_1", tracked=tracked)
    tracker = MagicMock()
    tracker.async_recalibrate = AsyncMock()
    cover.hass = MagicMock()
    cover.hass.data = {TRACKER_KEY: tracker}

    await cover.async_recalibrate()

    if tracked:
        tracker.async_recalibrate.assert_awaited_once_with("cover.kyle_s_office_shade_1")
    else:
        tracker.async_recalibrate.assert_not_awaited()
