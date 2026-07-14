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

from .const import (
    AUTO_RECAL_ENTITY,
    CALIBRATE_EVENT,
    CALIBRATE_HEX,
    CALIBRATING_EVENT,
    GATEWAY_HOST,
    GATEWAY_ROOM_SLOT,
    LIVE_EVENT,
    SHADES,
)

_LOGGER = logging.getLogger(__name__)

IDLE_DELAY = 2.0
MOVING_DELAY = 0.4
ERROR_DELAY = 8.0
# The gateway updates a shade's position only every ~0.5-1.5s, so a fast poll can
# briefly see no change mid-travel. Treat a shade as still moving for this long
# after its last position change so tracking doesn't flap on/off.
MOVE_HOLD = 2.5

# --- Calibration-drift detection --------------------------------------------
# A shade with collapsed travel limits reports a tiny position range (e.g. lrh1
# read ~4% when physically fully open). We catch this by comparing each shade to
# the fleet: over a rolling window the house opens everything (the morning
# automation), so a shade that MOVES but never gets near "open" while its peers
# do is miscalibrated. Detected shades are auto-recalibrated (rate-limited) and
# the user is notified.
CAL_CHECK_INTERVAL = 1800.0  # evaluate drift every 30 min
CAL_WINDOW = 12 * 3600.0  # look back 12h at how far each shade reached
CAL_OPEN_PCT = 90  # counts as "reached open"
CAL_SUSPECT_PCT = 50  # a healthy shade gets at least this far open in the window
CAL_RECAL_COOLDOWN = 12 * 3600.0  # don't recalibrate the same shade more often
# While calibrating a shade drives to both hard stops; lock out other commands
# for this long so nothing interferes with the limit re-teach.
CALIBRATE_LOCK = 90.0


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
        self._entity_to_ble: dict[str, str] = {}
        self._last: dict | None = None
        self._prev_pos: dict[str, int] = {}
        self._last_change: dict[str, float] = {}
        # calibration-drift bookkeeping
        self._reach: dict[str, list[tuple[float, int]]] = {}  # entity -> [(ts, pos)]
        self._last_recal: dict[str, float] = {}
        self._last_cal_check = 0.0
        self._calibrating: dict[str, float] = {}  # entity -> monotonic lock expiry

    async def _get(self, path: str):
        async with self._session.get(f"http://{self._host}{path}", timeout=8) as resp:
            resp.raise_for_status()
            return await resp.json()

    async def _build_map(self) -> None:
        """Map gateway shade id -> HA cover entity (via room + ptName) + bleName."""
        shades = _list(await self._get("/home/shades"), "shadeData", "shades")
        mapping: dict[int, str] = {}
        ble: dict[str, str] = {}
        for shade in shades:
            prefix = GATEWAY_ROOM_SLOT.get(shade.get("roomId"))
            if not prefix:
                continue
            slot = prefix if prefix == "lrh1" else f"{prefix}{shade.get('ptName')}"
            entity = SHADES.get(slot)
            if entity:
                mapping[shade["id"]] = entity
                if shade.get("bleName"):
                    ble[entity] = shade["bleName"]
        self._id_to_entity = mapping
        self._entity_to_ble = ble
        _LOGGER.debug("Gateway tracker mapped %d shades (%d with bleName)", len(mapping), len(ble))

    def is_calibrating(self, entity_id: str) -> bool:
        """Whether a shade is currently locked mid-calibration."""
        return time.monotonic() < self._calibrating.get(entity_id, 0.0)

    def _set_calibrating(self, entity_id: str, seconds: float) -> None:
        """Lock/unlock a shade and tell its cover (seconds=0 unlocks)."""
        if seconds > 0:
            self._calibrating[entity_id] = time.monotonic() + seconds
        else:
            self._calibrating.pop(entity_id, None)
        self.hass.bus.async_fire(CALIBRATING_EVENT, {"entity_id": entity_id, "seconds": seconds})

    async def async_recalibrate(self, entity_id: str) -> bool:
        """Trigger the shade's on-board calibration via the gateway BLE relay."""
        ble = self._entity_to_ble.get(entity_id)
        if not ble:
            _LOGGER.warning("No gateway bleName for %s; cannot recalibrate", entity_id)
            return False
        if self.is_calibrating(entity_id):
            _LOGGER.info("%s is already calibrating; ignoring recalibrate", entity_id)
            return False
        # Lock BEFORE sending so a command racing in right after is blocked.
        self._set_calibrating(entity_id, CALIBRATE_LOCK)
        try:
            # bleName contains a ':' — build the URL directly to avoid re-encoding.
            url = f"http://{self._host}/home/shades/exec?shades={ble}"
            async with self._session.post(url, json={"hex": CALIBRATE_HEX}, timeout=10) as resp:
                resp.raise_for_status()
                data = await resp.json()
        except Exception as err:  # noqa: BLE001 - report, don't raise into the service
            _LOGGER.warning("Recalibrate %s (%s) failed: %s", entity_id, ble, err)
            self._set_calibrating(entity_id, 0)  # unlock — it never started
            return False
        ok = isinstance(data, dict) and data.get("err") == 0
        if not ok:
            self._set_calibrating(entity_id, 0)  # unlock — gateway rejected it
        _LOGGER.info("Recalibrate %s (%s): %s", entity_id, ble, "accepted" if ok else data)
        return ok

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
            # sparse position history (dedupe unchanged) for drift detection
            hist = self._reach.setdefault(entity, [])
            if not hist or hist[-1][1] != value:
                hist.append((now, value))
        self._prev_pos = positions
        payload = {"positions": positions, "moving": sorted(moving)}
        if payload != self._last:
            self.hass.bus.async_fire(LIVE_EVENT, payload)
            self._last = payload
        await self._maybe_check_calibration(now)
        return MOVING_DELAY if moving else IDLE_DELAY

    async def _maybe_check_calibration(self, now: float) -> None:
        """Every CAL_CHECK_INTERVAL, look for a shade with collapsed limits."""
        if now - self._last_cal_check < CAL_CHECK_INTERVAL:
            return
        self._last_cal_check = now
        window_start = now - CAL_WINDOW
        reached: dict[str, int] = {}
        for entity, hist in self._reach.items():
            hist[:] = [(t, v) for (t, v) in hist if t >= window_start]  # prune to window
            if hist:
                reached[entity] = max(v for _, v in hist)
        if not reached:
            return
        # Only judge once the fleet has demonstrably opened (so a low reading is
        # an outlier, not just "nothing has been opened yet since restart").
        opened = [e for e, m in reached.items() if m >= CAL_OPEN_PCT]
        if len(opened) < max(3, (len(reached) + 1) // 2):
            return
        for entity, m in reached.items():
            if m >= CAL_SUSPECT_PCT:
                continue  # got at least halfway open -> fine
            if now - self._last_change.get(entity, 0.0) > CAL_WINDOW:
                continue  # hasn't actually moved -> not a stuck-range case (or unused)
            if now - self._last_recal.get(entity, 0.0) < CAL_RECAL_COOLDOWN:
                continue  # already handled recently
            self._last_recal[entity] = now
            _LOGGER.warning("Calibration drift: %s only reached %d%% open while the fleet opened fully", entity, m)
            await self._handle_drift(entity, m)
            break  # one per cycle — bound the blast radius if detection is wrong

    async def _handle_drift(self, entity: str, reach: int) -> None:
        """Notify + (unless the kill switch is off) auto-recalibrate a shade."""
        self.hass.bus.async_fire(CALIBRATE_EVENT, {"entity_id": entity, "reach": reach})
        kill = self.hass.states.get(AUTO_RECAL_ENTITY)
        auto = kill is None or kill.state != "off"
        msg = (
            f"{entity} only reached {reach}% open while the other shades opened fully — "
            f"its PowerView limits look miscalibrated. "
            + ("Auto-recalibrating it now." if auto else "Auto-recalibrate is off; recalibrate it manually.")
        )
        with contextlib.suppress(Exception):
            await self.hass.services.async_call(
                "persistent_notification",
                "create",
                {"title": "Shade calibration drift", "message": msg, "notification_id": f"shade_recal_{entity}"},
                blocking=False,
            )
        if auto:
            await self.async_recalibrate(entity)
