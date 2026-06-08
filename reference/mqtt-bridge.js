'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   MqttBridge — Home Assistant MQTT Autodiscovery + State/Command bridge

   Responsibilities:
     • Connect to MQTT broker with Last-Will-Testament (availability offline)
     • Publish HA autodiscovery configs on connect (retained)
     • Publish spa state after every status frame
     • Subscribe to command topics and forward to callback
     • Publish availability ("online" / "offline")
   ════════════════════════════════════════════════════════════════════════════ */

const mqtt = require('mqtt');
const parser = require('./balboa-parser');

// ─── Topic constants ──────────────────────────────────────────────────────────

const BASE      = 'spa/sundance';
const AVAIL     = `${BASE}/availability`;
const DISC_BASE = 'homeassistant';

const T = {
  availability:        AVAIL,
  temperature:         `${BASE}/temperature`,
  setpoint:            `${BASE}/setpoint`,
  setpointSet:         `${BASE}/setpoint/set`,
  mode:                `${BASE}/mode`,           // "heat" or "off"
  heating:             `${BASE}/heating`,
  heatMode:            `${BASE}/heat_mode`,
  heatModeSet:         `${BASE}/heat_mode/set`,
  jets1:               `${BASE}/jets1`,
  jets1Set:            `${BASE}/jets1/set`,
  jets2:               `${BASE}/jets2`,
  jets2Set:            `${BASE}/jets2/set`,
  blower:              `${BASE}/blower`,
  blowerSet:           `${BASE}/blower/set`,
  circPump:            `${BASE}/circ_pump`,
  light:               `${BASE}/light`,
  lightSet:            `${BASE}/light/set`,
  lightEffect:         `${BASE}/light_effect`,
  lightEffectSet:      `${BASE}/light_effect/set`,
  light2:              `${BASE}/light2`,
  light2Set:           `${BASE}/light2/set`,
  light2Brightness:    `${BASE}/light2_brightness`,     // 0-100 (software state)
  light2BrightnessSet: `${BASE}/light2_brightness/set`, // HA brightness command
  status:              `${BASE}/status`                 // full JSON snapshot
};

const DEVICE = {
  identifiers:  ['sundance_780'],
  name:         'Sundance 780 Spa',
  model:        'Sundance 780',
  manufacturer: 'Sundance Spas / Balboa'
};

// Exact effect names — must match COLOR_PAYLOADS keys in balboa-parser.js
const LIGHT_EFFECTS = ['Hellblau', 'Grün', 'Dunkelblau', 'Gelb', 'Violett', 'Rot', 'Rainbow'];

// ─── Module state ─────────────────────────────────────────────────────────────

let _client = null;
let _cmdCallback = null;
let _lightEffect  = null;   // optimistic effect state (no readback from spa)
let _light2Effect = null;

let log = {
  info:  (...a) => console.log('[mqtt]', ...a),
  warn:  (...a) => console.warn('[mqtt]', ...a),
  error: (...a) => console.error('[mqtt]', ...a),
  debug: (...a) => {}
};

function setLogger(l) { log = l; }

// ─── Init ─────────────────────────────────────────────────────────────────────

/**
 * Connect to MQTT broker. Publishes autodiscovery + subscribes to command topics.
 * @param {object} opts — { host, port, clientId, username?, password? }
 * @param {function} onCommand — callback(topic, payload_string)
 */
function init(opts, onCommand) {
  _cmdCallback = onCommand;

  const mqttOpts = {
    host:           opts.host,
    port:           opts.port,
    clientId:       opts.clientId || `als-sundance-${Date.now()}`,
    keepalive:      30,
    reconnectPeriod: 10_000,
    connectTimeout: 15_000,
    will: {
      topic:   AVAIL,
      payload: 'offline',
      qos:     1,
      retain:  true
    }
  };
  if (opts.username) { mqttOpts.username = opts.username; mqttOpts.password = opts.password || ''; }

  _client = mqtt.connect(mqttOpts);

  _client.on('connect', () => {
    log.info({ host: opts.host, port: opts.port }, 'MQTT verbunden');
    _publishDiscovery();
    _subscribeCommands();
    _publish(AVAIL, 'online', { retain: true });
  });

  _client.on('message', (topic, payload) => {
    if (_cmdCallback) {
      try { _cmdCallback(topic, payload.toString()); } catch {}
    }
  });

  _client.on('error', err => {
    log.warn({ err: err.message }, 'MQTT Fehler');
  });

  _client.on('close', () => {
    log.warn('MQTT getrennt');
  });
}

