"""Shared fixtures for Shade Dashboard tests."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Enable loading of this custom integration in every test."""
    yield


@pytest.fixture(autouse=True)
def _no_gateway_polling():
    """Stub the live-position gateway poller so tests never hit the network."""
    with patch("custom_components.shade_dashboard.GatewayTracker") as tracker_cls:
        inst = tracker_cls.return_value
        inst.start = AsyncMock()
        inst.stop = AsyncMock()
        yield tracker_cls
