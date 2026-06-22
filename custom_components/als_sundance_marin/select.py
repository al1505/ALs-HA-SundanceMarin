"""Select entity — Heizmodus (Auto / Nacht / Tag), settable via cmd=0xD2."""
from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .balboa import build_set_heat_mode
from .const import DOMAIN, HEAT_MODE_OPTIONS, HEAT_MODE_VALUES
from .coordinator import SundanceCoordinator
from .entity import SundanceEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: SundanceCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([SundanceHeatMode(coordinator, entry)])


class SundanceHeatMode(SundanceEntity, SelectEntity):
    """Spa heat mode (Auto / Nacht / Tag).

    State comes from status frame d[6] & 0x03; setting sends the privileged
    cmd=0xD2 frame (verified live on the 880 2026-06-22). The SmartTub "Smart"
    schedule overlay is not a d[6] value and is intentionally not exposed.
    """

    _attr_translation_key = "heat_mode"
    _attr_name = "Heizmodus"
    _attr_options = HEAT_MODE_OPTIONS

    def __init__(self, coordinator: SundanceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "heat_mode")

    @property
    def current_option(self) -> str | None:
        if not self.coordinator.data:
            return None
        return self.coordinator.data.get("heat_mode_name")

    async def async_select_option(self, option: str) -> None:
        value = HEAT_MODE_VALUES.get(option)
        if value is None:
            return
        self.coordinator.set_optimistic("heat_mode_name", option)
        await self.coordinator.send_command(build_set_heat_mode(value))
