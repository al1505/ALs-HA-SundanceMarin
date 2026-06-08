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
  CURRENT_TEMP:  3,  // raw / 2 = °C;  0xFF = display off / not yet known
                     // Verified from live Sundance Marin trace 2026-05-21:
                     //   d[3]=0x4B → 75/2=37.5°C matched actual spa temp.
                     //   (NOT d[2] as some sources claim; d[2] is always 0 on this unit)
  // HEATING:  no reliable status bit found yet.
  //   d[10] bits 4-5 → always 0 on this unit (not the heating byte).
  //   d[5] bits 4-5 → seem permanently set in normal operation (not heating).
  //   Heating is now computed from temperature comparison: currentTemp < setTemp.
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
  LIGHT:        13,  // non-zero → Innenlicht an via PHYSICAL button
                     //   Verified: 0xFF when inner light on ✓ (live trace 2026-05-21)
                     //   NOTE: SmartTub-controlled light does NOT change d[13] — use LIGHT_ST
  LIGHT_ST:     24,  // bit 2 (0x04) → Innenlicht an via SmartTub module
                     //   d[24]=2 (0x02) = off, d[24]=6 (0x06) = inner light on
                     //   Verified via injection test 2026-05-25 ✓
  MOTOR_FLAGS:  14,  // bit 1 + bit 6 = any pump/motor circuit active (NOT outer light!)
                     //   bits 2-3 → Gebläse (blower) speed non-zero → on
                     //   Verified (2026-05-23):
                     //     d[14]=0x00 → all motors off ✓
                     //     d[14]=0x42 → pump1 ON (outer light OFF!) — proves d[14]≠light2
                     //     d[14]=0x4E → gebläse ON ✓
  LIGHT2:        6,  // ⚠ NOT Außenlicht! d[6] bit3 correlates with circ pump speed, NOT outer light.
                     //   Confirmed 2026-05-25: injecting ON/OFF (cmd=0x31) leaves ALL d[] bytes unchanged.
                     //   Outer light state must be tracked in software (last command sent).
                     //   d[6]=0x02 → circ pump slow/off; d[6]=0x0A → circ pump fast — no light info here.
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

// Mode indices from d[15] bits 0-1 (Balboa "Ready"=0, "Rest"=1, "ReadyInRest"=2).
// Sundance 780 panel labels: Tag=0, Nacht=1, Smart=2, Aus=3.
// Corrected 2026-05-26: index 0 was 'Auto' (wrong — panel shows 'Tag'); added index 3 'Aus'.
const HEAT_MODE_NAMES = ['Tag', 'Nacht', 'Smart', 'Aus'];

// ─── Privileged RS-485 command frames ────────────────────────────────────────
//
// Captured via live RS-485 bus diff (2026-05-25): compare frames before vs. after
// SmartTub cloud trigger.  The SmartTub module sends commands with M1=0x11, M2=0xBF
// (its own RS-485 address).  The spa controller accepts these regardless of whether
// the physical panel is locked (Tastensperre / KeyLock).
//
// Frame format:  7E 07 11 BF 11 [balboa_code] [d2] [csum] 7E   (9 bytes)
// Toggle:  same frame turns ON when the device is OFF, and OFF when ON.
//          Verified for PUMP1 (ON→OFF→ON) and PUMP2 (ON→OFF).
//
// NOTE: these are raw byte buffers, NOT standard buildMessage() output.
//       The length-byte convention differs from 0x0A:0xBF frames (total = len+2
//       instead of len+3).  The parser (extractFrame) ignores them on RX — that
//       is intentional; we only SEND these frames, never parse them.
const PRIVILEGED_FRAMES = {
  PUMP1:    Buffer.from('7e0711bf110400087e', 'hex'),            // verified ON+OFF toggle
  PUMP2:    Buffer.from('7e0711bf1105cc777e', 'hex'),            // verified ON+OFF toggle
  BLOWER:   Buffer.from('7e0711bf110c1cf47e', 'hex'),            // verified status change in RS-485
  LIGHT_ON: Buffer.from('7e0911bf2993000500487e', 'hex'),        // Innenlicht EIN  (cmd=0x29 d1=0x93) ✓ 2026-05-25
  LIGHT_OFF: Buffer.from('7e0911bf2913000500797e', 'hex'),       // Innenlicht AUS  (cmd=0x29 d1=0x13) ✓ 2026-05-25
  LIGHT2_ON:  Buffer.from('7e0d11bf314382000000006400797e', 'hex'),  // Außenlicht EIN 100%  (cmd=0x31 d1=0x82 bright=100) ✓ Bus-Capture 2026-05-25
  LIGHT2_OFF: Buffer.from('7e0d11bf314382000000000000d87e', 'hex'),  // Außenlicht AUS      (cmd=0x31 d1=0x82 bright=0)   ✓ Injection-Test 2026-05-25
};

