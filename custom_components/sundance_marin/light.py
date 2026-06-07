"""Light entities — Innenlicht (with color effects) and Außenlicht."""
from __future__ import annotations

import asyncio
import logging

from homeassistant.components.light import (
    ATTR_EFFECT,
    ColorMode,
    LightEntity,
    LightEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .balboa import build_color, build_toggle
from .const import DOMAIN, LIGHT_EFFECTS
from .coordinator import SundanceCoordinator
from .entity import SundanceEntity

_LOGGER = logging.getLogger(__name__)

_TOGGLE_DELAY = 0.6  # seconds between toggle-on and color command


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: SundanceCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([
        SundanceInnerLight(coordinator, entry),
        SundanceOuterLight(coordinator, entry),
    ])


class SundanceInnerLight(SundanceEntity, LightEntity):
    """Innenlicht — on/off + 7 color effects.

    Color readback is not possible via the Balboa protocol; the active effect
    is stored optimistically in the coordinator and reset on next toggle.
    """

    _attr_translation_key = "inner_light"
    _attr_name = "Innenlicht"
    _attr_color_mode = ColorMode.ONOFF
    _attr_supported_color_modes = {ColorMode.ONOFF}
    _attr_effect_list = LIGHT_EFFECTS
    _attr_supported_features = LightEntityFeature.EFFECT

    def __init__(self, coordinator: SundanceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "light")

    @property
    def is_on(self) -> bool | None:
        return self.coordinator.data.get("light") if self.coordinator.data else None

    @property
    def effect(self) -> str | None:
        return self.coordinator.light_effect

    async def async_turn_on(self, **kwargs) -> None:
        effect = kwargs.get(ATTR_EFFECT)
        currently_on = self.is_on

        if effect:
            if not currently_on:
                await self.coordinator.send_command(build_toggle("LIGHT"))
                await asyncio.sleep(_TOGGLE_DELAY)
            await self.coordinator.send_command(build_color(effect))
            self.coordinator.light_effect = effect
        elif not currently_on:
            await self.coordinator.send_command(build_toggle("LIGHT"))
            self.coordinator.light_effect = None

    async def async_turn_off(self, **kwargs) -> None:
        if self.is_on:
            await self.coordinator.send_command(build_toggle("LIGHT"))
            self.coordinator.light_effect = None


class SundanceOuterLight(SundanceEntity, LightEntity):
    """Außenlicht — on/off only, no color control."""

    _attr_translation_key = "outer_light"
    _attr_name = "Außenlicht"
    _attr_color_mode = ColorMode.ONOFF
    _attr_supported_color_modes = {ColorMode.ONOFF}

    def __init__(self, coordinator: SundanceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "light2")

    @property
    def is_on(self) -> bool | None:
        return self.coordinator.data.get("light2") if self.coordinator.data else None

    async def async_turn_on(self, **kwargs) -> None:
        if not self.is_on:
            await self.coordinator.send_command(build_toggle("LIGHT2"))

    async def async_turn_off(self, **kwargs) -> None:
        if self.is_on:
            await self.coordinator.send_command(build_toggle("LIGHT2"))
