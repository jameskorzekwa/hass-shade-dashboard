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


@dataclass
class _ExpectedMove:
    """One integration-issued movement awaiting completion."""

    expires: float
    target: int | None


class OverrideManager:
    """Track persistent overrides and movements initiated by this integration."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._overrides: set[str] = set()
        self._expected_sources: dict[str, _ExpectedMove] = {}
        self._automation_contexts: dict[str, float] = {}
        self._source_to_abstract = {source: abstract_entity(slot) for slot, source in SHADES.items()}

    async def async_load(self) -> None:
        """Load saved overrides, dropping entities no longer in the layout."""
        data = await self._store.async_load() or {}
        valid = set(self._source_to_abstract.values())
        self._overrides = set(data.get("entities", ())) & valid

    def is_overridden(self, entity_id: str) -> bool:
        """Return whether an abstract shade is excluded from automation."""
        return entity_id in self._overrides

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
        self._store.async_delay_save(self._data_to_save, SAVE_DELAY)
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
    ) -> None:
        """Suppress hardware-movement detection for an integration-issued move."""
        self._expected_sources[source_entity] = _ExpectedMove(
            expires=time.monotonic() + seconds,
            target=target,
        )

    def source_move_is_expected(
        self,
        source_entity: str,
        *,
        previous: int | None = None,
        current: int | None = None,
    ) -> bool:
        """Attribute motion to an integration command while it heads to target."""
        expected = self._expected_sources.get(source_entity)
        if expected is None:
            return False
        now = time.monotonic()
        if now >= expected.expires:
            self._expected_sources.pop(source_entity, None)
            return False
        if expected.target is None or previous is None or current is None:
            return True

        delta = current - previous
        previous_distance = abs(expected.target - previous)
        current_distance = abs(expected.target - current)
        if abs(delta) > DIRECTION_EPS and current_distance > previous_distance:
            # A person reversed an automatic move before its attribution window
            # expired. That new direction is manual and must override automation.
            self._expected_sources.pop(source_entity, None)
            return False
        # Keep attribution for the full window after arrival. The gateway can
        # replay a late endpoint transition; a real manual reversal is still
        # detected immediately by the distance check above.
        return True

    def mark_automation_context(self, context: Context) -> None:
        """Mark a service context whose cover commands must not create overrides."""
        self._automation_contexts[context.id] = time.monotonic() + AUTOMATION_CONTEXT_SECONDS

    def is_automation_context(self, context: Context | None) -> bool:
        """Return whether a cover command belongs to an automatic group move."""
        if context is None:
            return False
        expires = self._automation_contexts.get(context.id, 0)
        if time.monotonic() < expires:
            return True
        self._automation_contexts.pop(context.id, None)
        return False

    def _data_to_save(self) -> dict[str, list[str]]:
        return {"entities": sorted(self._overrides)}