// ─── Light effect state ───────────────────────────────────────────────────────

/**
 * Update and immediately publish a light effect (optimistic — spa has no color readback).
 * @param {string} effect — one of LIGHT_EFFECTS
 * @param {boolean} outer — true = Außenlicht, false = Innenlicht
 */
function setLightEffect(effect, outer = false) {
  if (outer) {
    _light2Effect = effect;
    _publish(T.light2Effect, effect);
  } else {
    _lightEffect = effect;
    _publish(T.lightEffect, effect);
  }
}

// ─── Availability ─────────────────────────────────────────────────────────────

function setAvailability(online) {
  _publish(AVAIL, online ? 'online' : 'offline', { retain: true });
}

// ─── State publishing ─────────────────────────────────────────────────────────

/**
 * Publish all spa state topics from a parsed status object.
 * @param {object} status — from balboa-parser.parseStatusFrame()
 */
function publishState(status) {
  if (!status) return;

  const sw = v => v ? 'ON' : 'OFF';

  if (status.currentTemp !== null && status.currentTemp !== undefined) {
    _publish(T.temperature, String(status.currentTemp));
  }
  _publish(T.setpoint,     String(status.setTemp));
  _publish(T.heating,      sw(status.heating));
  _publish(T.heatMode,     status.heatModeName || 'Auto');
  _publish(T.jets1,        sw(status.pump1));
  _publish(T.jets2,        sw(status.pump2));
  _publish(T.blower,       sw(status.blower));
  _publish(T.circPump,          sw(status.circPump));
  _publish(T.light,             sw(status.light));
  _publish(T.light2,            sw(status.light2));   // software state, enriched by server.js
  _publish(T.light2Brightness,  String(status.light2Brightness != null ? status.light2Brightness : 100));
  _publish(T.mode,              (status.currentTemp !== null) ? 'heat' : 'off');
  // Re-publish last known inner-light effect (optimistic — spa has no color readback)
  if (_lightEffect) _publish(T.lightEffect, _lightEffect);

  // Full snapshot (for Ohmpilot-V3 / debugging)
  _publish(T.status, JSON.stringify({
    ts:               status.ts,
    currentTemp:      status.currentTemp,
    setTemp:          status.setTemp,
    heating:          status.heating,
    heatMode:         status.heatModeName,
    pump1:            status.pump1,
    pump2:            status.pump2,
    blower:           status.blower,
    light:            status.light,
    light2:           status.light2,
    light2Brightness: status.light2Brightness
  }));
}

// ─── Autodiscovery ────────────────────────────────────────────────────────────

