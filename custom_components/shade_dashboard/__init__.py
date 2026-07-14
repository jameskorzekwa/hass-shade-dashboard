"""The Shade Dashboard integration.

A frontend-only integration in the mold of hass-airzone-cloud-schedules: it owns
no entities of its own. On setup it serves the bundled Lovelace card and
registers it both as an extra-JS module (usable as a `shade-dashboard-card` on
any dashboard) and as a dedicated custom panel — the standalone "Shades"
sidebar dashboard. The card drives the existing PowerView `cover.*` entities via
core cover services; the window -> entity layout is passed to it from
``const.build_panel_config``.
"""

from __future__ import annotations

import logging
import os

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, build_panel_config
from .gateway import GatewayTracker

_LOGGER = logging.getLogger(__name__)

# Config-entry-only integration (set up from the UI, no YAML config).
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

CARD_FILENAME = "shade-dashboard-card.js"
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"
CARD_REGISTERED_KEY = f"{DOMAIN}_card_registered"
TRACKER_KEY = f"{DOMAIN}_tracker"
PANEL_URL_PATH = "shades"
WEBCOMPONENT_NAME = "shade-dashboard-card"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up Shade Dashboard from a config entry."""
    if CARD_REGISTERED_KEY not in hass.data:
        try:
            card_path = os.path.join(os.path.dirname(__file__), CARD_FILENAME)
            if os.path.isfile(card_path):
                from homeassistant.components.frontend import add_extra_js_url
                from homeassistant.components.http import StaticPathConfig
                from homeassistant.components.panel_custom import async_register_panel

                mtime = str(os.path.getmtime(card_path))
                card_url_with_version = f"{CARD_URL}?v={mtime}"

                await hass.http.async_register_static_paths([StaticPathConfig(CARD_URL, card_path, False)])
                add_extra_js_url(hass, card_url_with_version)

                await async_register_panel(
                    hass,
                    frontend_url_path=PANEL_URL_PATH,
                    webcomponent_name=WEBCOMPONENT_NAME,
                    sidebar_title="Shades",
                    sidebar_icon="mdi:blinds-horizontal",
                    module_url=card_url_with_version,
                    config={"config_entry": entry.entry_id, "layout": build_panel_config()},
                    require_admin=False,
                )

                _LOGGER.debug("Registered shade dashboard card + panel at %s", card_url_with_version)
            else:
                _LOGGER.warning("Shade dashboard card JS not found at %s", card_path)
            hass.data[CARD_REGISTERED_KEY] = True
        except Exception:  # noqa: BLE001 - registration must never break setup
            _LOGGER.exception("Failed to register shade dashboard card")

    # Live position tracking: poll the PowerView gateway and fire live-position
    # events the card follows during motion. Process-global (one poller).
    if TRACKER_KEY not in hass.data:
        tracker = GatewayTracker(hass)
        hass.data[TRACKER_KEY] = tracker
        await tracker.start()

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload a config entry.

    The card/panel registration is process-global and cheap to leave in place;
    unload simply succeeds so the entry can be reloaded.
    """
    tracker = hass.data.pop(TRACKER_KEY, None)
    if tracker is not None:
        await tracker.stop()
    return True
