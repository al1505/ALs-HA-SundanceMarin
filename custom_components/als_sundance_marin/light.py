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

from .balboa import (
    build_inner_light_color,
    build_inner_light_rainbow,
    build_light_off,
    build_light_on,
    build_light2_off,
    build_light2_on,
)
from .const import DOMAIN, LIGHT_EFFECTS
from .coordinator import SundanceCoordinator
from .entity import SundanceEntity

_LOGGER = logging.getLogger(__name__)

_COLOR_DELAY = 0.6  # seconds between light-on and color command


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: SundanceCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([
        SundanceInnerLight(coordinator, entry),
        SundanceOuterLight(coordinator, entry),
    ])


class SundanceInnerLight(SundanceEntity, LightEntity):
    """Innenlicht — on/off + color effects via cmd=0x31 (verified 2026-05-25)."""

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
                await self.coordinator.send_command(build_light_on())
                await asyncio.sleep(_COLOR_DELAY)
            if effect == "Rainbow":
                await self.coordinator.send_command(build_inner_light_rainbow())
            else:
                await self.coordinator.send_command(build_inner_light_color(effect))
            self.coordinator.light_effect = effect
        elif not currently_on:
            await self.coordinator.send_command(build_light_on())
            self.coordinator.light_effect = None

    async def async_turn_off(self, **kwargs) -> None:
        if self.is_on:
            await self.coordinator.send_command(build_light_off())
            self.coordinator.light_effect = None


class SundanceOuterLight(SundanceEntity, LightEntity):
    """Außenlicht — on/off only.

    The outer light state is NOT in the Balboa status frame (confirmed 2026-05-25).
    State is tracked optimistically in coordinator.light2_on.
    """

    _attr_translation_key = "outer_light"
    _attr_name = "Außenlicht"
    _attr_color_mode = ColorMode.ONOFF
    _attr_supported_color_modes = {ColorMode.ONOFF}

    def __init__(self, coordinator: SundanceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "light2")

    @property
    def is_on(self) -> bool | None:
        return self.coordinator.light2_on

    async def async_turn_on(self, **kwargs) -> None:
        if not self.coordinator.light2_on:
            await self.coordinator.send_command(build_light2_on())
            self.coordinator.light2_on = True
            self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        if self.coordinator.light2_on:
            await self.coordinator.send_command(build_light2_off())
            self.coordinator.light2_on = False
            self.async_write_ha_state()
