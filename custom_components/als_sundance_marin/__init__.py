"""Sundance Marin custom integration."""
from __future__ import annotations

import asyncio
import logging
import os
import shutil

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
_LOCAL_URL = f"/local/{_CARD_JS}"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Copy the Lovelace card JS to www/ so it is served at /local/ on every startup.

    /local/ is served by HA's built-in HTTP server independent of integration
    setup timing, avoiding the race condition where the browser requests the
    resource before async_setup_entry has registered the static path.
    """
    card_src = hass.config.path(f"custom_components/{DOMAIN}/www/{_CARD_JS}")
    card_dst = hass.config.path(f"www/{_CARD_JS}")
    if os.path.isfile(card_src):
        await hass.async_add_executor_job(_copy_card, card_src, card_dst)
        _LOGGER.info("Lovelace card available at %s", _LOCAL_URL)
    else:
        _LOGGER.warning("Card JS not found at %s — skipping /local/ copy", card_src)
    return True


def _copy_card(src: str, dst: str) -> None:
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    # Also register via StaticPathConfig so the /als_sundance_marin/ URL works
    # (e.g. for fresh HACS installs before async_setup has copied to www/).
    card_path = hass.config.path(f"custom_components/{DOMAIN}/www/{_CARD_JS}")
    if os.path.isfile(card_path) and not hass.data.get(f"{DOMAIN}_card_registered"):
        try:
            await hass.http.async_register_static_paths(
                [StaticPathConfig(_CARD_URL, card_path, False)]
            )
            hass.data[f"{DOMAIN}_card_registered"] = True
        except Exception:  # noqa: BLE001
            pass  # already registered or HTTP not ready — /local/ is the primary path

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
