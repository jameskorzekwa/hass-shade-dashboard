"""Live shade-position sensors, fed by the gateway tracker.

The PowerView cover entities only ever report endpoint/optimistic positions —
they hold the commanded target during a move and never expose the real
intermediate position, and they can't be overridden externally. So to make the
live gateway position available HA-wide (for other dashboards, automations,
etc.) we publish a companion ``sensor.<shade>_live_position`` per tracked shade
that mirrors the gateway's live ``current_position`` (0 = closed .. 100 = open,
matching the cover convention). Each sensor listens for the tracker's
``shade_dashboard_live_position`` events and updates only when its own value
changes, so idle shades don't spam the recorder.
"""

from __future__ import annotations

from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import PERCENTAGE
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, LIVE_EVENT, _tracked_entities


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up a live-position sensor for every gateway-tracked shade."""
    async_add_entities(ShadeLivePositionSensor(source) for source in _tracked_entities())


class ShadeLivePositionSensor(SensorEntity):
    """Live gateway position (0-100, 100 = open) for one tracked shade."""

    _attr_should_poll = False
    _attr_native_unit_of_measurement = PERCENTAGE
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_icon = "mdi:blinds-horizontal"

    def __init__(self, source_entity: str) -> None:
        """Bind this sensor to a source ``cover.*`` entity."""
        self._source = source_entity
        object_id = source_entity.split(".", 1)[1]
        self.entity_id = f"sensor.{object_id}_live_position"
        self._attr_unique_id = f"{DOMAIN}_{object_id}_live_position"
        self._attr_name = None  # resolved from the source's friendly name on add
        self._attr_native_value = None
        self._moving = False

    async def async_added_to_hass(self) -> None:
        """Seed from the cover's current position, then follow live events."""
        st = self.hass.states.get(self._source)
        if st is not None:
            friendly = st.attributes.get("friendly_name")
            self._attr_name = f"{friendly} Live Position" if friendly else self.entity_id
            pos = st.attributes.get("current_position")
            if pos is not None:
                self._attr_native_value = int(pos)
        self.async_on_remove(self.hass.bus.async_listen(LIVE_EVENT, self._handle))

    @callback
    def _handle(self, event: Event) -> None:
        """Update from a live-position event, but only on an actual change."""
        positions = event.data.get("positions") or {}
        if self._source not in positions:
            return
        pos = positions[self._source]
        moving = self._source in (event.data.get("moving") or [])
        if pos == self._attr_native_value and moving == self._moving:
            return
        self._attr_native_value = pos
        self._moving = moving
        self.async_write_ha_state()

    @property
    def extra_state_attributes(self) -> dict:
        """Expose motion state and the source cover for automations."""
        return {"moving": self._moving, "source_entity": self._source}
