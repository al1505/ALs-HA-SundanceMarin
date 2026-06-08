"""Balboa M7 protocol — frame parsing and command building.

Ported from reference/balboa-parser.js.
Byte offsets verified against live RS-485 trace 2026-05-21/22/23/25.

IMPORTANT: All commands use privileged M1=0x11 frames (SmartTub RS-485 address).
These bypass the Tastensperre (panel lock) and are the only frames the spa accepts.
Standard M1=0x0A panel frames are silently ignored by this spa.
"""
from __future__ import annotations

from .const import (
    STATUS_M1, STATUS_M2, MIN_STATUS_DLEN,
    OFF_CURRENT_TEMP, OFF_HEATING, OFF_PUMP_STATUS, OFF_PUMPS,
    OFF_LIGHT, OFF_LIGHT_ST, OFF_MOTOR_FLAGS, OFF_HEAT_MODE, OFF_SET_TEMP,
    HEAT_MODE_NAMES,
)

# ── Privileged command frames (M1=0x11, verified 2026-05-25) ─────────────────
# Frame format differs from 0x0A:0xBF: total = len+2 (not len+3).
# These are SEND-only; extract_frame will not parse them on receive.

PRIVILEGED_FRAMES: dict[str, bytes] = {
    "PUMP1":  bytes.fromhex("7e0711bf110400087e"),   # verified ON+OFF toggle
    "PUMP2":  bytes.fromhex("7e0711bf1105cc777e"),   # verified ON+OFF toggle
    "BLOWER": bytes.fromhex("7e0711bf110c1cf47e"),   # verified
}

LIGHT_ON_FRAME   = bytes.fromhex("7e0911bf2993000500487e")            # cmd=0x29 d1=0x93 ✓
LIGHT_OFF_FRAME  = bytes.fromhex("7e0911bf2913000500797e")            # cmd=0x29 d1=0x13 ✓
LIGHT2_ON_FRAME  = bytes.fromhex("7e0d11bf314382000000006400797e")    # outer light ON 100% ✓
LIGHT2_OFF_FRAME = bytes.fromhex("7e0d11bf314382000000000000d87e")    # outer light OFF ✓

INNER_LIGHT_COLORS: dict[str, int] = {
    "Rot":        0x00,
    "Grün":       0x02,
    "Hellblau":   0x03,
    "Dunkelblau": 0x04,
    "Violett":    0x05,
    "Gelb":       0x07,
}


# ── CRC-8 for privileged frames ───────────────────────────────────────────────
# poly=0x07, init=0xFF, refIn=false, refOut=false, xorOut=0xFF
# Verified against 6 known frames (2026-05-25).

def _crc8_privileged(inner_bytes: bytes) -> int:
    crc = 0xFF
    for b in inner_bytes:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) & 0xFF) ^ 0x07 if (crc & 0x80) else (crc << 1) & 0xFF
    return (crc ^ 0xFF) & 0xFF


# ── cmd=0x31 frame builder (inner/outer light color/brightness) ───────────────

def _build_cmd31(d0: int, d1: int, d2: int, bright: int) -> bytes:
    inner = bytes([0x0D, 0x11, 0xBF, 0x31, d0, d1, d2, 0x00, 0x00, 0x00, bright, 0x00])
    return bytes([0x7E]) + inner + bytes([_crc8_privileged(inner), 0x7E])


# ── Frame extraction ──────────────────────────────────────────────────────────

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

        return buf[start : start + total], buf[start + total :]

    return None, b""


# ── Status frame parsing ──────────────────────────────────────────────────────

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

    # Heating heuristic: no reliable status bit in Sundance 780 frame.
    heating = (raw_temp != 0xFF) and (raw_temp < raw_set)

    # Inner light: d[OFF_LIGHT_ST] bit2 = SmartTub cmd=0x31; d[OFF_LIGHT] != 0 = physical button
    light_on = ((d[OFF_LIGHT_ST] & 0x04) != 0) or (d[OFF_LIGHT] != 0)

    return {
        "current_temp": None if raw_temp == 0xFF else raw_temp / 2,
        "set_temp":     raw_set / 2,
        "heating":      heating,
        "heat_mode":    heat_mode_idx,
        "heat_mode_name": HEAT_MODE_NAMES[heat_mode_idx],
        "pump1":        bool(d[OFF_PUMPS] & 0x02),
        "pump2":        bool((d[OFF_PUMPS] >> 2) & 0x03),
        "circ_pump":    bool((d[OFF_PUMP_STATUS] >> 3) & 0x03),
        "blower":       bool((d[OFF_MOTOR_FLAGS] >> 2) & 0x03),
        "light":        light_on,
        # light2 is not in the status frame; coordinator tracks it as optimistic state
    }


# ── Command builders ──────────────────────────────────────────────────────────

def build_toggle(item: str) -> bytes:
    """Build a privileged toggle command (M1=0x11) for PUMP1, PUMP2, or BLOWER."""
    return PRIVILEGED_FRAMES[item]


def build_set_temp(temp_c: float) -> bytes:
    """Build a privileged set-temperature command (M1=0x11, CRC-8)."""
    raw = max(20, min(84, round(temp_c * 2)))
    inner = bytes([0x06, 0x11, 0xBF, 0x20, raw])
    return bytes([0x7E]) + inner + bytes([_crc8_privileged(inner), 0x7E])


def build_light_on() -> bytes:
    """Turn inner light ON (cmd=0x29, verified 2026-05-25)."""
    return LIGHT_ON_FRAME


def build_light_off() -> bytes:
    """Turn inner light OFF (cmd=0x29, verified 2026-05-25)."""
    return LIGHT_OFF_FRAME


def build_light2_on() -> bytes:
    """Turn outer light ON at 100% brightness (cmd=0x31, verified 2026-05-25)."""
    return LIGHT2_ON_FRAME


def build_light2_off() -> bytes:
    """Turn outer light OFF (cmd=0x31, verified 2026-05-25)."""
    return LIGHT2_OFF_FRAME


def build_inner_light_color(color_name: str) -> bytes:
    """Set inner light color by name (cmd=0x31 d0=0x41, verified 2026-05-25)."""
    idx = INNER_LIGHT_COLORS[color_name]
    return _build_cmd31(0x41, 0x81, idx, 0x00)


def build_inner_light_rainbow() -> bytes:
    """Activate inner light rainbow mode (cmd=0x31 d0=0x42, verified 2026-05-25)."""
    return _build_cmd31(0x42, 0x81, 0x00, 0x00)


def build_inner_light_brightness(brightness_pct: int) -> bytes:
    """Set inner light brightness 0–100 % (cmd=0x31 d0=0x43, verified 2026-05-25).

    brightness_pct=0 turns the light off (frame 7e0d11bf314381000000000000be7e ✓).
    """
    bright = max(0, min(100, round(brightness_pct)))
    return _build_cmd31(0x43, 0x81, 0x00, bright)


def build_outer_light_brightness(brightness_pct: int) -> bytes:
    """Set outer light brightness 0–100 % (cmd=0x31 d0=0x43 d1=0x82, verified 2026-05-25).

    brightness_pct=100 → frame 7e0d11bf314382000000006400797e ✓ (same as LIGHT2_ON_FRAME).
    brightness_pct=0   → frame 7e0d11bf314382000000000000d87e ✓ (same as LIGHT2_OFF_FRAME).
    """
    bright = max(0, min(100, round(brightness_pct)))
    return _build_cmd31(0x43, 0x82, 0x00, bright)
