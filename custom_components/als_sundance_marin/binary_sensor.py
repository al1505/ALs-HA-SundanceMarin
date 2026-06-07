"""Binary sensor entities — Heizstatus and Zirkulationspumpe."""
from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
    BinarySensorEntityDescription,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import SundanceCoordinator
from .entity import SundanceEntity


@dataclass(frozen=True)
class SundanceBinarySensorDescription(BinarySensorEntityDescription):
    data_key: str = ""


_SENSORS: tuple[SundanceBinarySensorDescription, ...] = (
    SundanceBinarySensorDescription(
        key="heating",
        translation_key="heating",
        name="Heizstatus",
        device_class=BinarySensorDeviceClass.HEAT,
        data_key="heating",
    ),
    SundanceBinarySensorDescription(
        key="circ_pump",
        translation_key="circ_pump",
        name="Zirkulationspumpe",
        device_class=BinarySensorDeviceClass.RUNNING,
        data_key="circ_pump",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: SundanceCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [SundanceBinarySensor(coordinator, entry, desc) for desc in _SENSORS]
    )


class SundanceBinarySensor(SundanceEntity, BinarySensorEntity):
    """Read-only binary sensor for spa status values."""

    entity_description: SundanceBinarySensorDescription

    def __init__(
        self,
        coordinator: SundanceCoordinator,
        entry: ConfigEntry,
        description: SundanceBinarySensorDescription,
    ) -> None:
        super().__init__(coordinator, entry, description.key)
        self.entity_description = description

    @property
    def is_on(self) -> bool | None:
        return self.coordinator.data.get(self.entity_description.data_key) if self.coordinator.data else None
