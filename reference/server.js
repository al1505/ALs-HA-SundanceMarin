'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   ALs-Sundance — main entry point

   Wires together:
     spa-client  → TCP/EW11 → Balboa frames
     mqtt-bridge → MQTT broker → Home Assistant Autodiscovery

   Command flow:
     HA → MQTT cmd-topic → server.js _handleCommand() → spa-client.sendCommand()
     Spa → TCP frame → spa-client → server.js _onStatus() → mqtt-bridge.publishState()
   ════════════════════════════════════════════════════════════════════════════ */

const cfg        = require('./src/config');
const spaClient  = require('./src/spa-client');
const mqttBridge = require('./src/mqtt-bridge');
const parser     = require('./src/balboa-parser');
const webServer  = require('./src/web-server');

// ─── Simple logger ────────────────────────────────────────────────────────────

const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const minLevel = LEVELS[cfg.logLevel] ?? LEVELS.info;

function makeLog(module) {
  const write = (level, dataOrMsg, msg) => {
    if ((LEVELS[level] ?? 99) < minLevel) return;
    const ts = new Date().toISOString();
    const data = (typeof dataOrMsg === 'object' && dataOrMsg !== null && !Array.isArray(dataOrMsg)) ? dataOrMsg : {};
    const message = msg || (typeof dataOrMsg === 'string' ? dataOrMsg : '');
    const line = JSON.stringify({ time: ts, level, module, msg: message, ...data });
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    trace: (d, m) => write('trace', d, m),
    debug: (d, m) => write('debug', d, m),
    info:  (d, m) => write('info',  d, m),
    warn:  (d, m) => write('warn',  d, m),
    error: (d, m) => write('error', d, m)
  };
}

const log = makeLog('server');
spaClient.setLogger(makeLog('spa'));
mqttBridge.setLogger(makeLog('mqtt'));
webServer.setLogger(makeLog('web'));

// Note: light effect state is managed inside mqtt-bridge (setLightEffect / _lightEffect)

// ─── Event wiring ─────────────────────────────────────────────────────────────

// Spa → MQTT: forward every parsed status frame, enriched with software light2 state
spaClient.onStatus(status => {
  const enriched = {
    ...status,
    light:            !!(status.light || webServer.getLightState()),  // merge software state
    light2:           webServer.getLight2State(),
    // Publish 0 when off so HA slider is at 0 (not stale 100%) — avoids HA re-enabling light
    light2Brightness: webServer.getLight2State() ? webServer.getLight2Brightness() : 0
  };
  webServer.pushStatus(status);        // web-server merges its own light state internally
  mqttBridge.publishState(enriched);   // mqtt-bridge gets the complete picture
});

// Spa connection → MQTT availability
spaClient.onConnection(online => {
  mqttBridge.setAvailability(online);
  if (!online) {
    log.warn('Spa TCP nicht verbunden — HA Entities unavailable');
  } else {
    log.info('Spa TCP verbunden — HA Entities available');
  }
});

// ─── Command handling ─────────────────────────────────────────────────────────

