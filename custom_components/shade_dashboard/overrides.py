"""Persistent per-shade automation overrides."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers.storage import Store

from .const import DOMAIN, OVERRIDE_EVENT, SHADES, abstract_entity

STORAGE_KEY = f"{DOMAIN}.overrides"
STORAGE_VERSION = 1
SAVE_DELAY = 1
EXPECTED_MOVE_SECONDS = 75
AUTOMATION_CONTEXT_SECONDS = 300
DIRECTION_EPS = 1
ARRIVAL_EPS = 3


@dataclass
class _ExpectedMove:
    """One integration-issued movement awaiting completion."""

    expires: float
    expires_at: float
    target: int | None
    direction: int | None
    kind: str
    attribution_seconds: float
    restore_expires_at: float | None = None


class OverrideManager:
    """Track persistent overrides and movements initiated by this integration."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._overrides: set[str] = set()
        self._expected_sources: dict[str, list[_ExpectedMove]] = {}
        self._source_followups: dict[str, tuple[int, float]] = {}
        self._automation_contexts: dict[str, float] = {}
        self._source_to_abstract = {source: abstract_entity(slot) for slot, source in SHADES.items()}

    async def async_load(self) -> None:
        """Load saved overrides, dropping entities no longer in the layout."""
        data = await self._store.async_load() or {}
        valid = set(self._source_to_abstract.values())
        self._overrides = set(data.get("entities", ())) & valid
        now = time.monotonic()
        now_at = time.time()
        expected_data = data.get("expected", {})
        if not isinstance(expected_data, dict):
            return
        for source, saved_moves in expected_data.items():
            if source not in self._source_to_abstract or not isinstance(saved_moves, list):
                continue
            moves: list[_ExpectedMove] = []
            for saved in saved_moves:
                if not isinstance(saved, dict):
                    continue
                try:
                    expires_at = float(saved["expires_at"])
                    seconds = float(saved["attribution_seconds"])
                except (KeyError, TypeError, ValueError):
                    continue
                target = saved.get("target")
                if target is not None and (not isinstance(target, int) or not 0 <= target <= 100):
                    continue
                direction = saved.get("direction")
                if direction not in (None, -1, 1):
                    continue
                kind = saved.get("kind", "move")
                if not isinstance(kind, str):
                    continue
                restore_expires_at = saved.get("restore_expires_at")
                if restore_expires_at is not None and not isinstance(restore_expires_at, (int, float)):
                    continue
                remaining = expires_at - now_at
                if remaining <= 0 or seconds <= 0:
                    continue
                moves.append(
                    _ExpectedMove(
                        expires=now + remaining,
                        expires_at=expires_at,
                        target=target,
                        direction=direction,
                        kind=kind,
                        attribution_seconds=seconds,
                        restore_expires_at=float(restore_expires_at) if restore_expires_at is not None else None,
                    )
                )
            if moves:
                self._expected_sources[source] = moves
        followups = data.get("followups", {})
        if isinstance(followups, dict):
            for source, saved in followups.items():
                if source not in self._source_to_abstract or not isinstance(saved, dict):
                    continue
                target = saved.get("target")
                expires_at = saved.get("expires_at")
                if target not in (0, 100) or not isinstance(expires_at, (int, float)) or expires_at <= now_at:
                    continue
                self._source_followups[source] = (target, float(expires_at))

    def is_overridden(self, entity_id: str) -> bool:
        """Return whether an abstract shade is excluded from automation."""
        return entity_id in self._overrides

    def is_source_overridden(self, source_entity: str) -> bool:
        """Return whether a real source cover is excluded from automation."""
        entity_id = self._source_to_abstract.get(source_entity)
        return entity_id is not None and entity_id in self._overrides

    def set_overridden(self, entity_id: str, overridden: bool) -> None:
        """Update one override and notify its cover entity."""
        if overridden:
            if entity_id in self._overrides:
                return
            self._overrides.add(entity_id)
        else:
            if entity_id not in self._overrides:
                return
            self._overrides.remove(entity_id)
        self._schedule_save()
        self.hass.bus.async_fire(
            OVERRIDE_EVENT,
            {"entity_id": entity_id, "overridden": overridden},
        )

    def set_source_overridden(self, source_entity: str) -> None:
        """Set an override using a real source cover entity ID."""
        if entity_id := self._source_to_abstract.get(source_entity):
            self.set_overridden(entity_id, True)

    def expect_source_move(
        self,
        source_entity: str,
        target: int | None = None,
        *,
        seconds: float = EXPECTED_MOVE_SECONDS,
        direction: int | None = None,
        kind: str = "move",
        restore_seconds: float | None = None,
    ) -> None:
        """Suppress hardware-movement detection for an integration-issued move."""
        now = time.monotonic()
        now_at = time.time()
        expected_moves = [move for move in self._expected_sources.get(source_entity, ()) if now < move.expires]
        for move in expected_moves:
            if move.target == target and move.direction == direction and move.kind == kind:
                move.expires = now + seconds
                move.expires_at = now_at + seconds
                move.attribution_seconds = seconds
                if restore_seconds is not None:
                    move.restore_expires_at = now_at + restore_seconds
                expected_moves.remove(move)
                expected_moves.append(move)
                self._expected_sources[source_entity] = expected_moves
                self._schedule_save()
                return
        expected_moves.append(
            _ExpectedMove(
                expires=now + seconds,
                expires_at=now_at + seconds,
                target=target,
                direction=direction,
                kind=kind,
                attribution_seconds=seconds,
                restore_expires_at=now_at + restore_seconds if restore_seconds is not None else None,
            )
        )
        self._expected_sources[source_entity] = expected_moves
        self._schedule_save()

    def source_move_is_expected(
        self,
        source_entity: str,
        *,
        previous: int | None = None,
        current: int | None = None,
        direction: int | None = None,
        settled: bool = False,
        arrival_tolerance: int = ARRIVAL_EPS,
    ) -> bool:
        """Attribute motion to an integration command while it heads to target."""
        now = time.monotonic()
        expected_moves = [move for move in self._expected_sources.get(source_entity, ()) if now < move.expires]
        if not expected_moves:
            if self._expected_sources.pop(source_entity, None) is not None:
                self._schedule_save()
            return False
        self._expected_sources[source_entity] = expected_moves
        if previous is None or current is None:
            return True

        latest = expected_moves[-1]
        if len(expected_moves) > 1 and latest.target is not None and abs(latest.target - current) <= arrival_tolerance:
            expected_moves = [latest]
            self._expected_sources[source_entity] = expected_moves
            self._schedule_save()

        delta = current - previous
        resume_moves = [move for move in expected_moves if move.kind == "resume"]
        if settled and resume_moves:
            remaining = [move for move in expected_moves if move.kind != "resume"]
            if remaining:
                self._expected_sources[source_entity] = remaining
            else:
                self._expected_sources.pop(source_entity, None)
            self._schedule_save()
            return True
        if settled and not any(
            move.target is None or abs(move.target - current) <= arrival_tolerance for move in expected_moves
        ):
            self._expected_sources.pop(source_entity, None)
            self._schedule_save()
            return False
        if abs(delta) <= DIRECTION_EPS and direction is None:
            return True
        if abs(delta) > DIRECTION_EPS:
            actual_direction = 1 if delta > 0 else -1
            matching = [
                move
                for move in expected_moves
                if (move.target is None and (move.direction is None or move.direction == actual_direction))
                or (move.target is not None and abs(move.target - current) <= abs(move.target - previous))
            ]
        else:
            matching = [
                move
                for move in expected_moves
                if (move.target is None and (move.direction is None or move.direction == direction))
                or (move.target is not None and direction > 0 and move.target > previous)
                or (move.target is not None and direction < 0 and move.target < previous)
            ]
        if not matching:
            # Motion away from every active automatic target is a genuine manual
            # intervention. Keep superseded targets briefly because queued
            # gateway commands can continue moving before a reversal takes hold.
            self._expected_sources.pop(source_entity, None)
            self._schedule_save()
            return False
        now_at = time.time()
        for move in matching:
            move.expires = now + move.attribution_seconds
            move.expires_at = now_at + move.attribution_seconds
        self._schedule_save()
        return True

    def cancel_source_moves(self, source_entity: str) -> None:
        """Drop attribution for commands known not to have started."""
        if self._expected_sources.pop(source_entity, None) is not None:
            self._schedule_save()

    def cancel_source_move(
        self,
        source_entity: str,
        target: int | None,
        *,
        direction: int | None = None,
        kind: str = "move",
    ) -> None:
        """Drop one command attribution while preserving other active targets."""
        moves = self._expected_sources.get(source_entity)
        if not moves:
            return
        remaining = [
            move for move in moves if not (move.target == target and move.direction == direction and move.kind == kind)
        ]
        if len(remaining) == len(moves):
            return
        if remaining:
            self._expected_sources[source_entity] = remaining
        else:
            self._expected_sources.pop(source_entity, None)
        self._schedule_save()

    def active_moves(self, kind: str) -> list[tuple[str, float]]:
        """Return active source moves of one kind with remaining seconds."""
        now = time.monotonic()
        now_at = time.time()
        return [
            (
                source,
                move.restore_expires_at - now_at if move.restore_expires_at is not None else move.expires - now,
            )
            for source, moves in self._expected_sources.items()
            for move in moves
            if move.kind == kind
            and now < move.expires
            and (move.restore_expires_at is None or now_at < move.restore_expires_at)
        ]

    def set_source_followup(self, source_entity: str, target: int | None) -> None:
        """Persist or clear a RYSE endpoint command that must follow its nudge."""
        if target is None:
            if self._source_followups.pop(source_entity, None) is not None:
                self._schedule_save()
            return
        self._source_followups[source_entity] = (target, time.time() + EXPECTED_MOVE_SECONDS)
        self._schedule_save()

    def source_followup(self, source_entity: str) -> int | None:
        """Return one unexpired RYSE endpoint followup."""
        followup = self._source_followups.get(source_entity)
        if followup is None:
            return None
        target, expires_at = followup
        if time.time() < expires_at:
            return target
        self._source_followups.pop(source_entity, None)
        self._schedule_save()
        return None

    def mark_automation_context(self, context: Context) -> None:
        """Mark a service context whose cover commands must not create overrides."""
        now = time.monotonic()
        self._automation_contexts = {
            context_id: expires for context_id, expires in self._automation_contexts.items() if now < expires
        }
        self._automation_contexts[context.id] = now + AUTOMATION_CONTEXT_SECONDS

    def is_automation_context(self, context: Context | None) -> bool:
        """Return whether a cover command belongs to an automatic group move."""
        if context is None:
            return False
        expires = self._automation_contexts.get(context.id, 0)
        if time.monotonic() < expires:
            return True
        self._automation_contexts.pop(context.id, None)
        return False

    def _schedule_save(self) -> None:
        """Persist overrides and in-flight attribution after a short debounce."""
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY)

    async def async_flush(self) -> None:
        """Write current state before replacing this manager on reload."""
        await self._store.async_save(self._data_to_save())

    def _data_to_save(self) -> dict[str, Any]:
        now_at = time.time()
        expected = {
            source: [
                {
                    "target": move.target,
                    "direction": move.direction,
                    "kind": move.kind,
                    "expires_at": move.expires_at,
                    "attribution_seconds": move.attribution_seconds,
                    "restore_expires_at": move.restore_expires_at,
                }
                for move in moves
                if now_at < move.expires_at
            ]
            for source, moves in self._expected_sources.items()
        }
        return {
            "entities": sorted(self._overrides),
            "expected": {source: moves for source, moves in expected.items() if moves},
            "followups": {
                source: {"target": target, "expires_at": expires_at}
                for source, (target, expires_at) in self._source_followups.items()
                if now_at < expires_at
            },
        }
