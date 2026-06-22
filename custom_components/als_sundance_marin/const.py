DOMAIN = "als_sundance_marin"

DEFAULT_HOST = "192.168.3.128"
DEFAULT_PORT = 8899

# Bus-Arbitration: minimum gap between sent commands
MIN_CMD_INTERVAL = 0.5  # seconds

# Reconnect: if no frame received for this long, close and reconnect
WATCHDOG_TIMEOUT = 60  # seconds

# Balboa status frame identifiers
STATUS_M1 = 0xFF
STATUS_M2 = 0xAF

# Minimum data-byte count to accept a frame (spa pack = 45, topside panel = 27)
MIN_STATUS_DLEN = 40

# Byte offsets into d = frame[4:-2] — verified from live RS-485 trace 2026-05-21/22/23/25
OFF_CURRENT_TEMP = 3   # raw/2 = °C; 0xFF = display off / unknown
OFF_HEATING      = 10  # (unused — heating derived from temp comparison)
OFF_PUMP_STATUS  = 11  # bits 3-4 = circ pump speed (>0 → running)
OFF_PUMPS        = 12  # bit 1 = pump1; bits 2-3 = pump2 speed
OFF_LIGHT        = 13  # non-zero → Innenlicht on via physical button
OFF_LIGHT_ST     = 24  # bit 2 (0x04) → Innenlicht on via SmartTub cmd=0x31 (verified 2026-05-25)
OFF_MOTOR_FLAGS  = 14  # bits 2-3 = blower speed (>0 → on)
OFF_HEAT_MODE    = 6   # bits 0-1: 0=Auto, 1=Nacht, 2=Tag (verified live 880, 2026-06-22)
OFF_SET_TEMP     = 21  # raw/2 = °C

# Heat mode lives in status frame d[6] & 0x03 and is SET via cmd=0xD2 (privileged
# 0x11 frame, payload = mode value). Verified on the live 880 2026-06-22.
# ("Smart" in SmartTub is a schedule overlay, not a d[6] value — not exposed here.)
HEAT_MODE_NAMES = {0: "Auto", 1: "Nacht", 2: "Tag"}   # d[6]&3 -> display name
HEAT_MODE_VALUES = {name: val for val, name in HEAT_MODE_NAMES.items()}  # name -> d[6] value
HEAT_MODE_OPTIONS = ["Tag", "Nacht", "Auto"]          # dropdown order in HA

# Inner light color effects — verified from live RS-485 trace 2026-05-25
LIGHT_EFFECTS = ["Rot", "Grün", "Hellblau", "Dunkelblau", "Violett", "Gelb", "Rainbow"]

TOGGLE_CODES: dict[str, int] = {
    "PUMP1":  0x04,
    "PUMP2":  0x05,
    "BLOWER": 0x0C,
    "LIGHT":  0x11,
    "LIGHT2": 0x12,  # hypothesis — verify from live trace
}

# 27-byte payloads for M1=0x54 M2=0xBF color frames.
# Captured from live RS-485 trace 2026-05-21.
COLOR_PAYLOADS: dict[str, bytes] = {
    "Hellblau":   bytes([0x32, 0x01, 0x04, 0x00, 0x64, 0x00, 0x7F, 0x7F] + [0] * 18 + [0xD4]),
    "Grün":       bytes([0x32, 0x01, 0x03, 0x00, 0x32, 0x00, 0xFF, 0x00] + [0] * 18 + [0x38]),
    "Dunkelblau": bytes([0x32, 0x01, 0x05, 0x00, 0x32, 0x00, 0x00, 0xFF] + [0] * 18 + [0x1F]),
    "Gelb":       bytes([0x32, 0x01, 0x08, 0x00, 0x32, 0x7F, 0x7F, 0x00] + [0] * 18 + [0x5C]),
    "Violett":    bytes([0x32, 0x01, 0x06, 0x00, 0x32, 0x7F, 0x00, 0x7F] + [0] * 18 + [0x38]),
    "Rot":        bytes([0x32, 0x01, 0x01, 0x00, 0x32, 0xFF, 0x00, 0x00] + [0] * 18 + [0xA3]),
    "Rainbow":    bytes([0x32, 0x01, 0x10, 0x00, 0x64, 0xA4, 0x5A, 0x00] + [0] * 18 + [0x9D]),
}