async function _handleCommand(topic, payload) {
  const { T } = mqttBridge;
  log.debug({ topic, payload }, 'Command empfangen');

  try {
    if (topic === T.setpointSet) {
      const tempC = parseFloat(payload);
      if (!isFinite(tempC) || tempC < 18.5 || tempC > 40) {
        log.warn({ payload }, 'Ungültige Zieltemperatur');
        return;
      }
      await spaClient.sendCommand(parser.buildPrivilegedSetTempCommand(tempC));
      log.info({ tempC }, 'Temperatur-Command gesendet');

    } else if (topic === T.jets1Set) {
      const current = spaClient.getStatus();
      const wantOn  = payload.toUpperCase() === 'ON';
      if (current && current.pump1 === wantOn) return; // already in desired state
      await spaClient.sendCommand(parser.buildPrivilegedToggleCommand('PUMP1'));
      log.info({ state: payload }, 'Düse 1 Toggle gesendet');

    } else if (topic === T.jets2Set) {
      const current = spaClient.getStatus();
      const wantOn  = payload.toUpperCase() === 'ON';
      if (current && current.pump2 === wantOn) return;
      await spaClient.sendCommand(parser.buildPrivilegedToggleCommand('PUMP2'));
      log.info({ state: payload }, 'Düse 2 Toggle gesendet');

    } else if (topic === T.blowerSet) {
      const current = spaClient.getStatus();
      const wantOn  = payload.toUpperCase() === 'ON';
      if (current && current.blower === wantOn) return;
      await spaClient.sendCommand(parser.buildPrivilegedToggleCommand('BLOWER'));
      log.info({ state: payload }, 'Gebläse Toggle gesendet');

    } else if (topic === T.lightSet) {
      const wantOn  = payload.toUpperCase() === 'ON';
      // Use software state — cmd=0x31 light does NOT update d[24] status byte
      const currentlyOn = webServer.getLightState();
      if (currentlyOn === wantOn) return; // already in desired state
      await spaClient.sendCommand(parser.buildPrivilegedLightToggle(currentlyOn));
      webServer.setLight(wantOn);
      log.info({ state: payload }, 'Innenlicht Toggle gesendet');

    } else if (topic === T.lightEffectSet) {
      // Use correct SmartTub cmd=0x31 frames (verified 2026-05-25)
      // NOTE: buildLightColorCommand() is DEPRECATED (M1=0x54 response frames — do not use!)
      // Guard: HA sometimes sends effect before ON — skip if light is still off
      if (!webServer.getLightState()) {
        mqttBridge.setLightEffect(payload, false);  // remember for HA state only
        log.debug({ effect: payload }, 'Innenlicht aus — Farbe gemerkt, kein RS-485 Command');
      } else {
        if (payload === 'Rainbow') {
          await spaClient.sendCommand(parser.buildInnerLightRainbow());
        } else {
          await spaClient.sendCommand(parser.buildInnerLightColor(payload));
        }
        mqttBridge.setLightEffect(payload, false);
        log.info({ effect: payload }, 'Innenlicht-Farbe gesendet');
      }

    } else if (topic === T.light2Set) {
      const wantOn = payload.toUpperCase() === 'ON';
      if (webServer.getLight2State() === wantOn) return; // already in desired state
      if (wantOn) {
        const bright = webServer.getLight2Brightness() || 100;
        await spaClient.sendCommand(parser.buildOuterLightBrightness(bright));
      } else {
        await spaClient.sendCommand(parser.buildOuterLightOff());
      }
      webServer.setLight2(wantOn);
      log.info({ state: payload, brightness: webServer.getLight2Brightness() }, 'Außenlicht gesendet');

    } else if (topic === T.light2BrightnessSet) {
      const bright = parseInt(payload, 10);
      if (!isFinite(bright) || bright < 0 || bright > 100) {
        log.warn({ payload }, 'Ungültige Außenlicht-Helligkeit');
        return;
      }
      if (bright === 0) {
        await spaClient.sendCommand(parser.buildOuterLightOff());
        webServer.setLight2(false, 0);
      } else {
        await spaClient.sendCommand(parser.buildOuterLightBrightness(bright));
        webServer.setLight2(true, bright);
      }
      log.info({ brightness: bright }, 'Außenlicht-Helligkeit gesendet');

    } else if (topic === T.heatModeSet) {
      // Heat mode toggling: Balboa cycles through modes via a specific toggle.
      // The exact item code for heat mode toggle needs to be verified from trace.
      // For now, log the request and skip command until confirmed.
      log.info({ mode: payload }, 'Heizmodus-Command (item code noch TBD — verify from trace)');

    } else if (topic === `${require('./src/config').mqtt || ''}` || topic.endsWith('/mode/set')) {
      // Climate mode: "heat" = no-op (spa always heats), "off" = not supported via Balboa
      log.debug({ payload }, 'Climate mode set (no-op)');
    }

  } catch (err) {
    log.error({ err: err.message, topic }, 'Command-Fehler');
  }
}

// ─── Startup ──────────────────────────────────────────────────────────────────

log.info({ version: '1.0.0', model: 'Sundance Marin', spa: cfg.spa, mqttHost: cfg.mqtt.host }, 'ALs-Sundance startet');

// Web remote panel on port 3001
webServer.init(spaClient.getStatus, spaClient.sendCommand, parser, mqttBridge);

// Connect MQTT first, then spa (we want autodiscovery up before first status)
mqttBridge.init(cfg.mqtt, _handleCommand);

// Small delay so MQTT connect + autodiscovery happens before first status publish
setTimeout(() => {
  spaClient.init(cfg.spa.host, cfg.spa.port);
}, 2000);

// ─── Graceful shutdown ────────────────────────────────────────────────────────

function _shutdown(sig) {
  log.info({ signal: sig }, 'Shutdown');
  mqttBridge.setAvailability(false);
  process.exit(0);
}
process.on('SIGTERM', () => _shutdown('SIGTERM'));
process.on('SIGINT',  () => _shutdown('SIGINT'));