// ─── Checksum ────────────────────────────────────────────────────────────────

function calcChecksum(buf, start, end) {
  let sum = 0;
  for (let i = start; i < end; i++) sum = (sum + buf[i]) & 0xFF;
  return sum;
}

/**
 * CRC-8 for privileged SmartTub RS-485 frames (M1=0x11).
 * Discovered via brute-force 2026-05-25:
 *   poly=0x07, init=0xFF, ref_in=false, ref_out=false, xor_out=0xFF
 * Verified against 6 known frames (PUMP1, PUMP2, BLOWER, setTemp, LIGHT, LIGHT2).
 * Input: array of inner bytes — everything between the leading 0x7E and the CRC byte.
 */
function calcPrivilegedCrc(innerBytes) {
  let crc = 0xFF;
  for (const b of innerBytes) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x80) ? (((crc << 1) & 0xFF) ^ 0x07) : ((crc << 1) & 0xFF);
    }
  }
  return (crc ^ 0xFF) & 0xFF;
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

  // Heating: no reliable status bit found in the Sundance 780 frame.
  // Use temp-comparison heuristic: heater runs when currentTemp < setTemp.
  // This is accurate in steady state; may lag slightly at transitions.
  const heating = (rawTemp !== 0xFF) && (rawTemp < rawSet);

  return {
    currentTemp: rawTemp === 0xFF ? null : rawTemp / 2,
    setTemp:     rawSet / 2,
    heating,
    // clearray: status bit not yet identified — omitted until verified from live trace
    heatMode:    heatModeIdx,                               // 0/1/2/3
    heatModeName: HEAT_MODE_NAMES[heatModeIdx] || HEAT_MODE_NAMES[0],
    pump1:       (d[OFF.PUMPS] & 0x02) > 0,                 // bit 1 of d[12] (verified 2026-05-22)
    pump2:       ((d[OFF.PUMPS] >> 2) & 0x03) > 0,          // bits 2-3 of d[12] (verified 2026-05-22)
    circPump:    ((d[OFF.PUMP_STATUS] >> 3) & 0x03) > 0,    // bits 3-4 of d[11] (verified)
    blower:      ((d[OFF.MOTOR_FLAGS] >> 2) & 0x03) > 0,     // bits 2-3 of d[14] (gebläse speed)
    light:       (d[OFF.LIGHT_ST] & 0x04) !== 0 || d[OFF.LIGHT] !== 0, // d[24] bit2=SmartTub, d[13]=physical
    light2:      null,  // ⚠ NOT in status frame! cmd=0x31 outer light leaves no d[] trace (confirmed 2026-05-25).
                       //   web-server.js maintains _light2State (software state) and merges it here.
    raw: Array.from(d)   // always included for live debugging
  };
}

/**
 * Check if a frame is a status broadcast.
 */
function isStatusFrame(frame) {
  return frame && frame.length >= 4 && frame[2] === STATUS_M1 && frame[3] === STATUS_M2;
}

