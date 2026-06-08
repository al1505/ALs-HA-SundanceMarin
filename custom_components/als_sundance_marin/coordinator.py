"""DataUpdateCoordinator for Sundance Marin — push-based TCP reader."""
from __future__ import annotations

import asyncio
import logging

from homeassistant.core import HomeAssistant
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator

from .balboa import extract_frame, parse_status_frame
from .const import DOMAIN, MIN_CMD_INTERVAL, WATCHDOG_TIMEOUT

_LOGGER = logging.getLogger(__name__)

_RECONNECT_DELAYS = [10, 20, 40, 60]  # exponential backoff caps at 60 s


class SundanceCoordinator(DataUpdateCoordinator[dict]):
    """Manages the TCP connection to the EW11 and distributes spa state to all entities.

    Push-based: the spa sends status frames every ~1-2 seconds on its own.
    update_interval=None — no polling; async_set_updated_data() notifies listeners.
    """

    def __init__(self, hass: HomeAssistant, host: str, port: int) -> None:
        super().__init__(hass, _LOGGER, name=DOMAIN, update_interval=None)
        self.host = host
        self.port = port
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._read_task: asyncio.Task | None = None
        self._cmd_lock = asyncio.Lock()
        self._last_cmd_at: float = 0.0
        self._buf = b""
        self._reconnect_attempt = 0
        self._first_data_event = asyncio.Event()
        # Optimistic state — not available in Balboa status frame
        self.light_effect: str | None = None   # inner light color
        self.light2_on: bool = False            # outer light (no status frame bit)

    # ── Connection ────────────────────────────────────────────────────────────

    async def async_connect(self) -> None:
        """Open TCP connection to EW11 and start the reader task."""
        self._reader, self._writer = await asyncio.open_connection(self.host, self.port)
        self._reconnect_attempt = 0
        self._read_task = self.hass.async_create_background_task(
            self._read_loop(), "sundance_marin_reader"
        )
        _LOGGER.info("Connected to EW11 at %s:%s", self.host, self.port)

    async def async_disconnect(self) -> None:
        """Close TCP connection and cancel reader task."""
        if self._read_task and not self._read_task.done():
            self._read_task.cancel()
        if self._writer:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass
        self._reader = None
        self._writer = None

    async def async_wait_for_first_data(self) -> None:
        """Wait until the first valid status frame has been parsed."""
        await self._first_data_event.wait()

    # ── Reader loop ───────────────────────────────────────────────────────────

    async def _read_loop(self) -> None:
        """Permanent background task: reads TCP stream and dispatches parsed frames."""
        self._buf = b""
        try:
            while True:
                try:
                    chunk = await asyncio.wait_for(
                        self._reader.read(4096), timeout=WATCHDOG_TIMEOUT
                    )
                except asyncio.TimeoutError:
                    _LOGGER.warning("Watchdog: no data for %ss — reconnecting", WATCHDOG_TIMEOUT)
                    break

                if not chunk:
                    _LOGGER.warning("EW11 closed connection — reconnecting")
                    break

                self._buf += chunk
                while True:
                    frame, self._buf = extract_frame(self._buf)
                    if frame is None:
                        break
                    status = parse_status_frame(frame)
                    if status:
                        self._first_data_event.set()
                        self.async_set_updated_data(status)

        except Exception as exc:  # noqa: BLE001
            _LOGGER.error("Reader error: %s — reconnecting", exc)

        await self._reconnect()

    async def _reconnect(self) -> None:
        """Close current connection and attempt to reconnect with backoff."""
        await self.async_disconnect()
        delay = _RECONNECT_DELAYS[min(self._reconnect_attempt, len(_RECONNECT_DELAYS) - 1)]
        self._reconnect_attempt += 1
        _LOGGER.info("Reconnecting in %ss (attempt %s)", delay, self._reconnect_attempt)
        await asyncio.sleep(delay)
        try:
            await self.async_connect()
        except OSError as exc:
            _LOGGER.error("Reconnect failed: %s", exc)
            await self._reconnect()

    # ── Command sending ───────────────────────────────────────────────────────

    async def send_command(self, frame: bytes) -> None:
        """Send a Balboa command frame with 500 ms bus-arbitration guard."""
        async with self._cmd_lock:
            if self._writer is None:
                _LOGGER.warning("send_command: writer is None — not connected")
                return
            elapsed = self.hass.loop.time() - self._last_cmd_at
            if elapsed < MIN_CMD_INTERVAL:
                await asyncio.sleep(MIN_CMD_INTERVAL - elapsed)
            _LOGGER.debug("TX: %s", frame.hex())
            try:
                self._writer.write(frame)
                await self._writer.drain()
            except Exception as exc:  # noqa: BLE001
                _LOGGER.error("send_command error: %s", exc)
            finally:
                self._last_cmd_at = self.hass.loop.time()
