"""Switch entities — Düse 1, Düse 2, Gebläse."""
from __future__ import annotations

from dataclasses import dataclass

from homeassistant.components.switch import SwitchEntity, SwitchEntityDescription
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .balboa import build_toggle
from .const import DOMAIN
from .coordinator import SundanceCoordinator
from .entity import SundanceEntity


@dataclass(frozen=True)
class SundanceSwitchDescription(SwitchEntityDescription):
    toggle_item: str = ""
    data_key: str = ""


_SWITCHES: tuple[SundanceSwitchDescription, ...] = (
    SundanceSwitchDescription(
        key="pump1",
        translation_key="pump1",
        name="Düse 1",
        toggle_item="PUMP1",
        data_key="pump1",
    ),
    SundanceSwitchDescription(
        key="pump2",
        translation_key="pump2",
        name="Düse 2",
        toggle_item="PUMP2",
        data_key="pump2",
    ),
    SundanceSwitchDescription(
        key="blower",
        translation_key="blower",
        name="Gebläse",
        toggle_item="BLOWER",
        data_key="blower",
    ),
)


async def async_setup_entry(
    hass: HomeAssistant, entry: ConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    coordinator: SundanceCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [SundanceSwitch(coordinator, entry, desc) for desc in _SWITCHES]
    )


class SundanceSwitch(SundanceEntity, SwitchEntity):
    """Switch entity for spa items that support toggle commands."""

    entity_description: SundanceSwitchDescription

    def __init__(
        self,
        coordinator: SundanceCoordinator,
        entry: ConfigEntry,
        description: SundanceSwitchDescription,
    ) -> None:
        super().__init__(coordinator, entry, description.key)
        self.entity_description = description

    @property
    def is_on(self) -> bool | None:
        return self.coordinator.data.get(self.entity_description.data_key) if self.coordinator.data else None

    async def async_turn_on(self, **kwargs) -> None:
        if not self.is_on:
            self.coordinator.set_optimistic(self.entity_description.data_key, True)
            await self.coordinator.send_command(
                build_toggle(self.entity_description.toggle_item)
            )

    async def async_turn_off(self, **kwargs) -> None:
        if self.is_on:
            self.coordinator.set_optimistic(self.entity_description.data_key, False)
            await self.coordinator.send_command(
                build_toggle(self.entity_description.toggle_item)
            )