// ─── Inner light color indices (cmd=0x31, verified 2026-05-25) ────────────────
//
// SmartTub sends: 7E 0D 11 BF 31 [d0] [d1] [d2=colorIdx] 00 00 00 00 00 [crc] 7E
// d0=0x41 = Farbe setzen, d1=0x81 = Innenlicht EIN
// Farbindizes per Bus-Capture bestätigt (spa_fullcapture.py 2026-05-25):
const INNER_LIGHT_COLORS = {
  'Rot':        0x00,  // #EE4653 ✓
  'Grün':       0x02,  // #2ECAA3 ✓
  'Hellblau':   0x03,  // #37B5E8 ✓
  'Dunkelblau': 0x04,  // #4C8CEE ✓
  'Violett':    0x05,  // #B25CBD ✓
  'Gelb':       0x07,  // #F2BE48 ✓
};

// ─── DEPRECATED: M1=0x54 color payloads ──────────────────────────────────────
// These are RESPONSE frames from the light controller, not control frames.
// Use buildInnerLightColor() / buildInnerLightBrightness() instead.
// Kept for reference only.
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
 * Build a privileged set-temperature command (M1=0x11, bypasses panel lock).
 * Frame format: 7E 06 11 BF 20 [raw] [crc8] 7E
 * Captured from SmartTub RS-485 trace 2026-05-25; CRC-8 verified.
 * @param {number} tempC — target temperature in °C (0.5 steps, 10–42°C)
 * @returns {Buffer}
 */
function buildPrivilegedSetTempCommand(tempC) {
  const raw = Math.max(20, Math.min(84, Math.round(tempC * 2)));
  // inner = len_byte + M1 + M2 + cmd + temp_raw
  // len_byte = total_frame - 2 = (1+5+1+1) - 2 = 6 = 0x06
  const inner = [0x06, 0x11, 0xBF, 0x20, raw];
  const crc = calcPrivilegedCrc(inner);
  return Buffer.from([0x7E, ...inner, crc, 0x7E]);
}

/**
 * Build the correct privileged light command based on current state.
 * Uses cmd=0x29 frames verified 2026-05-25.
 * @param {boolean} currentlyOn — true if the inner light is currently ON
 * @returns {Buffer} — sends LIGHT_ON to turn on, LIGHT_OFF to turn off
 */
function buildPrivilegedLightToggle(currentlyOn) {
  return currentlyOn ? PRIVILEGED_FRAMES.LIGHT_OFF : PRIVILEGED_FRAMES.LIGHT_ON;
}

/**
 * Build the correct privileged light2 command based on current state.
 * @param {boolean} currentlyOn — true if the outer light is currently ON
 * @returns {Buffer}
 */
