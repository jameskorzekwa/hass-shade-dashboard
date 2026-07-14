"""Unified shade covers — one integration-owned cover per shade.

Each real shade lives behind a different integration with different capabilities
(Hunter Douglas PowerView via a local gateway; a RYSE shade via HomeKit). This
platform exposes a single ``cover.shade_<slot>`` per shade that:

* reports the best available **live** position — the G3 gateway's live feed for
  PowerView shades (smooth intermediate positions the powerview cover never
  surfaces, and which never jump to the optimistic target), or the source
  cover's own position for others (RYSE only reports endpoints + an
  opening/closing flag) — and
* forwards open/close/set_position/stop to the real cover behind it.

The dashboard card talks only to these, so it doesn't care what hardware backs a
shade; adding a new brand is a new adapter here, not a card change. Positions use
the standard cover convention (0 = closed, 100 = open); the card converts to the
closed-% it displays.
"""

from __future__ import annotations

from homeassistant.components.cover import (
    ATTR_POSITION,
    CoverDeviceClass,
    CoverEntity,
    CoverEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    SERVICE_CLOSE_COVER,
    SERVICE_OPEN_COVER,
    SERVICE_SET_COVER_POSITION,
    SERVICE_STOP_COVER,
    STATE_CLOSING,
    STATE_OPENING,
    STATE_UNAVAILABLE,
    STATE_UNKNOWN,
)
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_track_state_change_event

from .const import DOMAIN, LIVE_EVENT, SHADES, _tracked_entities

