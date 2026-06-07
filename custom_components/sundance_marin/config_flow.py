"""Config Flow — UI-guided setup for Sundance Marin."""
from __future__ import annotations

import asyncio
import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.const import CONF_HOST, CONF_PORT

from .const import DEFAULT_HOST, DEFAULT_PORT, DOMAIN
from .balboa import extract_frame, parse_status_frame

_LOGGER = logging.getLogger(__name__)

_SCHEMA = vol.Schema(
    {
        vol.Required(CONF_HOST, default=DEFAULT_HOST): str,
        vol.Required(CONF_PORT, default=DEFAULT_PORT): int,
    }
)


async def _test_connection(host: str, port: int) -> str | None:
    """Try connecting and wait up to 5 s for one valid status frame.

    Returns None on success, or an error key string on failure.
    """
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=5
        )
    except (OSError, asyncio.TimeoutError):
        return "cannot_connect"

    buf = b""
    error: str | None = "timeout"
    try:
        async with asyncio.timeout(5):
            while True:
                chunk = await reader.read(4096)
                if not chunk:
                    return "cannot_connect"
                buf += chunk
                while True:
                    frame, buf = extract_frame(buf)
                    if frame is None:
                        break
                    if parse_status_frame(frame) is not None:
                        error = None
                        return None
    except asyncio.TimeoutError:
        pass
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass

    return error


class SundanceMarinConfigFlow(ConfigFlow, domain=DOMAIN):
    """Config flow for Sundance Marin."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            await self.async_set_unique_id(
                f"{user_input[CONF_HOST]}:{user_input[CONF_PORT]}"
            )
            self._abort_if_unique_id_configured()

            error_key = await _test_connection(user_input[CONF_HOST], user_input[CONF_PORT])
            if error_key:
                errors["base"] = error_key
            else:
                return self.async_create_entry(
                    title=f"Sundance Marin ({user_input[CONF_HOST]})",
                    data=user_input,
                )

        return self.async_show_form(
            step_id="user",
            data_schema=_SCHEMA,
            errors=errors,
        )
