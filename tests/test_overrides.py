"""Tests for persistent per-shade automation overrides."""

from __future__ import annotations

from unittest.mock import patch

from homeassistant.core import HomeAssistant

from custom_components.shade_dashboard.const import abstract_entity
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


async def test_expected_move_survives_sparse_position_updates(hass: HomeAssistant) -> None:
    """A gateway pause mid-travel does not turn the next update into manual motion."""
    manager = OverrideManager(hass)
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
    source = "cover.source"
    manager.expect_source_move(source, 0)

    assert manager.source_move_is_expected(source, previous=100, current=60)
    assert not manager.source_move_is_expected(source, previous=60, current=70)


async def test_late_duplicate_transition_remains_automatic(hass: HomeAssistant) -> None:
    """A delayed endpoint replay stays attributed after the latest progress."""
    manager = OverrideManager(hass)
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
    source = "cover.source"
    with patch(
        "custom_components.shade_dashboard.overrides.time.monotonic",
        side_effect=[0, 73, 83, 159],
    ):
        manager.expect_source_move(source, 0)
        assert manager.source_move_is_expected(source, previous=100, current=96)
        assert manager.source_move_is_expected(source, previous=96, current=0)
        assert not manager.source_move_is_expected(source, previous=0, current=0)
