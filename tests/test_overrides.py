"""Tests for persistent per-shade automation overrides."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from homeassistant.core import HomeAssistant

from custom_components.shade_dashboard.const import SHADES, abstract_entity
from custom_components.shade_dashboard.overrides import OverrideManager


async def test_override_survives_manager_reload(hass: HomeAssistant) -> None:
    """The persisted set is restored after an integration restart."""
    entity = abstract_entity("u1")
    manager = OverrideManager(hass)
    await manager.async_load()
    manager.set_overridden(entity, True)
    await manager._store.async_save(manager._data_to_save())

    restored = OverrideManager(hass)
    await restored.async_load()

    assert restored.is_overridden(entity)


async def test_expected_move_survives_manager_reload(hass: HomeAssistant) -> None:
    """An automatic move in progress remains attributed across an HA restart."""
    source = SHADES["u1"]
    manager = OverrideManager(hass)
    await manager.async_load()
    manager.expect_source_move(source, 0)
    await manager._store.async_save(manager._data_to_save())

    restored = OverrideManager(hass)
    await restored.async_load()

    assert restored.source_move_is_expected(source, previous=100, current=80)


async def test_expected_move_survives_sparse_position_updates(hass: HomeAssistant) -> None:
    """A gateway pause mid-travel does not turn the next update into manual motion."""
    manager = OverrideManager(hass)
    manager._schedule_save = MagicMock()
    source = "cover.source"
    with patch(
        "custom_components.shade_dashboard.overrides.time.monotonic",
        side_effect=[0, 1, 5, 6],
    ):
        manager.expect_source_move(source, 100)
        assert manager.source_move_is_expected(source, previous=0, current=20)
        # Four seconds with no update exceeded the old 2.5-second settle rule.
        assert manager.source_move_is_expected(source, previous=20, current=20)
        assert manager.source_move_is_expected(source, previous=20, current=60)


async def test_reversing_automatic_move_is_manual(hass: HomeAssistant) -> None:
    """Motion away from the commanded target clears attribution immediately."""
    manager = OverrideManager(hass)
    manager._schedule_save = MagicMock()
    source = "cover.source"
    manager.expect_source_move(source, 0)

    assert manager.source_move_is_expected(source, previous=100, current=60)
    assert not manager.source_move_is_expected(source, previous=60, current=70)


async def test_overlapping_automatic_reversal_keeps_both_directions_expected(hass: HomeAssistant) -> None:
    """Queued motion from an old target remains automatic while its replacement takes hold."""
    manager = OverrideManager(hass)
    manager._schedule_save = MagicMock()
    source = "cover.source"
    manager.expect_source_move(source, 0)
    assert manager.source_move_is_expected(source, previous=100, current=70)

    manager.expect_source_move(source, 100)

    assert manager.source_move_is_expected(source, previous=70, current=60)
    assert manager.source_move_is_expected(source, previous=60, current=65)


async def test_motion_away_from_all_automatic_targets_is_manual(hass: HomeAssistant) -> None:
    """Overlapping targets do not hide motion that heads away from every one."""
    manager = OverrideManager(hass)
    source = "cover.source"
    manager.expect_source_move(source, 0)
    manager.expect_source_move(source, 50)

    assert not manager.source_move_is_expected(source, previous=40, current=70)


async def test_stale_ryse_position_uses_reported_direction(hass: HomeAssistant) -> None:
    """RYSE opening state overrides an automatic close even while position stays stale."""
    manager = OverrideManager(hass)
    source = "cover.source"
    manager.expect_source_move(source, 0)

    assert not manager.source_move_is_expected(source, previous=100, current=100, direction=1)


async def test_ryse_settling_short_of_automatic_target_is_manual(hass: HomeAssistant) -> None:
    """A same-direction stop or retarget cannot remain attributed as automatic."""
    manager = OverrideManager(hass)
    source = "cover.source"
    manager.expect_source_move(source, 0)

    assert not manager.source_move_is_expected(source, previous=100, current=40, settled=True)


async def test_late_duplicate_transition_remains_automatic(hass: HomeAssistant) -> None:
    """A delayed endpoint replay stays attributed after the latest progress."""
    manager = OverrideManager(hass)
    manager._schedule_save = MagicMock()
    source = "cover.source"
    with patch(
        "custom_components.shade_dashboard.overrides.time.monotonic",
        side_effect=[0, 40, 45, 64, 76, 140],
    ):
        manager.expect_source_move(source, 0)
        assert manager.source_move_is_expected(source, previous=100, current=20)
        assert manager.source_move_is_expected(source, previous=20, current=0)
        assert manager.source_move_is_expected(source, previous=100, current=0)
        assert manager.source_move_is_expected(source, previous=0, current=0)
        assert not manager.source_move_is_expected(source, previous=0, current=0)


async def test_delayed_automatic_move_does_not_set_override_at_endpoint(hass: HomeAssistant) -> None:
    """Progress renews attribution when a queued gateway move outlasts its command window."""
    manager = OverrideManager(hass)
    manager._schedule_save = MagicMock()
    source = "cover.source"
    with patch(
        "custom_components.shade_dashboard.overrides.time.monotonic",
        side_effect=[0, 73, 83, 159],
    ):
        manager.expect_source_move(source, 0)
        assert manager.source_move_is_expected(source, previous=100, current=96)
        assert manager.source_move_is_expected(source, previous=96, current=0)
        assert not manager.source_move_is_expected(source, previous=0, current=0)
