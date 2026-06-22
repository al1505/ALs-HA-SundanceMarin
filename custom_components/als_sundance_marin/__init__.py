"""Sundance Marin custom integration."""
from __future__ import annotations

import asyncio
import logging
import os

from homeassistant.components.http import StaticPathConfig
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

_CARD_JS  = "ALs-sundance-marin-card.js"
_CARD_URL = f"/{DOMAIN}/{_CARD_JS}"
_CARD_REGISTERED_KEY = f"{DOMAIN}_card_registered"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    # Register the Lovelace card JS as a static HTTP asset (once per HA instance).
    # The file lives in custom_components/.../www/ so HACS installs it automatically.
    # Uses StaticPathConfig (HA 2024.11+ API) instead of the removed register_static_path.
    if not hass.data.get(_CARD_REGISTERED_KEY):
        card_path = hass.config.path(f"custom_components/{DOMAIN}/www/{_CARD_JS}")
        if os.path.isfile(card_path):
            try:
                await hass.http.async_register_static_paths(
                    [StaticPathConfig(_CARD_URL, card_path, False)]
                )
                from homeassistant.components import frontend as _fe  # noqa: PLC0415
                _fe.add_extra_js_url(hass, _CARD_URL)
                hass.data[_CARD_REGISTERED_KEY] = True
                _LOGGER.info("Lovelace card registered at %s", _CARD_URL)
            except Exception as exc:  # noqa: BLE001
                _LOGGER.warning("Could not register card JS (%s) — add it manually as a Lovelace resource: %s", exc, _CARD_URL)
        else:
            _LOGGER.warning("Card JS not found at %s", card_path)

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
