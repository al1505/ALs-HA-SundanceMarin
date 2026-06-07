"""Shared base entity class for all Sundance Marin entities."""
from __future__ import annotations

from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import SundanceCoordinator


class SundanceEntity(CoordinatorEntity[SundanceCoordinator]):
    """Base entity: binds to SundanceCoordinator and shares a single Device."""

    _attr_has_entity_name = True

    def __init__(
        self,
        coordinator: SundanceCoordinator,
        entry: ConfigEntry,
        key: str,
    ) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"als_sundance_{key}"
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, "als_sundance_880")},
            name="ALs Sundance Marin 880",
            model="Sundance Marin 780",
            manufacturer="Sundance Spas / Balboa",
            configuration_url=f"http://{coordinator.host}",
        )