function buildPrivilegedLight2Toggle(currentlyOn) {
  return currentlyOn ? PRIVILEGED_FRAMES.LIGHT2_OFF : PRIVILEGED_FRAMES.LIGHT2_ON;
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
 * Build a privileged toggle command for a named spa item.
 *
 * Uses the SmartTub RS-485 module frames (M1=0x11, M2=0xBF) which bypass
 * the Tastensperre (physical panel lock).  Falls back to the standard
 * buildToggleCommand for items that don't yet have a captured privileged frame
 * (LIGHT, LIGHT2 — those aren't affected by Tastensperre in practice).
 *
 * @param {string} itemName — key from ITEMS (e.g. 'PUMP1', 'LIGHT')
 * @returns {Buffer}
 */
function buildPrivilegedToggleCommand(itemName) {
  const frame = PRIVILEGED_FRAMES[itemName];
  if (frame) return frame;
  // Fall back to standard 0x0A:0xBF toggle for items without a captured privileged frame.
  return buildToggleCommand(itemName);
}

/**
 * Build a cmd=0x31 inner/outer light frame (SmartTub M1=0x11 style).
 * Frame: 7E 0D 11 BF 31 [d0] [d1] [d2] 00 00 00 [bright] 00 [crc] 7E
 * @private
 */
function _buildCmd31(d0, d1, d2, bright) {
  // Frame: 7E [0D] [11] [BF] [31] d0 d1 d2 d3=00 d4=00 d5=00 d6=bright d7=00 [crc] 7E
  const inner = [0x0D, 0x11, 0xBF, 0x31, d0, d1, d2, 0x00, 0x00, 0x00, bright, 0x00];
  const crc = calcPrivilegedCrc(inner);
  return Buffer.from([0x7E, ...inner, crc, 0x7E]);
}

/**
 * Set inner light color by name.
 * Sends cmd=0x31 d0=0x41 (Farbe) — ✓ verified 2026-05-25.
 * @param {string} colorName — key from INNER_LIGHT_COLORS
 * @returns {Buffer}
 */
function buildInnerLightColor(colorName) {
  const idx = INNER_LIGHT_COLORS[colorName];
  if (idx === undefined) throw new Error(`Unbekannte Lichtfarbe: ${colorName}`);
  return _buildCmd31(0x41, 0x81, idx, 0x00);
}

/**
 * Set inner light brightness (0–100 %).
 * Sends cmd=0x31 d0=0x43 (Helligkeit) — ✓ verified 2026-05-25.
 * brightness=0 turns the light off (same as buildInnerLightOff).
 * @param {number} brightnessPercent — 0 to 100
 * @returns {Buffer}
 */
function buildInnerLightBrightness(brightnessPercent) {
  const bright = Math.round(Math.max(0, Math.min(100, brightnessPercent)));
  return _buildCmd31(0x43, 0x81, 0x00, bright);
}

/**
 * Turn inner light off (brightness = 0).
 * ✓ verified 2026-05-25: frame 7e0d11bf314381000000000000be7e
 * @returns {Buffer}
 */
function buildInnerLightOff() {
  return buildInnerLightBrightness(0);
}

/**
 * Activate inner light Rainbow mode.
 * Sends cmd=0x31 d0=0x42 — ✓ verified 2026-05-25.
 * @returns {Buffer}
 */
function buildInnerLightRainbow() {
  return _buildCmd31(0x42, 0x81, 0x00, 0x00);
}

/**
 * Set outer light brightness (0–100 %).
 * Sends cmd=0x31 d0=0x43 d1=0x82 (Außenlicht) — ✓ ON100% verified 2026-05-25.
 * brightness=0 turns the outer light off.
 * @param {number} brightnessPercent — 0 to 100
 * @returns {Buffer}
 */
function buildOuterLightBrightness(brightnessPercent) {
  const bright = Math.round(Math.max(0, Math.min(100, brightnessPercent)));
  return _buildCmd31(0x43, 0x82, 0x00, bright);
}

/**
 * Turn outer light off (brightness = 0).
 * ⚠ Frame calculated, not yet injection-tested: 7e0d11bf314382000000000000d87e
 * @returns {Buffer}
 */
function buildOuterLightOff() {
  return buildOuterLightBrightness(0);
}

/**
 * @deprecated Use buildInnerLightColor() instead.
 * Old M1=0x54 frames are controller RESPONSES, not commands.
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
  buildPrivilegedSetTempCommand,
  buildToggleCommand,
  buildPrivilegedToggleCommand,
  buildPrivilegedLightToggle,
  buildPrivilegedLight2Toggle,
  // Inner light cmd=0x31 (verified 2026-05-25)
  buildInnerLightColor,
  buildInnerLightBrightness,
  buildInnerLightOff,
  buildInnerLightRainbow,
  // Outer light cmd=0x31 (ON verified; OFF calculated)
  buildOuterLightBrightness,
  buildOuterLightOff,
  // Deprecated
  buildLightColorCommand,
  buildMessage,
  calcPrivilegedCrc,
  ITEMS,
  PRIVILEGED_FRAMES,
  INNER_LIGHT_COLORS,
  COLOR_PAYLOADS,
  OFF,
  HEAT_MODE_NAMES,
  STATUS_M1,
  STATUS_M2
};
