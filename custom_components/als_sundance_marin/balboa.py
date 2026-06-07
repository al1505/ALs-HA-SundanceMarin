"""Balboa M7 protocol — frame parsing and command building.

Ported from reference/balboa-parser.js.
Byte offsets verified against live RS-485 trace 2026-05-21/22/23.
"""
from __future__ import annotations

from .const import (
    STATUS_M1, STATUS_M2, MIN_STATUS_DLEN,
    OFF_CURRENT_TEMP, OFF_HEATING, OFF_PUMP_STATUS, OFF_PUMPS,
    OFF_LIGHT, OFF_MOTOR_FLAGS, OFF_LIGHT2, OFF_HEAT_MODE, OFF_SET_TEMP,
    HEAT_MODE_NAMES, TOGGLE_CODES, COLOR_PAYLOADS,
)


def extract_frame(buf: bytes) -> tuple[bytes | None, bytes]:
    """Extract the first complete Balboa frame from a raw TCP stream buffer.

    Returns (frame, remaining_buf). Returns (None, buf_from_first_marker)
    when no complete frame is available yet.
    Discards leading garbage bytes before the first 0x7E.
    """
    pos = 0
    while pos < len(buf):
        start = buf.find(0x7E, pos)
        if start == -1:
            return None, b""

        if len(buf) - start < 3:
            return None, buf[start:]

        length = buf[start + 1]
        if length < 3:
            pos = start + 1
            continue

        total = length + 3  # start-0x7E + len-byte + length bytes + end-0x7E
        if len(buf) - start < total:
            return None, buf[start:]

        if buf[start + total - 1] != 0x7E:
            pos = start + 1
            continue

        # Checksum verification intentionally skipped:
        # exact Balboa checksum variant for Sundance 780 differs between sources;
        # 82 valid frames were confirmed without checksum checks in live trace.
        return buf[start : start + total], buf[start + total :]

    return None, b""


def parse_status_frame(frame: bytes) -> dict | None:
    """Parse a Balboa status frame (M1=0xFF, M2=0xAF).

    Returns a dict with current spa state, or None for non-status / short frames.
    Only accepts the spa-pack main status frame (dlen >= 40).
    Shorter frames (dlen=27) come from topside panels and contain mostly zeros.
    """
    if len(frame) < 8:
        return None
    if frame[2] != STATUS_M1 or frame[3] != STATUS_M2:
        return None

    d = frame[4:-2]
    if len(d) < MIN_STATUS_DLEN:
        return None

    raw_temp = d[OFF_CURRENT_TEMP]
    raw_set  = d[OFF_SET_TEMP]
    heat_mode_idx = d[OFF_HEAT_MODE] & 0x03

    return {
        "current_temp": None if raw_temp == 0xFF else raw_temp / 2,
        "set_temp":     raw_set / 2,
        "heating":      bool(d[OFF_HEATING] & 0x30),
        "heat_mode":    heat_mode_idx,
        "heat_mode_name": HEAT_MODE_NAMES[heat_mode_idx],
        "pump1":        bool(d[OFF_PUMPS] & 0x02),
        "pump2":        bool((d[OFF_PUMPS] >> 2) & 0x03),
        "circ_pump":    bool((d[OFF_PUMP_STATUS] >> 3) & 0x03),
        "blower":       bool((d[OFF_MOTOR_FLAGS] >> 2) & 0x03),
        "light":        d[OFF_LIGHT] != 0,
        "light2":       bool(d[OFF_LIGHT2] & 0x08),
    }


def _build_message(m1: int, m2: int, payload: bytes) -> bytes:
    length = len(payload) + 3  # M1 + M2 + payload + csum
    body = bytes([length, m1, m2]) + payload
    csum = sum(body) & 0xFF
    return bytes([0x7E]) + body + bytes([csum, 0x7E])


def build_toggle(item: str) -> bytes:
    """Build a toggle command for the named spa item (PUMP1, PUMP2, BLOWER, LIGHT, LIGHT2)."""
    code = TOGGLE_CODES[item]
    return _build_message(0x0A, 0xBF, bytes([0x07, code]))


def build_set_temp(temp_c: float) -> bytes:
    """Build a set-temperature command. Clamped to 10–42 °C (raw 20–84)."""
    raw = max(20, min(84, round(temp_c * 2)))
    return _build_message(0x0A, 0xBF, bytes([0x20, raw]))


def build_color(color_name: str) -> bytes:
    """Build a light color command (M1=0x54 M2=0xBF) from live-captured payloads."""
    payload = COLOR_PAYLOADS[color_name]
    return _build_message(0x54, 0xBF, payload)
