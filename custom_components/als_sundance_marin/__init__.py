"""Sundance Marin custom integration."""
from __future__ import annotations

import asyncio
import logging
import os

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_HOST, CONF_PORT, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryNotReady

from .const import DOMAIN
from .coordinator import SundanceCoordinator

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [
    Platform.CLIMATE,
    Platform.SWITCH,
    Platform.LIGHT,
    Platform.BINARY_SENSOR,
    Platform.SELECT,
]

_CARD_JS = "ALs-sundance-marin-card.js"
_CARD_URL = f"/{DOMAIN}/{_CARD_JS}"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Register the Lovelace card as a static frontend resource.

    Called once when the domain first loads (before any config entries).
    The card JS lives inside the component's www/ subfolder so HACS installs
    it automatically alongside the integration.
    """
    card_path = hass.config.path(f"custom_components/{DOMAIN}/www/{_CARD_JS}")
    if os.path.isfile(card_path):
        hass.http.register_static_path(_CARD_URL, card_path, cache_headers=False)
        from homeassistant.components import frontend as ha_frontend  # noqa: PLC0415
        ha_frontend.add_extra_js_url(hass, _CARD_URL)
        _LOGGER.info("Lovelace card registered at %s", _CARD_URL)
    else:
        _LOGGER.warning("Card JS not found at %s — skipping registration", card_path)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator = SundanceCoordinator(
        hass, entry.data[CONF_HOST], entry.data[CONF_PORT]
    )

    try:
        await coordinator.async_connect()
    except OSError as exc:
        raise ConfigEntryNotReady(
            f"Cannot connect to EW11 at {entry.data[CONF_HOST]}:{entry.data[CONF_PORT]}: {exc}"
        ) from exc

    # Wait up to 5 s for the first status frame; continue even if it times out
    # (entities will show as unavailable until data arrives)
    try:
        async with asyncio.timeout(5):
            await coordinator.async_wait_for_first_data()
    except asyncio.TimeoutError:
        _LOGGER.warning("No status frame received within 5 s — starting anyway")

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        coordinator: SundanceCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        await coordinator.async_disconnect()
    return unloaded
