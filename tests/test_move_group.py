"""Tests for direct in-sync group moves (no PowerView scenes)."""

from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

from custom_components.shade_dashboard import _async_move_group
from custom_components.shade_dashboard.const import SHADES, TRACKER_KEY, abstract_entity
from custom_components.shade_dashboard.gateway import GatewayTracker


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
