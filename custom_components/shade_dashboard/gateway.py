"""Live shade-position tracking from the PowerView Gen3 gateway.

The hunterdouglas_powerview integration only surfaces endpoint positions (the
recorder shows straight open<->closed jumps), so during a move the dashboard has
nothing real to show. The G3 gateway's local API, however, reports each shade's
live ``positions.primary`` (0.0 closed -> 1.0 open) plus ``velocity``/``motion``
while it travels. This poller reads that during motion and fires a
``shade_dashboard_live_position`` event ({positions: {entity: 0-100}, moving:
[entity...]}) that the card follows so the fabric tracks the real shade.

Cadence: ~2.5 s when idle (cheap; only fires an event when something changes, so
idle produces no events), ~0.4 s while any shade is moving. The main bedroom
shade isn't on this gateway, so it isn't tracked (the card falls back to HA
state for it).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time

from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import GATEWAY_HOST, GATEWAY_ROOM_SLOT, LIVE_EVENT, SHADES

_LOGGER = logging.getLogger(__name__)

IDLE_DELAY = 2.0
MOVING_DELAY = 0.4
ERROR_DELAY = 8.0
# The gateway updates a shade's position only every ~0.5-1.5s, so a fast poll can
# briefly see no change mid-travel. Treat a shade as still moving for this long
# after its last position change so tracking doesn't flap on/off.
MOVE_HOLD = 2.5


def _list(data, *keys):
    """Normalize a G3 response to a list (it may be bare or wrapped)."""
    if isinstance(data, list):
        return data
    for k in keys:
        if isinstance(data.get(k), list):
            return data[k]
    return []


class GatewayTracker:
    """Polls the G3 gateway and fires live-position events during motion."""

    def __init__(self, hass: HomeAssistant, host: str = GATEWAY_HOST) -> None:
        self.hass = hass
        self._host = host
        self._session = async_get_clientsession(hass)
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self._id_to_entity: dict[int, str] = {}
        self._last: dict | None = None
        self._prev_pos: dict[str, int] = {}
        self._last_change: dict[str, float] = {}

    async def _get(self, path: str):
        async with self._session.get(f"http://{self._host}{path}", timeout=8) as resp:
            resp.raise_for_status()
            return await resp.json()

    async def _build_map(self) -> None:
        """Map gateway shade id -> HA cover entity via room + ptName."""
        shades = _list(await self._get("/home/shades"), "shadeData", "shades")
        mapping: dict[int, str] = {}
        for shade in shades:
            prefix = GATEWAY_ROOM_SLOT.get(shade.get("roomId"))
            if not prefix:
                continue
            slot = prefix if prefix == "lrh1" else f"{prefix}{shade.get('ptName')}"
            entity = SHADES.get(slot)
            if entity:
                mapping[shade["id"]] = entity
        self._id_to_entity = mapping
        _LOGGER.debug("Gateway tracker mapped %d shades", len(mapping))

    async def start(self) -> None:
        try:
            await self._build_map()
        except Exception:  # noqa: BLE001 - never break setup on a gateway hiccup
            _LOGGER.warning("Could not reach PowerView gateway %s for live tracking", self._host)
        self._task = self.hass.loop.create_task(self._run())

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except (TimeoutError, asyncio.CancelledError):
                self._task.cancel()

    async def _run(self) -> None:
        while not self._stop.is_set():
            delay = ERROR_DELAY
            try:
                if not self._id_to_entity:
                    await self._build_map()
                delay = await self._poll_once()
            except Exception as err:  # noqa: BLE001 - keep polling through transient errors
                _LOGGER.debug("Gateway poll error: %s", err)
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._stop.wait(), timeout=delay)

    async def _poll_once(self) -> float:
        shades = _list(await self._get("/home/shades"), "shadeData", "shades")
        positions: dict[str, int] = {}
        moving: list[str] = []
        now = time.monotonic()
        for shade in shades:
            entity = self._id_to_entity.get(shade.get("id"))
            if not entity:
                continue
            pos = shade.get("positions") or {}
            value = round((pos.get("primary") or 0) * 100)
            positions[entity] = value
            # velocity/motion are unreliable (usually 0/None even mid-travel), so
            # motion = "position changed within the last MOVE_HOLD seconds".
            prev = self._prev_pos.get(entity)
            if prev is not None and prev != value:
                self._last_change[entity] = now
            if now - self._last_change.get(entity, 0.0) < MOVE_HOLD:
                moving.append(entity)
        self._prev_pos = positions
        payload = {"positions": positions, "moving": sorted(moving)}
        if payload != self._last:
            self.hass.bus.async_fire(LIVE_EVENT, payload)
            self._last = payload
        return MOVING_DELAY if moving else IDLE_DELAY
