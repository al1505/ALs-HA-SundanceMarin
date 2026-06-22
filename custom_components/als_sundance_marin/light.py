"""Light entities — Innenlicht (with color effects) and Außenlicht."""
from __future__ import annotations

import asyncio
import logging

from homeassistant.components.light import (
    ATTR_BRIGHTNESS,
    ATTR_EFFECT,
    ColorMode,
    LightEntity,
    LightEntityFeature,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .balboa import (
    build_inner_light_brightness,
    build_inner_light_color,
    build_inner_light_rainbow,
    build_light_off,
    build_light_on,
    build_light2_off,
    build_outer_light_brightness,
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
    """Innenlicht — brightness + color effects via cmd=0x31 (verified 2026-05-25)."""

    _attr_translation_key = "inner_light"
    _attr_name = "Innenlicht"
    _attr_color_mode = ColorMode.BRIGHTNESS
    _attr_supported_color_modes = {ColorMode.BRIGHTNESS}
    _attr_effect_list = LIGHT_EFFECTS
    _attr_supported_features = LightEntityFeature.EFFECT

    def __init__(self, coordinator: SundanceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "light")

    @property
    def is_on(self) -> bool | None:
        return self.coordinator.data.get("light") if self.coordinator.data else None

    @property
    def brightness(self) -> int | None:
        if not self.is_on:
            return None
        return round(self.coordinator.inner_brightness / 100 * 255)

    @property
    def effect(self) -> str | None:
        return self.coordinator.light_effect

    async def async_turn_on(self, **kwargs) -> None:
        effect = kwargs.get(ATTR_EFFECT)
        brightness_ha = kwargs.get(ATTR_BRIGHTNESS)

        # On this spa (880) ONLY cmd 0x29 powers the light on; cmd 0x31 merely
        # adjusts colour/brightness of an already-on light and does NOT switch it
        # on (verified on live RS-485 2026-06-22). 0x29-ON is a discrete frame
        # (d1=0x93), so re-sending it when already on is harmless — we send it
        # unconditionally instead of trusting a possibly-stale is_on.
        await self.coordinator.send_command(build_light_on())
        if effect or brightness_ha is not None:
            await asyncio.sleep(_COLOR_DELAY)

        if effect:
            if effect == "Rainbow":
                await self.coordinator.send_command(build_inner_light_rainbow())
            else:
                await self.coordinator.send_command(build_inner_light_color(effect))
            self.coordinator.light_effect = effect

        if brightness_ha is not None:
            pct = round(brightness_ha / 255 * 100)
            await self.coordinator.send_command(build_inner_light_brightness(pct))
            self.coordinator.inner_brightness = pct
            if not effect:
                self.coordinator.light_effect = None

        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        # cmd 0x29-OFF (d1=0x13) is the only working OFF on this spa. Sent
        # unconditionally: the old `if self.is_on` guard read a stale frozen
        # state when the reader had died and silently dropped the command —
        # that was the "Aus schaltet nicht aus" bug (verified 2026-06-22).
        await self.coordinator.send_command(build_light_off())
        self.coordinator.light_effect = None
        self.async_write_ha_state()


class SundanceOuterLight(SundanceEntity, LightEntity):
    """Außenlicht — brightness control via cmd=0x31 d1=0x82 (verified 2026-05-25).

    State is NOT in the Balboa status frame; tracked optimistically in coordinator.
    """

    _attr_translation_key = "outer_light"
    _attr_name = "Außenlicht"
    _attr_color_mode = ColorMode.BRIGHTNESS
    _attr_supported_color_modes = {ColorMode.BRIGHTNESS}

    def __init__(self, coordinator: SundanceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "light2")

    @property
    def is_on(self) -> bool | None:
        return self.coordinator.light2_on

    @property
    def brightness(self) -> int | None:
        if not self.coordinator.light2_on:
            return None
        return round(self.coordinator.outer_brightness / 100 * 255)

    async def async_turn_on(self, **kwargs) -> None:
        brightness_ha = kwargs.get(ATTR_BRIGHTNESS)
        pct = round(brightness_ha / 255 * 100) if brightness_ha is not None else (self.coordinator.outer_brightness or 100)
        await self.coordinator.send_command(build_outer_light_brightness(pct))
        self.coordinator.outer_brightness = pct
        self.coordinator.light2_on = True
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs) -> None:
        if self.coordinator.light2_on:
            await self.coordinator.send_command(build_light2_off())
            self.coordinator.light2_on = False
            self.async_write_ha_state()
