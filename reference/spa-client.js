'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   SpaClient — TCP connection to Elfin EW11 RS485-WiFi bridge

   Responsibilities:
     • Maintain exactly one TCP socket to EW11 (only 1 connection allowed)
     • Reassemble raw byte stream into complete Balboa frames
     • Parse status frames and cache the latest spa state
     • Serialize outgoing commands (≥500 ms between sends, Balboa bus arbitration)
     • Exponential-backoff reconnect (10s → 20s → 40s → 60s cap)
     • Watchdog: no frame received in >60 s → destroy + reconnect
   ════════════════════════════════════════════════════════════════════════════ */

const net = require('net');
const parser = require('./balboa-parser');

const MIN_CMD_INTERVAL_MS = 500;
const WATCHDOG_TIMEOUT_MS = 60_000;
const RECONNECT_BASE_MS   = 10_000;
const RECONNECT_MAX_MS    = 60_000;

let _host = '192.168.3.128';
let _port = 8899;

let _socket = null;
let _raw    = Buffer.alloc(0);
let _connected = false;

// Last parsed spa status
let _status = null;
let _lastFrameAt = 0;
let _frameCount = 0;

// Command queue
const _cmdQueue = [];
let _cmdBusy = false;
let _lastCmdAt = 0;

// Reconnect state
let _reconnectTimer = null;
let _reconnectAttempts = 0;

// Watchdog
let _watchdogTimer = null;

// Event listeners
const _statusListeners = [];
const _connectionListeners = [];

// Logger shim — replaced by server.js via setLogger()
let log = {
  info:  (...a) => console.log('[spa]', ...a),
  warn:  (...a) => console.warn('[spa]', ...a),
  error: (...a) => console.error('[spa]', ...a),
  debug: (...a) => {}
};

function setLogger(l) { log = l; }

// ─── Public API ───────────────────────────────────────────────────────────────

function init(host, port) {
  _host = host;
  _port = port;
  _connect();
}

function isConnected() { return _connected; }
function getStatus()   { return _status; }
function getFrameCount() { return _frameCount; }

function onStatus(cb)     { _statusListeners.push(cb); }
function onConnection(cb) { _connectionListeners.push(cb); }

/**
 * Enqueue a command buffer to be sent to the spa.
 * Commands are sent serially with ≥500 ms spacing.
 * @param {Buffer} buf
 * @returns {Promise<void>} resolves when the command has been sent
 */
function sendCommand(buf) {
  return new Promise((resolve, reject) => {
    _cmdQueue.push({ buf, resolve, reject });
    _drainQueue();
  });
}

// ─── TCP connection ───────────────────────────────────────────────────────────

function _connect() {
  if (_socket) {
    try { _socket.destroy(); } catch {}
    _socket = null;
  }
  _connected = false;
  _raw = Buffer.alloc(0);

  log.info({ host: _host, port: _port, attempt: _reconnectAttempts + 1 }, 'SpaClient verbindet...');

  _socket = net.createConnection({ host: _host, port: _port });
  _socket.setTimeout(10_000); // connect timeout

  _socket.on('connect', _onConnect);
  _socket.on('data',    _onData);
  _socket.on('error',   _onError);
  _socket.on('close',   _onClose);
  _socket.on('timeout', () => {
    log.warn('SpaClient TCP timeout');
    _socket.destroy();
  });
}

function _onConnect() {
  log.info({ host: _host, port: _port }, 'SpaClient TCP verbunden');
  _connected = true;
  _reconnectAttempts = 0;
  _lastFrameAt = Date.now();
  _socket.setTimeout(0); // clear connect-timeout once connected
  _startWatchdog();
  _connectionListeners.forEach(cb => { try { cb(true); } catch {} });
}

function _onData(chunk) {
  _raw = Buffer.concat([_raw, chunk]);

  let result;
  while ((result = parser.extractFrame(_raw)) && result.frame) {
    _raw = result.remaining;
    _frameCount++;
    _lastFrameAt = Date.now();

    if (parser.isStatusFrame(result.frame)) {
      const status = parser.parseStatusFrame(result.frame);
      if (status) {
        _status = { ...status, ts: Date.now() };
        _statusListeners.forEach(cb => { try { cb(_status); } catch {} });
      }
    } else {
      // Non-status frames: log raw hex for trace/debugging
      log.debug({ hex: result.frame.toString('hex'), len: result.frame.length }, 'RX non-status frame');
    }
  }
}

function _onError(err) {
  log.warn({ err: err.message }, 'SpaClient TCP Fehler');
  _connected = false;
  _connectionListeners.forEach(cb => { try { cb(false); } catch {} });
}

function _onClose() {
  log.warn('SpaClient TCP getrennt');
  _connected = false;
  _connectionListeners.forEach(cb => { try { cb(false); } catch {} });
  _stopWatchdog();
  _scheduleReconnect();
}

// ─── Reconnect ────────────────────────────────────────────────────────────────

function _scheduleReconnect() {
  if (_reconnectTimer) return;
  _reconnectAttempts++;

  // Exponential backoff: 10s, 20s, 40s, 60s (cap)
  const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, _reconnectAttempts - 1), RECONNECT_MAX_MS);

  if (_reconnectAttempts >= 5) {
    log.warn({ attempt: _reconnectAttempts, delayMs: delay }, 'SpaClient: Wiederverbindung weiter geplant');
  } else {
    log.info({ attempt: _reconnectAttempts, delayMs: delay }, 'SpaClient Reconnect geplant');
  }

  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    _connect();
  }, delay);
}

// ─── Watchdog ─────────────────────────────────────────────────────────────────

function _startWatchdog() {
  _stopWatchdog();
  _watchdogTimer = setInterval(() => {
    if (!_connected) return;
    const age = Date.now() - _lastFrameAt;
    if (age > WATCHDOG_TIMEOUT_MS) {
      log.warn({ ageSec: Math.round(age / 1000) }, 'SpaClient Watchdog: kein Frame seit >60s — Reconnect');
      _socket.destroy();
    }
  }, 30_000);
}

function _stopWatchdog() {
  if (_watchdogTimer) { clearInterval(_watchdogTimer); _watchdogTimer = null; }
}

// ─── Command queue ────────────────────────────────────────────────────────────

function _drainQueue() {
  if (_cmdBusy || _cmdQueue.length === 0) return;
  if (!_connected || !_socket) {
    _cmdQueue.forEach(c => c.reject(new Error('Spa nicht verbunden')));
    _cmdQueue.length = 0;
    return;
  }

  const now = Date.now();
  const wait = MIN_CMD_INTERVAL_MS - (now - _lastCmdAt);
  if (wait > 0) {
    setTimeout(_drainQueue, wait);
    return;
  }

  _cmdBusy = true;
  const { buf, resolve, reject } = _cmdQueue.shift();
  _lastCmdAt = Date.now();

  log.debug({ hex: buf.toString('hex'), len: buf.length }, 'TX command');
  _socket.write(buf, (err) => {
    _cmdBusy = false;
    if (err) {
      log.warn({ err: err.message, hex: buf.toString('hex') }, 'SpaClient Command-Send Fehler');
      reject(err);
    } else {
      log.debug({ hex: buf.toString('hex') }, 'TX command sent OK');
      resolve();
    }
    // Drain next command after minimum interval
    setTimeout(_drainQueue, MIN_CMD_INTERVAL_MS);
  });
}

module.exports = { init, isConnected, getStatus, getFrameCount, sendCommand, onStatus, onConnection, setLogger };
