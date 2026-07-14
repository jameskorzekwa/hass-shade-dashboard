"""Setup/teardown tests for the frontend registration."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.shade_dashboard import (
    CARD_REGISTERED_KEY,
    async_setup_entry,
    async_unload_entry,
)
from custom_components.shade_dashboard.const import DOMAIN


async def test_setup_registers_card_and_panel(hass: HomeAssistant) -> None:
    """async_setup_entry serves the card and registers the Shades panel."""
    entry = MockConfigEntry(domain=DOMAIN, data={}, title="Shade Dashboard")
    entry.add_to_hass(hass)

    hass.http = MagicMock()
    hass.http.async_register_static_paths = AsyncMock()
    hass.config_entries.async_forward_entry_setups = AsyncMock()

    with (
        patch("homeassistant.components.frontend.add_extra_js_url") as add_js,
        patch(
            "homeassistant.components.panel_custom.async_register_panel",
            new=AsyncMock(),
        ) as reg_panel,
    ):
        assert await async_setup_entry(hass, entry) is True

    hass.config_entries.async_forward_entry_setups.assert_awaited_once()

    hass.http.async_register_static_paths.assert_awaited_once()
    add_js.assert_called_once()
    reg_panel.assert_awaited_once()

    kwargs = reg_panel.await_args.kwargs
    assert kwargs["frontend_url_path"] == "shades"
    assert kwargs["webcomponent_name"] == "shade-dashboard-card"
    # the resolved layout (all 22 shades) is handed to the card via panel config
    layout = kwargs["config"]["layout"]
    assert len(layout["shades"]) == 22
    assert layout["groups"]["all"]  # groups resolved to entity IDs
    assert hass.data[CARD_REGISTERED_KEY] is True


async def test_setup_is_idempotent(hass: HomeAssistant) -> None:
    """A second setup does not re-register the process-global card."""
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    hass.data[CARD_REGISTERED_KEY] = True
    hass.config_entries.async_forward_entry_setups = AsyncMock()

    with patch("homeassistant.components.panel_custom.async_register_panel", new=AsyncMock()) as reg_panel:
        assert await async_setup_entry(hass, entry) is True

    reg_panel.assert_not_called()


async def test_unload_entry(hass: HomeAssistant) -> None:
    """Unload always succeeds so the entry can be reloaded."""
    entry = MockConfigEntry(domain=DOMAIN, data={})
    entry.add_to_hass(hass)
    hass.config_entries.async_unload_platforms = AsyncMock(return_value=True)
    assert await async_unload_entry(hass, entry) is True
