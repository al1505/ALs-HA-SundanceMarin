'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Balboa M7 Protocol Parser — Sundance 780 / Elfin EW11

   Frame format:
     0x7E  [len]  [M1]  [M2]  [data …]  [csum]  0x7E

   len  = bytes remaining after the len-byte (M1 + M2 + data + csum)
   csum = sum of all bytes from [len] through last [data] byte, mod 256

   BYTE OFFSETS (into "data" = frame.slice(4, frame.length-2)):
     Source: HyperActiveJ/SundanceJacuzzi_HomeAssistant_TCP_RS485 (Sundance 780)
             + ccutrer/balboa_worldwide_app (M7 reference)
     ⚠ VERIFY against live spa-test.js frame dump before relying on pump/light bits.
       Current temp (d[2]) and set temp (d[20]) are confirmed.
   ════════════════════════════════════════════════════════════════════════════ */

// Status frame type bytes
const STATUS_M1 = 0xFF;
const STATUS_M2 = 0xAF;

// Data-byte offsets (d = frame.slice(4, frame.length - 2))
const OFF = {
  CURRENT_TEMP: 3,   // raw / 2 = °C;  0xFF = display off / not yet known
                     // Verified from live Sundance Marin trace 2026-05-21:
                     //   d[3]=0x4B → 75/2=37.5°C matched actual spa temp.
                     //   (NOT d[2] as some sources claim; d[2] is always 0 on this unit)
  HEATING:      10,  // bits 4-5 non-zero → heating active
  PUMP_STATUS:  11,  // bits 3-4 = circ pump speed (0=off, >0=running)
                     //   bit  2   = unknown flag (always 1 when spa is on)
                     //   bits 0-1 = always 0 on Sundance Marin (pump1/2 are in PUMPS byte)
                     //   Verified (2026-05-22):
                     //     d[11]=0x1C=0b00011100 → circ ON  high speed (after midnight)
                     //     d[11]=0x14=0b00010100 → circ ON  lower speed (while pump1 active)
                     //     d[11]=0x04=0b00000100 → circ OFF (daytime rest)
  PUMPS:        12,  // bit 1       = pump1 on/off (Düse 1)
                     //   bits 2-3 = pump2 speed (Düse 2, 0=off, >0=on)
                     //   Verified (2026-05-22):
                     //     d[12]=0x02 → pump1 ON ✓
                     //     d[12]=0x08 → pump2 ON ✓
  LIGHT:        13,  // non-zero → Innenlicht an
                     //   Verified: 0xFF when inner light on ✓ (live trace 2026-05-21)
  MOTOR_FLAGS:  14,  // bit 1 + bit 6 = any pump/motor circuit active (NOT outer light!)
                     //   bits 2-3 → Gebläse (blower) speed non-zero → on
                     //   Verified (2026-05-23):
                     //     d[14]=0x00 → all motors off ✓
                     //     d[14]=0x42 → pump1 ON (outer light OFF!) — proves d[14]≠light2
                     //     d[14]=0x4E → gebläse ON ✓
  LIGHT2:        6,  // bit 3 (0x08) → Außenlicht an (hypothesis, pending dedicated trace)
                     //   d[6]=2 (0x02) → all off, outer light off ✓
                     //   d[6]=10 (0x0A) → outer light ON + circ ON (midnight 2026-05-22) ✓
                     //   d[6]=2 → pump1 ON, outer light OFF ✓ (bit 3 NOT set — no false positive)
  HEAT_MODE:    15,  // bits 0-1: 0=Ready(Auto), 1=Rest(Nacht), 2=ReadyInRest(Smart)
  SET_TEMP:     21   // raw / 2 = °C
                     // Verified from live trace: d[21]=0x4C → 76/2=38°C ✓
                     //   (NOT d[20] as some sources claim; d[20] is always 0 on this unit)
};

// Toggle-command item codes (0x0A 0xBF 0x07 [code] frame)
// Source: HyperActiveJ SundanceJacuzzi repo — verify CLEARRAY code from trace
const ITEMS = {
  PUMP1:    0x04,
  PUMP2:    0x05,
  BLOWER:   0x0C,
  LIGHT:    0x11,   // Innenlicht (confirmed toggle code)
  LIGHT2:   0x12,   // ⚠ Außenlicht — inferred from Balboa M7 convention; verify from live trace
  CLEARRAY: 0x1E    // ⚠ verify from live protocol trace
};

