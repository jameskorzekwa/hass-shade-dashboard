"""Tests for persistent per-shade automation overrides."""

from __future__ import annotations

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


async def test_expected_move_clears_as_soon_as_it_settles(hass: HomeAssistant) -> None:
    """A manual follow-up immediately after an automatic move is detectable."""
    manager = OverrideManager(hass)
    source = "cover.source"
    manager.expect_source_move(source)

    assert manager.source_move_is_expected(source, observed=True)
    manager.settle_source_move(source)

    assert not manager.source_move_is_expected(source)
