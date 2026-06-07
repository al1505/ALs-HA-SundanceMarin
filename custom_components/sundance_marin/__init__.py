"""Sundance Marin custom integration."""
from __future__ import annotations

import asyncio
import logging

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