const HEAT_MODE_NAMES = ['Auto', 'Nacht', 'Smart'];

// ─── Checksum ────────────────────────────────────────────────────────────────

function calcChecksum(buf, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum = (sum + buf[i]) & 0xFF;
  return sum;
}

// ─── Frame extraction from raw stream ────────────────────────────────────────

/**
 * Extract the first complete Balboa frame from `buf`.
 * Returns { frame: Buffer, remaining: Buffer } or { frame: null, remaining: buf }
 * if no complete frame is present yet.
 * Silently discards leading garbage bytes before the first 0x7E.
 * Iterative (no recursion) to avoid stack overflows on long garbage streams.
 */
function extractFrame(buf) {
  let pos = 0;

  while (pos < buf.length) {
    // Find next 0x7E start marker
    const start = buf.indexOf(0x7E, pos);
    if (start === -1) return { frame: null, remaining: Buffer.alloc(0) };

    // Need at least 3 bytes: 0x7E + len + one more
    if (buf.length - start < 3) return { frame: null, remaining: buf.slice(start) };

    const len = buf[start + 1];
    if (len < 3) {
      // Degenerate len — skip this 0x7E
      pos = start + 1;
      continue;
    }

    // Total frame bytes: start-0x7E(1) + len-byte(1) + len(payload) + end-0x7E(1)
    const total = len + 3;
    if (buf.length - start < total) {
      // Not enough data yet — wait for more
      return { frame: null, remaining: buf.slice(start) };
    }

    // Verify end marker
    if (buf[start + total - 1] !== 0x7E) {
      pos = start + 1;
      continue;
    }

    // Valid frame found
    // NOTE: Checksum verification skipped — exact Balboa checksum variant for
    // Sundance 780 differs between sources. spa-test.js confirmed 82 valid frames
    // without checksum checks. Re-enable once formula is verified from trace.
    return {
      frame:     buf.slice(start, start + total),
      remaining: buf.slice(start + total)
    };
  }

  return { frame: null, remaining: Buffer.alloc(0) };
}

// ─── Status frame parsing ─────────────────────────────────────────────────────

/**
 * Parse a Balboa status frame (M1=0xFF, M2=0xAF).
 * @param {Buffer} frame — complete frame including start/end 0x7E
 * @returns {object|null} spa status object, or null on invalid frame
 */
function parseStatusFrame(frame) {
  if (!frame || frame.length < 8) return null;
  if (frame[2] !== STATUS_M1 || frame[3] !== STATUS_M2) return null;

  // data = bytes between [M1 M2] and [csum 0x7E]
  const d = frame.slice(4, frame.length - 2);
  // The Balboa RS-485 bus carries frames from multiple devices (spa pack + topside
  // panels). All use M1=0xFF M2=0xAF but differ in length:
  //   - Spa pack (main status): dlen=45  ← the one we want
  //   - Topside panel / secondary:  dlen=27  ← mostly zeros, would publish temp=0
  // Require dlen >= 40 to accept only the full spa-pack status frame.
  if (d.length < 40) return null;

  const rawTemp = d[OFF.CURRENT_TEMP];
  const rawSet  = d[OFF.SET_TEMP];
  const heatModeIdx = d[OFF.HEAT_MODE] & 0x03;

  return {
    currentTemp: rawTemp === 0xFF ? null : rawTemp / 2,
    setTemp:     rawSet / 2,
    heating:     (d[OFF.HEATING] & 0x30) !== 0,           // bits 4-5
    heatMode:    heatModeIdx,                              // 0/1/2
    heatModeName: HEAT_MODE_NAMES[heatModeIdx] || 'Auto',
    pump1:       (d[OFF.PUMPS] & 0x02) > 0,                 // bit 1 of d[12] (verified 2026-05-22)
    pump2:       ((d[OFF.PUMPS] >> 2) & 0x03) > 0,          // bits 2-3 of d[12] (verified 2026-05-22)
    circPump:    ((d[OFF.PUMP_STATUS] >> 3) & 0x03) > 0,    // bits 3-4 of d[11] (verified)
    blower:      ((d[OFF.MOTOR_FLAGS] >> 2) & 0x03) > 0,     // bits 2-3 of d[14] (gebläse speed)
    light:       d[OFF.LIGHT]  !== 0,                        // Innenlicht (d[13] ≠ 0 when on)
    light2:      (d[OFF.LIGHT2] & 0x08) !== 0,               // bit 3 of d[6] = Außenlicht (hypothesis 2026-05-23)
    raw: Array.from(d)   // always included for live debugging
  };
}