# Gateway calibration: a fully-closed shade reads ~2-3 and fully-open ~97-98, so
# snap those to clean 0/100 at rest (matches the card's old _clampLive).
CLAMP_LOW = 3
CLAMP_HIGH = 97
# A shade counts as having really moved (vs a startup position blip) once its
# live position travels this far from where a command captured it.
TRAVEL_EPS = 3


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create one unified cover per shade."""
    tracked = set(_tracked_entities())
    async_add_entities(ShadeCover(slot, source, source in tracked) for slot, source in SHADES.items())


class ShadeCover(CoverEntity):
    """A unified shade cover that fronts one real device."""

    _attr_should_poll = False
    _attr_device_class = CoverDeviceClass.SHADE
    # The interface we implement; the actual set is narrowed to what the real
    # device supports in async_added_to_hass (RYSE has no STOP, for example).
    _SUPPORTED = (
        CoverEntityFeature.OPEN | CoverEntityFeature.CLOSE | CoverEntityFeature.SET_POSITION | CoverEntityFeature.STOP
    )
    _attr_supported_features = _SUPPORTED

    def __init__(self, slot: str, source: str, tracked: bool) -> None:
        """Bind this cover to a slot + its real source cover entity."""
        self._slot = slot
        self._source = source
        self._tracked = tracked
        self.entity_id = f"cover.shade_{slot}"
        self._attr_unique_id = f"{DOMAIN}_shade_{slot}"
        self._attr_name = None  # resolved from the source's friendly name on add
        # Live-tracking state (PowerView shades only).
        self._live: int | None = None
        self._prev_live: int | None = None
        self._live_moving = False
        self._hold: int | None = None  # pre-command hold until the gateway confirms motion

    async def async_added_to_hass(self) -> None:
        """Resolve the name, then follow the source cover + live events."""
        st = self.hass.states.get(self._source)
        if st is not None:
            friendly = st.attributes.get("friendly_name")
            self._attr_name = friendly if friendly else self.entity_id
            # Advertise only what the real device actually supports, masked to
            # the features this abstraction implements.
            src_features = st.attributes.get("supported_features")
            if src_features is not None:
                self._attr_supported_features = self._SUPPORTED & CoverEntityFeature(int(src_features))
        self.async_on_remove(async_track_state_change_event(self.hass, [self._source], self._source_changed))
        if self._tracked:
            self.async_on_remove(self.hass.bus.async_listen(LIVE_EVENT, self._live_event))

    # --- following the underlying device -------------------------------------
    @callback
    def _source_changed(self, event: Event) -> None:
        """The real cover changed (availability, and position for untracked)."""
        self.async_write_ha_state()

    @callback
    def _live_event(self, event: Event) -> None:
        """Absorb a gateway live-position event for this shade."""
        positions = event.data.get("positions") or {}
        if self._source not in positions:
            return
        pos = positions[self._source]
        moving = self._source in (event.data.get("moving") or [])
        if pos == self._live and moving == self._live_moving:
            return
        if pos != self._live and self._live is not None:
            self._prev_live = self._live
        self._live = pos
        # Once the shade has really travelled from the captured hold, stop holding.
        if self._hold is not None and abs(self._live - self._hold) > TRAVEL_EPS:
            self._hold = None
        self._live_moving = moving
        self.async_write_ha_state()

    def _source_position(self) -> int | None:
        """Current position of the real cover (None if unavailable)."""
        st = self.hass.states.get(self._source)
        if st is None or st.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return None
        pos = st.attributes.get("current_position")
        if pos is not None:
            return int(pos)
        return 100 if st.state == "open" else 0

    # --- exposed cover state -------------------------------------------------
    @property
    def available(self) -> bool:
        """Available whenever the real device is."""
        st = self.hass.states.get(self._source)
        return st is not None and st.state != STATE_UNAVAILABLE

    @property
    def current_cover_position(self) -> int | None:
        """Best live position: gateway feed for tracked shades, else the source."""
        if self._tracked:
            if self._live_moving and self._live is not None:
                return self._live  # mid-travel: the real, smooth gateway position
            if self._hold is not None:
                return self._hold  # just commanded, gateway not yet moving
            if self._live is not None:
                if self._live <= CLAMP_LOW:
                    return 0
                if self._live >= CLAMP_HIGH:
                    return 100
                return self._live
        return self._source_position()

    @property
    def is_closed(self) -> bool | None:
        """Closed when fully down."""
        pos = self.current_cover_position
        return None if pos is None else pos == 0

    def _tracked_direction(self) -> str | None:
        """Infer travel direction from the last two live readings."""
        if self._prev_live is not None and self._live is not None:
            if self._live > self._prev_live:
                return "opening"
            if self._live < self._prev_live:
                return "closing"
        return None

    @property
    def is_opening(self) -> bool:
        """Whether the shade is currently travelling open."""
        if self._tracked:
            return self._live_moving and self._tracked_direction() == "opening"
        st = self.hass.states.get(self._source)
        return bool(st and st.state == STATE_OPENING)

    @property
    def is_closing(self) -> bool:
        """Whether the shade is currently travelling closed."""
        if self._tracked:
            return self._live_moving and self._tracked_direction() == "closing"
        st = self.hass.states.get(self._source)
        return bool(st and st.state == STATE_CLOSING)

    # --- commands (routed to the real device) --------------------------------
    async def async_open_cover(self, **kwargs) -> None:
        """Open by routing to the real cover."""
        await self._command(100)

    async def async_close_cover(self, **kwargs) -> None:
        """Close by routing to the real cover."""
        await self._command(0)

    async def async_set_cover_position(self, **kwargs) -> None:
        """Set an exact position on the real cover."""
        await self._command(int(kwargs[ATTR_POSITION]))

    async def async_stop_cover(self, **kwargs) -> None:
        """Stop the real cover."""
        await self.hass.services.async_call("cover", SERVICE_STOP_COVER, {"entity_id": self._source}, blocking=False)

    async def _command(self, target: int) -> None:
        """Route a movement to the real device, holding position until it moves."""
        # For tracked shades with no live reading yet (only right after a
        # restart), hold the pre-command position so we don't briefly show the
        # source cover's optimistic jump.
        if self._tracked and self._live is None:
            self._hold = self._source_position()
            self.async_write_ha_state()
        # Endpoints via open/close (the gateway reports the real ramp); an exact
        # position via set_position (gateway reports the target ~immediately).
        if target >= 100:
            service, data = SERVICE_OPEN_COVER, {"entity_id": self._source}
        elif target <= 0:
            service, data = SERVICE_CLOSE_COVER, {"entity_id": self._source}
        else:
            service = SERVICE_SET_COVER_POSITION
            data = {"entity_id": self._source, ATTR_POSITION: target}
        await self.hass.services.async_call("cover", service, data, blocking=False)
