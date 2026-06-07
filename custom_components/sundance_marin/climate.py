"""Climate entity — temperature display and setpoint control."""
from __future__ import annotations

from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
    HVACMode,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .balboa import build_set_temp
from .const import DOMAIN
from .coordinator import SundanceCoordinator
from .entity import SundanceEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: SundanceCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([SundanceClimate(coordinator, entry)])


class SundanceClimate(SundanceEntity, ClimateEntity):
    """Climate entity representing the spa as a whole (temperature + heat mode)."""

    _attr_translation_key = "spa"
    _attr_name = None  # main entity — uses device name

    _attr_hvac_modes = [HVACMode.HEAT, HVACMode.OFF]
    _attr_supported_features = ClimateEntityFeature.TARGET_TEMPERATURE
    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_min_temp = 10.0
    _attr_max_temp = 40.0
    _attr_target_temperature_step = 0.5

    def __init__(self, coordinator: SundanceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "climate")

    @property
    def current_temperature(self) -> float | None:
        return self.coordinator.data.get("current_temp") if self.coordinator.data else None

    @property
    def target_temperature(self) -> float | None:
        return self.coordinator.data.get("set_temp") if self.coordinator.data else None

    @property
    def hvac_mode(self) -> HVACMode:
        if self.coordinator.data and self.coordinator.data.get("current_temp") is not None:
            return HVACMode.HEAT
        return HVACMode.OFF

    async def async_set_temperature(self, **kwargs) -> None:
        temp = kwargs.get("temperature")
        if temp is not None:
            await self.coordinator.send_command(build_set_temp(float(temp)))

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        # Spa cannot be turned off via command; OFF is display-only
        pass