/**
 * Check if a frame is a status broadcast.
 */
function isStatusFrame(frame) {
  return frame && frame.length >= 4 && frame[2] === STATUS_M1 && frame[3] === STATUS_M2;
}

// ─── Light color command payloads ────────────────────────────────────────────

// 27-byte data payloads for M1=0x54 M2=0xBF color frames.
// Captured from live Sundance 780 RS-485 trace 2026-05-21.
// Format: 32 01 [code] [flag=00] [brightness] [R] [G] [B] [00×18] [inner_csum]
// Use buildLightColorCommand() to wrap in a proper Balboa frame.
const COLOR_PAYLOADS = {
  // code  bright  R     G     B     inner_csum
  'Hellblau':   [0x32,0x01,0x04,0x00,0x64,0x00,0x7F,0x7F,...Array(18).fill(0x00),0xD4],
  'Grün':       [0x32,0x01,0x03,0x00,0x32,0x00,0xFF,0x00,...Array(18).fill(0x00),0x38],
  'Dunkelblau': [0x32,0x01,0x05,0x00,0x32,0x00,0x00,0xFF,...Array(18).fill(0x00),0x1F],
  'Gelb':       [0x32,0x01,0x08,0x00,0x32,0x7F,0x7F,0x00,...Array(18).fill(0x00),0x5C],
  'Violett':    [0x32,0x01,0x06,0x00,0x32,0x7F,0x00,0x7F,...Array(18).fill(0x00),0x38],
  'Rot':        [0x32,0x01,0x01,0x00,0x32,0xFF,0x00,0x00,...Array(18).fill(0x00),0xA3],
  'Rainbow':    [0x32,0x01,0x10,0x00,0x64,0xA4,0x5A,0x00,...Array(18).fill(0x00),0x9D]
};

// ─── Command builders ─────────────────────────────────────────────────────────

/**
 * Build a complete Balboa frame from message type + payload bytes.
 * @param {number} m1
 * @param {number} m2
 * @param {number[]} payload
 * @returns {Buffer}
 */
function buildMessage(m1, m2, payload) {
  const len = payload.length + 3; // M1 + M2 + payload + csum
  const body = [len, m1, m2, ...payload];
  const csum = calcChecksum(Buffer.from(body), 0, body.length);
  return Buffer.from([0x7E, ...body, csum, 0x7E]);
}

/**
 * Build a set-temperature command.
 * @param {number} tempC — target temperature in °C (0.5 steps)
 * @returns {Buffer}
 */
function buildSetTempCommand(tempC) {
  const raw = Math.max(20, Math.min(84, Math.round(tempC * 2))); // 10–42 °C clamped
  return buildMessage(0x0A, 0xBF, [0x20, raw]);
}

/**
 * Build a toggle command for a named spa item.
 * @param {string} itemName — key from ITEMS (e.g. 'PUMP1', 'LIGHT')
 * @returns {Buffer}
 */
function buildToggleCommand(itemName) {
  const code = ITEMS[itemName];
  if (code === undefined) throw new Error(`Unbekannter Item-Name: ${itemName}`);
  return buildMessage(0x0A, 0xBF, [0x07, code]);
}

/**
 * Build a light color command (M1=0x54 M2=0xBF) for the given color name.
 * Payloads are exact bytes captured from live RS-485 trace 2026-05-21.
 * @param {string} colorName — key from COLOR_PAYLOADS (e.g. 'Hellblau', 'Rainbow')
 * @returns {Buffer} — complete 33-byte Balboa frame
 */
function buildLightColorCommand(colorName) {
  const payload = COLOR_PAYLOADS[colorName];
  if (!payload) throw new Error(`Unbekannte Lichtfarbe: ${colorName}`);
  return buildMessage(0x54, 0xBF, payload);
}

module.exports = {
  extractFrame,
  parseStatusFrame,
  isStatusFrame,
  buildSetTempCommand,
  buildToggleCommand,
  buildLightColorCommand,
  buildMessage,
  ITEMS,
  COLOR_PAYLOADS,
  OFF,
  HEAT_MODE_NAMES,
  STATUS_M1,
  STATUS_M2
};
