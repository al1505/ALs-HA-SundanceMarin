"""Select entity — Heizmodus (read-only; no set command known)."""
from __future__ import annotations

from homeassistant.components.select import SelectEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN, HEAT_MODE_NAMES
from .coordinator import SundanceCoordinator
from .entity import SundanceEntity


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: SundanceCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([SundanceHeatMode(coordinator, entry)])


class SundanceHeatMode(SundanceEntity, SelectEntity):
    """Read-only select for the spa heat mode (Auto / Nacht / Smart).

    No set command is known for the Sundance Marin 780. The mode can only
    be changed via the physical topside panel. Calling select_option() has
    no effect and logs a warning.
    """

    _attr_translation_key = "heat_mode"
    _attr_name = "Heizmodus"
    _attr_options = HEAT_MODE_NAMES

    def __init__(self, coordinator: SundanceCoordinator, entry: ConfigEntry) -> None:
        super().__init__(coordinator, entry, "heat_mode")

    @property
    def current_option(self) -> str | None:
        if not self.coordinator.data:
            return None
        return self.coordinator.data.get("heat_mode_name")

    async def async_select_option(self, option: str) -> None:
        # No Balboa command known for changing heat mode remotely.
        # The mode must be changed via the physical topside panel.
        pass
