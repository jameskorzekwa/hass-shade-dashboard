"""Tests for the live-position companion sensors."""

from __future__ import annotations

from homeassistant.const import PERCENTAGE
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.shade_dashboard.const import (
    DOMAIN,
    LIVE_EVENT,
    _tracked_entities,
)


async def _setup(hass: HomeAssistant) -> None:
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def test_a_sensor_is_created_per_tracked_shade(hass: HomeAssistant) -> None:
    """Every gateway-tracked shade gets its own live-position sensor."""
    await _setup(hass)
    for source in _tracked_entities():
        object_id = source.split(".", 1)[1]
        assert hass.states.get(f"sensor.{object_id}_live_position") is not None
    # the untracked main-bedroom shade must NOT get one
    assert hass.states.get("sensor.main_bedroom_shades_live_position") is None


async def test_sensor_follows_live_events(hass: HomeAssistant) -> None:
    """A live-position event updates the matching sensor's state + attributes."""
    await _setup(hass)
    source = _tracked_entities()[0]
    entity_id = f"sensor.{source.split('.', 1)[1]}_live_position"

    hass.bus.async_fire(LIVE_EVENT, {"positions": {source: 42}, "moving": [source]})
    await hass.async_block_till_done()

    st = hass.states.get(entity_id)
    assert st.state == "42"
    assert st.attributes["moving"] is True
    assert st.attributes["source_entity"] == source
    assert st.attributes["unit_of_measurement"] == PERCENTAGE

    hass.bus.async_fire(LIVE_EVENT, {"positions": {source: 100}, "moving": []})
    await hass.async_block_till_done()
    st = hass.states.get(entity_id)
    assert st.state == "100"
    assert st.attributes["moving"] is False