function _publishDiscovery() {
  const disc = [
    // Climate (temperature control)
    ['climate', 'spa_temperature', {
      name:                       'Spa Temperatur',
      unique_id:                  'sundance_temperature',
      availability_topic:         AVAIL,
      current_temperature_topic:  T.temperature,
      temperature_command_topic:  T.setpointSet,
      temperature_state_topic:    T.setpoint,
      mode_state_topic:           T.mode,
      mode_command_topic:         `${BASE}/mode/set`,
      modes:                      ['off', 'heat'],
      min_temp:                   18.5,
      max_temp:                   40,
      temp_step:                  0.5,
      temperature_unit:           'C',
      device:                     DEVICE
    }],
    // Heat mode select
    ['select', 'spa_heat_mode', {
      name:            'Spa Heizmodus',
      unique_id:       'sundance_heat_mode',
      availability_topic: AVAIL,
      state_topic:     T.heatMode,
      command_topic:   T.heatModeSet,
      options:         parser.HEAT_MODE_NAMES,
      device:          DEVICE
    }],
    // Heating binary sensor
    ['binary_sensor', 'spa_heating', {
      name:             'Spa Heizstatus',
      unique_id:        'sundance_heating',
      availability_topic: AVAIL,
      state_topic:      T.heating,
      payload_on:       'ON',
      payload_off:      'OFF',
      device_class:     'heat',
      device:           DEVICE
    }],
    // Düse 1
    ['switch', 'spa_jets1', {
      name:            'Spa Düse 1',
      unique_id:       'sundance_jets1',
      availability_topic: AVAIL,
      state_topic:     T.jets1,
      command_topic:   T.jets1Set,
      payload_on:      'ON',
      payload_off:     'OFF',
      device:          DEVICE
    }],
    // Düse 2
    ['switch', 'spa_jets2', {
      name:            'Spa Düse 2',
      unique_id:       'sundance_jets2',
      availability_topic: AVAIL,
      state_topic:     T.jets2,
      command_topic:   T.jets2Set,
      payload_on:      'ON',
      payload_off:     'OFF',
      device:          DEVICE
    }],
    // Zirkulationspumpe (read-only binary sensor — runs continuously)
    ['binary_sensor', 'spa_circ_pump', {
      name:             'Spa Zirkulationspumpe',
      unique_id:        'sundance_circ_pump',
      availability_topic: AVAIL,
      state_topic:      T.circPump,
      payload_on:       'ON',
      payload_off:      'OFF',
      device_class:     'running',
      device:           DEVICE
    }],
    // Gebläse
    ['switch', 'spa_blower', {
      name:            'Spa Gebläse',
      unique_id:       'sundance_blower',
      availability_topic: AVAIL,
      state_topic:     T.blower,
      command_topic:   T.blowerSet,
      payload_on:      'ON',
      payload_off:     'OFF',
      device:          DEVICE
    }],
    // Innenlicht (inner light, color effects)
    ['light', 'spa_light', {
      name:                  'Spa Innenlicht',
      unique_id:             'sundance_light',
      availability_topic:    AVAIL,
      state_topic:           T.light,
      command_topic:         T.lightSet,
      payload_on:            'ON',
      payload_off:           'OFF',
      effect_state_topic:    T.lightEffect,
      effect_command_topic:  T.lightEffectSet,
      effect_list:           LIGHT_EFFECTS,
      device:                DEVICE
    }],
    // Außenlicht (outer white LED — brightness only, no color effects)
    ['light', 'spa_light_outer', {
      name:                     'Spa Außenlicht',
      unique_id:                'sundance_light2',
      availability_topic:       AVAIL,
      state_topic:              T.light2,
      command_topic:            T.light2Set,
      brightness_state_topic:   T.light2Brightness,
      brightness_command_topic: T.light2BrightnessSet,
      brightness_scale:         100,
      payload_on:               'ON',
      payload_off:              'OFF',
      device:                   DEVICE
    }]
  ];

  for (const [domain, objectId, config] of disc) {
    const topic = `${DISC_BASE}/${domain}/${objectId}/config`;
    _publish(topic, JSON.stringify(config), { retain: true });
  }

  log.info({ count: disc.length }, 'HA Autodiscovery publiziert');
}

// ─── Command subscriptions ────────────────────────────────────────────────────

function _subscribeCommands() {
  const cmdTopics = [
    T.setpointSet,
    T.heatModeSet,
    T.jets1Set,
    T.jets2Set,
    T.blowerSet,
    T.lightSet,
    T.lightEffectSet,
    T.light2Set,
    T.light2BrightnessSet,
    `${BASE}/mode/set`
  ];
  cmdTopics.forEach(t => _client.subscribe(t, { qos: 1 }, err => {
    if (err) log.warn({ topic: t, err: err.message }, 'Subscribe Fehler');
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _publish(topic, payload, opts = { qos: 0 }) {
  if (!_client || !_client.connected) return;
  _client.publish(topic, payload, opts);
}

function isConnected() {
  return _client && _client.connected;
}

module.exports = { init, setAvailability, publishState, setLightEffect, isConnected, setLogger, T, LIGHT_EFFECTS };
