"""Tests for direct in-sync group moves (no PowerView scenes)."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.shade_dashboard import _async_move_group
from custom_components.shade_dashboard.const import (
    DOMAIN,
    MOVE_FAILED_EVENT,
    SHADES,
    TRACKER_KEY,
    abstract_entity,
)
from custom_components.shade_dashboard.gateway import GatewayTracker


def _verify_tracker(available: bool = True) -> GatewayTracker:
    t = _tracker()
    t._entity_to_id = {"cover.a": 1, "cover.b": 2}
    t.hass = MagicMock()
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


async def test_service_splits_tracked_and_untracked() -> None:
    """The service batches PowerView members and routes the RYSE shade to cover."""
    hass = MagicMock()
    tracker = MagicMock()
    tracker.async_move_group = AsyncMock()
    tracker.has_gateway_id = lambda src: src != SHADES["mbr1"]
    hass.data = {TRACKER_KEY: tracker}
    hass.services.async_call = AsyncMock()

    call = MagicMock()
    call.data = {"entity_id": [abstract_entity("ko1"), abstract_entity("mbr1")], "position": 100}
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


async def test_move_group_service_is_awaited_end_to_end(hass: HomeAssistant) -> None:
    """Calling the service via HA's dispatch actually runs it (regression: a
    lambda handler returned an un-awaited coroutine -> silent no-op)."""
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    tracker = hass.data[TRACKER_KEY]
    tracker.has_gateway_id = lambda src: True
    tracker.async_move_group = AsyncMock()

    await hass.services.async_call(
        "shade_dashboard",
        "move_group",
        {"entity_id": [abstract_entity("ko1")], "position": 100},
        blocking=True,
    )

    tracker.async_move_group.assert_awaited_once()
    sources, primary = tracker.async_move_group.await_args.args
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


async def test_verified_move_skips_unavailable_members() -> None:
    """An unavailable (offline) shade is left out of the move entirely."""
    t = _tracker()
    t._entity_to_id = {"cover.a": 1, "cover.b": 2}
    t.hass = MagicMock()
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
