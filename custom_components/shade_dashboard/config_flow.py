"""Config flow for Shade Dashboard.

Single-instance, no user input: the mapping is baked into ``const.py``, so the
flow exists only to create the config entry that triggers ``async_setup_entry``
(which registers the card and the "Shades" panel).
"""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN


class ShadeDashboardConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the (trivial) config flow for the shade dashboard."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Handle the initial step — one click to install."""
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            return self.async_create_entry(title="Shade Dashboard", data={})

        return self.async_show_form(step_id="user")
