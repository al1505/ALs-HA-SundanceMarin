'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Web Remote — tiny HTTP server on port 3001
   Serves the spa control panel HTML and a minimal REST API.

   API:
     GET  /            → HTML control panel
     GET  /api/status  → current spa status JSON
     GET  /api/events  → Server-Sent Events stream (real-time push)
     POST /api/cmd     → send command
       body: { type: 'toggle', item: 'PUMP1'|'PUMP2'|'BLOWER'|'LIGHT'|'LIGHT2' }
             { type: 'setTemp', tempC: 38.5 }
             { type: 'color',  effect: 'Hellblau', light: 'inner'|'outer' }
   ════════════════════════════════════════════════════════════════════════════ */

const http = require('http');
const PORT = 3001;

let _getStatus   = () => null;
let _sendCommand = async () => {};
let _parser      = null;
let _bridge      = null;

// Software state — cmd=0x31 inner/outer light leaves no trace in RS-485 status frame
let _lightState       = false;  // inner light via cmd=0x31 (color/brightness commands)
let _lightEffect      = null;   // current inner light effect/color name (null = unknown)
let _light2State      = false;  // outer light
let _light2Brightness = 100;    // last non-zero brightness (0-100), used when toggling ON


// SSE client set — each entry is a response object with SSE headers already sent
const _sseClients = new Set();

let log = {
  info:  (...a) => console.log('[web]', ...a),
  warn:  (...a) => console.warn('[web]', ...a),
  error: (...a) => console.error('[web]', ...a),
  debug: (...a) => {}
};
function setLogger(l) { log = l; }

// ─── Init ─────────────────────────────────────────────────────────────────────

function init(getStatus, sendCommand, parser, bridge) {
  _getStatus   = getStatus;
  _sendCommand = sendCommand;
  _parser      = parser;
  _bridge      = bridge;

  const server = http.createServer(_handleRequest);
  server.listen(PORT, '0.0.0.0', () => {
    log.info({ port: PORT }, `Spa Remote verfügbar: http://192.168.15.117:${PORT}`);
  });
}

// ─── SSE push ─────────────────────────────────────────────────────────────────

/**
 * Push a new spa status to all connected SSE clients.
 * Called by server.js whenever spaClient fires an onStatus event.
 * @param {object} status — parsed spa status object
 */
function pushStatus(status) {
  if (_sseClients.size === 0) return;
  const merged = {
    ...status,
    light:            !!(status.light || _lightState),
    lightEffect:      _lightState ? _lightEffect : null,
    light2:           _light2State,
    light2Brightness: _light2Brightness
  };
  const data = `data: ${JSON.stringify(merged)}\n\n`;
  for (const res of _sseClients) {
    try { res.write(data); }
    catch (_) { _sseClients.delete(res); }
  }
}

// ─── Request handler ──────────────────────────────────────────────────────────

function _handleRequest(req, res) {
  // CORS for HA iFrame
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/api/status') {
    const status = _getStatus();
    const merged = status
      ? { ...status, light: !!(status.light || _lightState), lightEffect: _lightState ? _lightEffect : null, light2: _light2State, light2Brightness: _light2Brightness }
      : { light: _lightState, lightEffect: _lightState ? _lightEffect : null, light2: _light2State, light2Brightness: _light2Brightness };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(merged));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/cmd') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      try {
        const cmd = JSON.parse(body);
        await _dispatch(cmd);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (err) {
        log.warn({ err: err.message }, 'Web cmd Fehler');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/events') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    // Send current status immediately so the client doesn't wait for next push
    const cur = _getStatus();
    if (cur) res.write(`data: ${JSON.stringify({ ...cur, light: !!(cur.light || _lightState), lightEffect: _lightState ? _lightEffect : null, light2: _light2State, light2Brightness: _light2Brightness })}\n\n`);
    // Keep-alive comment every 25 s (prevents proxy/browser SSE timeout at 30 s)
    const hb = setInterval(() => {
      try { res.write(': heartbeat\n\n'); }
      catch (_) { clearInterval(hb); _sseClients.delete(res); }
    }, 25000);
    _sseClients.add(res);
    req.on('close', () => { clearInterval(hb); _sseClients.delete(res); });
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/remote')) {
    res.writeHead(200, {
      'Content-Type':  'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(_HTML);
    return;
  }

  res.writeHead(404); res.end('Not found');
}

// ─── Command dispatcher ───────────────────────────────────────────────────────

async function _dispatch(cmd) {
  if (!_parser) throw new Error('Parser not ready');

  switch (cmd.type) {
    case 'toggle': {
      const valid = ['PUMP1','PUMP2','BLOWER','LIGHT','LIGHT2'];
      if (!valid.includes(cmd.item)) throw new Error(`Unknown item: ${cmd.item}`);
      if (cmd.item === 'LIGHT') {
        const st = _getStatus();
        // Use software state OR frame state — cmd=0x31 colors don't update d[24]
        const isOn = !!(st?.light || _lightState);
        await _sendCommand(_parser.buildPrivilegedLightToggle(isOn));
        _lightState = !isOn;  // optimistic update
      } else if (cmd.item === 'LIGHT2') {
        if (_light2State) {
          await _sendCommand(_parser.buildOuterLightOff());
          _light2State = false;
          // Spa needs two OFF signals — queue second immediately (before any future command)
          _sendCommand(_parser.buildOuterLightOff()).catch(() => {});
        } else {
          await _sendCommand(_parser.buildOuterLightBrightness(_light2Brightness || 100));
          _light2State = true;
        }
      } else {
        await _sendCommand(_parser.buildPrivilegedToggleCommand(cmd.item));
      }
      break;
    }
    case 'brightness': {
      const val = Math.round(parseFloat(cmd.value));
      if (!isFinite(val) || val < 0 || val > 100) throw new Error('Brightness out of range');
      if (cmd.item === 'LIGHT') {
        // cmd=0x31 brightness=0 is the correct OFF for color-mode lights (turned on via cmd=0x31).
        // cmd=0x29 LIGHT_OFF only works for the physical toggle mode — do NOT use it here.
        await _sendCommand(_parser.buildInnerLightBrightness(val));
        if (val === 0) {
          _lightEffect = null;
          // Spa needs two OFF signals — queue second immediately (before any future command)
          _sendCommand(_parser.buildInnerLightBrightness(0)).catch(() => {});
        }
        _lightState = val > 0;
      } else if (cmd.item === 'LIGHT2') {
        if (val === 0) {
          await _sendCommand(_parser.buildOuterLightOff());
        } else {
          await _sendCommand(_parser.buildOuterLightBrightness(val));
          _light2Brightness = val;
        }
        _light2State = val > 0;
      } else {
        throw new Error(`Unknown brightness item: ${cmd.item}`);
      }
      break;
    }
    case 'setTemp': {
      const t = parseFloat(cmd.tempC);
      if (!isFinite(t) || t < 10 || t > 40) throw new Error('Temp out of range');
      await _sendCommand(_parser.buildPrivilegedSetTempCommand(t));
      break;
    }
    case 'color': {
      if (cmd.light === 'outer') throw new Error('Außenlicht hat keine Farbeffekte');
      // Send the correct SmartTub cmd=0x31 frame (verified 2026-05-25)
      // NOTE: buildLightColorCommand() is deprecated (M1=0x54 response frames — does not work!)
      if (cmd.effect === 'Rainbow') {
        await _sendCommand(_parser.buildInnerLightRainbow());
      } else {
        await _sendCommand(_parser.buildInnerLightColor(cmd.effect));
      }
      _lightState  = true;         // color/rainbow command turns inner light on
      _lightEffect = cmd.effect;   // track current effect for page-reload restore
      if (_bridge) _bridge.setLightEffect(cmd.effect, false);
      break;
    }
    default:
      throw new Error(`Unknown command type: ${cmd.type}`);
  }
}

// ─── HTML control panel ───────────────────────────────────────────────────────

const _HTML = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sundance Marin</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;color:#e8eaf0;font-family:system-ui,sans-serif;
       max-width:480px;margin:0 auto;padding:12px 10px 32px}
  h1{font-size:1.05rem;font-weight:600;color:#7eb8f7;margin-bottom:12px;
     display:flex;align-items:center;gap:8px}
  .dot{width:9px;height:9px;border-radius:50%;background:#4caf50;flex-shrink:0}
  .dot.off{background:#f44336}
  .card{background:#1e2130;border-radius:12px;padding:14px;margin-bottom:10px}
  .card-title{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;
               color:#7a8090;margin-bottom:10px}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  button{border:none;border-radius:8px;padding:9px 14px;font-size:.82rem;
         font-weight:500;cursor:pointer;transition:background .15s,opacity .1s;min-width:60px}
  button:active{opacity:.7}
  .btn-on {background:#1a5fa8;color:#fff}
  .btn-off{background:#252b3a;color:#8a90a0}
  .temp-row{display:flex;align-items:center;gap:14px;margin-top:6px}
  .temp-val{font-size:1.9rem;font-weight:700;color:#7eb8f7;min-width:88px}
  .temp-sub{font-size:.72rem;color:#7a8090;margin-top:2px}
  .temp-ctrl{display:flex;gap:6px;align-items:center}
  .temp-ctrl button{width:36px;height:36px;border-radius:50%;font-size:1.1rem;padding:0;min-width:0}
  .sp-val{font-size:1rem;color:#e8eaf0;min-width:54px;text-align:center;font-variant-numeric:tabular-nums}
  .btn-set{padding:9px 16px;background:#1a5fa8;color:#fff;border-radius:8px;font-size:.82rem;min-width:0}
  /* Color circles */
  .color-row{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;align-items:center}
  .color-btn{width:36px;height:36px;border-radius:50%;border:2px solid transparent;
              cursor:pointer;transition:border-color .12s,transform .1s;flex-shrink:0}
  .color-btn:hover{transform:scale(1.1)}
  .color-btn.active{border-color:#fff;box-shadow:0 0 0 2px rgba(255,255,255,.25)}
  .color-btn-off{width:36px;height:36px;border-radius:50%;background:#252b3a;
                 border:2px solid #3a4050;cursor:pointer;display:flex;align-items:center;
                 justify-content:center;font-size:.9rem;color:#8a90a0;flex-shrink:0;
                 transition:border-color .12s}
  .color-btn-off:hover{border-color:#6a7080}
  /* Section header row */
  .section-row{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .lbl{font-size:.88rem;min-width:36px;font-weight:600}
  .lbl.on{color:#7eb8f7}
  .lbl.off{color:#5a6070}
  /* Brightness slider */
  .dim-row{display:flex;align-items:center;gap:10px;margin-top:10px}
  .dim-label{font-size:.72rem;color:#7a8090;white-space:nowrap;min-width:52px}
  .dim-val{font-size:.78rem;color:#9aa0b0;min-width:32px;text-align:right;font-variant-numeric:tabular-nums}
  input[type=range]{flex:1;-webkit-appearance:none;height:6px;border-radius:3px;
                    background:#2a3040;outline:none;cursor:pointer}
  input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;
    border-radius:50%;background:#4a90d9;cursor:pointer;transition:background .12s}
  input[type=range]::-webkit-slider-thumb:hover{background:#6aA8e8}
  input[type=range]:disabled{opacity:.35;cursor:default}
  /* Sensor grid */
  .readings{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .reading{background:#161924;border-radius:8px;padding:8px 10px}
  .reading-lbl{font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;color:#4a5060;margin-bottom:3px}
  .reading-val{font-size:.92rem;font-weight:600}
  .rv-on  {color:#4caf50}
  .rv-off {color:#4a5060}
  .rv-warm{color:#f59e0b}
  /* Feedback */
  .cmd-fb{font-size:.72rem;color:#f59e0b;margin-top:6px;min-height:1.2em}
  .status-bar{font-size:.68rem;color:#4a5060;text-align:right;margin-top:6px}
</style>
</head>
<body>
<h1><span class="dot" id="conn-dot"></span>Sundance Marin</h1>

<!-- ─── Temperatur ─────────────────────────────────────────────────── -->
<div class="card">
  <div class="card-title">Temperatur</div>
  <div class="temp-row">
    <div>
      <div class="temp-val" id="cur-temp">—</div>
      <div class="temp-sub">Aktuell</div>
    </div>
    <div>
      <div class="temp-ctrl">
        <button class="btn-off" onclick="adjSP(-0.5)">−</button>
        <span class="sp-val" id="sp-val">—</span>
        <button class="btn-off" onclick="adjSP(+0.5)">+</button>
        <button class="btn-set" onclick="sendSetTemp()">SET</button>
      </div>
      <div class="temp-sub" style="margin-top:4px">Ziel (−/+ dann SET)</div>
    </div>
  </div>
  <div class="cmd-fb" id="fb-temp"></div>
</div>

<!-- ─── Pumpen & Gebläse ──────────────────────────────────────────── -->
<div class="card">
  <div class="card-title">Pumpen &amp; Gebläse</div>
  <div class="row">
    <button id="btn-pump1" onclick="toggle('PUMP1','fb-pump')">Düse 1</button>
    <button id="btn-pump2" onclick="toggle('PUMP2','fb-pump')">Düse 2</button>
    <button id="btn-blower" onclick="toggle('BLOWER','fb-pump')">Gebläse</button>
  </div>
  <div class="cmd-fb" id="fb-pump"></div>
</div>

<!-- ─── Innenlicht ────────────────────────────────────────────────── -->
<div class="card">
  <div class="card-title">Innenlicht</div>
  <div class="section-row">
    <span class="lbl off" id="lbl-light">Aus</span>
    <span style="font-size:.75rem;color:#5a6070">Farbe tippen = einschalten</span>
  </div>
  <div class="color-row" id="colors-inner">
    <!-- populated by JS -->
  </div>
  <!-- Brightness slider for inner light -->
  <div class="dim-row">
    <span class="dim-label">Helligkeit</span>
    <input type="range" id="dim-light" min="0" max="100" value="100"
           oninput="document.getElementById('dim-light-val').textContent=this.value+'%'"
           onchange="sendBrightness('LIGHT',this.value,'fb-light')">
    <span class="dim-val" id="dim-light-val">100%</span>
  </div>
  <div class="cmd-fb" id="fb-light"></div>
</div>

<!-- ─── Außenlicht ────────────────────────────────────────────────── -->
<div class="card">
  <div class="card-title">Außenlicht (weißes LED)</div>
  <div class="section-row">
    <span class="lbl off" id="lbl-light2">Aus</span>
    <button id="btn-light2" onclick="toggle('LIGHT2','fb-light2')">EIN / AUS</button>
  </div>
  <div class="cmd-fb" id="fb-light2"></div>
</div>

<!-- ─── Sensoren ──────────────────────────────────────────────────── -->
<div class="card">
  <div class="card-title">Sensoren (nur Anzeige)</div>
  <div class="readings">
    <div class="reading">
      <div class="reading-lbl">Heizung</div>
      <div class="reading-val rv-off" id="rv-heating">—</div>
    </div>
    <div class="reading">
      <div class="reading-lbl">Zirkulation</div>
      <div class="reading-val rv-off" id="rv-circ">—</div>
    </div>
    <div class="reading">
      <div class="reading-lbl">Heizmodus</div>
      <div class="reading-val" id="rv-heatmode">—</div>
    </div>
    <div class="reading">
      <div class="reading-lbl">Clearray</div>
      <div class="reading-val rv-off" id="rv-clearray">—</div>
    </div>
  </div>
</div>

<div class="status-bar" id="status-bar">wird geladen…</div>

<script>
const COLORS = [
  {name:'Hellblau',   hex:'#37B5E8'},
  {name:'Dunkelblau', hex:'#4C8CEE'},
  {name:'Violett',    hex:'#B25CBD'},
  {name:'Rot',        hex:'#EE4653'},
  {name:'Gelb',       hex:'#F2BE48'},
  {name:'Grün',       hex:'#2ECAA3'},
  {name:'Rainbow',    hex:'conic-gradient(from 0deg,#EE4653,#F2BE48,#2ECAA3,#4C8CEE,#B25CBD,#EE4653)'}
];

let _state = {};
let _sp = null;

// Build inner light color circles + "Aus" circle
(function buildColorButtons() {
  const c = document.getElementById('colors-inner');
  COLORS.forEach(col => {
    const d = document.createElement('div');
    d.className = 'color-btn';
    d.title = col.name;
    d.style.background = col.hex;
    d.setAttribute('data-color', col.name);
    d.onclick = () => sendColor(col.name);
    c.appendChild(d);
  });
  const off = document.createElement('div');
  off.className = 'color-btn-off';
  off.title = 'Innenlicht aus';
  off.innerHTML = '&#x2715;';
  off.onclick = () => innerLightOff();
  c.appendChild(off);
})();

// ── Status-Polling (fallback) ─────────────────────────────────────
async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) throw new Error(r.status);
    const s = await r.json();
    applyState(s);
  } catch(e) {
    document.getElementById('conn-dot').className = 'dot off';
    document.getElementById('status-bar').textContent = 'Keine Verbindung — ' + e.message;
  }
}

function applyState(s) {
  _state = s;
  if (_sp === null && s.setTemp) _sp = s.setTemp;
  updateUI(s);
}

// ── UI update ─────────────────────────────────────────────────────
function updateUI(s) {
  document.getElementById('conn-dot').className = Object.keys(s).length ? 'dot' : 'dot off';

  // Temperatur
  const ct = document.getElementById('cur-temp');
  ct.textContent = s.currentTemp != null ? s.currentTemp.toFixed(1) + '°C' : '—';
  if (_sp === null) _sp = s.setTemp || 38;
  document.getElementById('sp-val').textContent = (_sp || 38).toFixed(1) + '°C';

  // Pumpen
  setBtn('btn-pump1', s.pump1);
  setBtn('btn-pump2', s.pump2);
  setBtn('btn-blower', s.blower);

  // Sensoren
  setReading('rv-heating', s.heating, s.heating ? 'Aktiv' : 'Aus', 'rv-warm', 'rv-off');
  setReading('rv-circ',    s.circPump, s.circPump ? 'Läuft' : 'Aus', 'rv-on', 'rv-off');
  const hm = document.getElementById('rv-heatmode');
  if (hm) { hm.textContent = s.heatModeName || '—'; hm.className = 'reading-val'; }
  const cl = document.getElementById('rv-clearray');
  if (cl) {
    if (s.clearray == null) {
      cl.textContent = '—';  // status bit not yet identified
      cl.className = 'reading-val rv-off';
    } else {
      cl.textContent = s.clearray ? 'Aktiv' : 'Aus';
      cl.className = 'reading-val ' + (s.clearray ? 'rv-on' : 'rv-off');
    }
  }

  // Innenlicht
  const lblL = document.getElementById('lbl-light');
  if (lblL) { lblL.textContent = s.light ? 'An' : 'Aus'; lblL.className = 'lbl ' + (s.light ? 'on' : 'off'); }
  const dimL = document.getElementById('dim-light');
  if (dimL) dimL.disabled = !s.light;
  // Sync active color circle from server-side state (survives page reload)
  const currentEffect = s.light ? (s.lightEffect || null) : null;
  document.getElementById('colors-inner')?.querySelectorAll('.color-btn').forEach(b =>
    b.classList.toggle('active', b.getAttribute('data-color') === currentEffect));

  // Außenlicht (software state)
  const lblL2 = document.getElementById('lbl-light2');
  if (lblL2) { lblL2.textContent = s.light2 ? 'An' : 'Aus'; lblL2.className = 'lbl ' + (s.light2 ? 'on' : 'off'); }
  setBtn('btn-light2', s.light2);
  const dimL2 = document.getElementById('dim-light2');
  if (dimL2) {
    // sync slider + label only if not currently being dragged
    if (!dimL2.matches(':active')) {
      const bv = s.light2Brightness != null ? s.light2Brightness : 100;
      dimL2.value = bv;
      document.getElementById('dim-light2-val').textContent = bv + '%';
    }
    dimL2.disabled = !s.light2;
  }

  document.getElementById('status-bar').textContent =
    new Date().toLocaleTimeString('de') +
    (s.currentTemp != null ? '  |  ' + s.currentTemp.toFixed(1) + '°C → ' + (s.setTemp || '—') + '°C' : '');
}

function setBtn(id, on) {
  const b = document.getElementById(id);
  if (b) b.className = on ? 'btn-on' : 'btn-off';
}
function setReading(id, on, text, clsOn, clsOff) {
  const el = document.getElementById(id);
  if (el) { el.textContent = text; el.className = 'reading-val ' + (on ? clsOn : clsOff); }
}
function feedback(id, msg, ms) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, ms || 3000);
}

// ── Commands ──────────────────────────────────────────────────────
function adjSP(delta) {
  if (_sp === null) _sp = _state.setTemp || 38;
  _sp = Math.max(18.5, Math.min(40, parseFloat((_sp + delta).toFixed(1))));
  document.getElementById('sp-val').textContent = _sp.toFixed(1) + '°C';
}

async function sendSetTemp() {
  feedback('fb-temp', '⏳ Sende…');
  const res = await apiCmd({type:'setTemp', tempC: _sp});
  feedback('fb-temp', res ? '✓ ' + _sp.toFixed(1) + '°C gesendet' : '✗ Fehler', 4000);
  setTimeout(fetchStatus, 1500);
}

async function toggle(item, fbId) {
  // Briefly disable the button to prevent accidental double-sends while the spa processes the command
  const btnId = 'btn-' + item.toLowerCase();
  const btn = document.getElementById(btnId);
  if (btn) { btn.disabled = true; btn.style.opacity = '0.45'; }
  if (fbId) feedback(fbId, '⏳ …');
  const res = await apiCmd({type:'toggle', item});
  if (fbId) feedback(fbId, res ? '✓ gesendet' : '✗ Fehler', 3000);
  setTimeout(fetchStatus, 1200);
  // Re-enable after 2 s — enough time for spa to physically respond
  setTimeout(() => { if (btn) { btn.disabled = false; btn.style.opacity = ''; } }, 2000);
}

async function sendBrightness(item, value, fbId) {
  const pct = parseInt(value, 10);
  if (fbId) feedback(fbId, '⏳ Helligkeit ' + pct + '%…');
  const res = await apiCmd({type:'brightness', item, value: pct});
  if (fbId) feedback(fbId, res ? '✓ ' + pct + '%' : '✗ Fehler', 2500);
  setTimeout(fetchStatus, 800);
}

async function sendColor(effect) {
  document.getElementById('colors-inner').querySelectorAll('.color-btn').forEach(b =>
    b.classList.toggle('active', b.getAttribute('data-color') === effect));
  feedback('fb-light', '⏳ ' + effect + '…');
  const res = await apiCmd({type:'color', effect, light:'inner'});
  feedback('fb-light', res ? '✓ ' + effect : '✗ Fehler', 3000);
  setTimeout(fetchStatus, 1500);
}

async function innerLightOff() {
  // Disable ✕ button briefly to prevent double-sends while spa processes the command
  const offBtn = document.querySelector('.color-btn-off');
  if (offBtn) { offBtn.style.pointerEvents = 'none'; offBtn.style.opacity = '0.45'; }
  feedback('fb-light', '⏳ Licht aus…');
  // brightness=0 via cmd=0x31 is the correct OFF for color-mode lights on this spa
  const res = await apiCmd({type:'brightness', item:'LIGHT', value:0});
  feedback('fb-light', res ? '✓ Aus' : '✗ Fehler', 3000);
  document.getElementById('colors-inner').querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
  setTimeout(fetchStatus, 1200);
  // Re-enable after 2 s
  setTimeout(() => { if (offBtn) { offBtn.style.pointerEvents = ''; offBtn.style.opacity = ''; } }, 2000);
}

async function apiCmd(payload) {
  try {
    const r = await fetch('/api/cmd', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(payload)
    });
    if (!r.ok) { console.warn('cmd err', await r.text()); return false; }
    return true;
  } catch(e) { console.warn('cmd fetch err', e); return false; }
}

// ── SSE real-time updates ─────────────────────────────────────────
(function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = e => {
    try { const s = JSON.parse(e.data); applyState(s); } catch(_) {}
  };
  es.onerror = () => {
    document.getElementById('conn-dot').className = 'dot off';
    document.getElementById('status-bar').textContent = 'SSE getrennt — reconnect…';
  };
  fetchStatus(); // initial load
})();
</script>
</body>
</html>`;

// ─── Software-state accessors (used by server.js for MQTT) ───────────────────
function getLightState()       { return _lightState; }
function setLight(on)          { _lightState = !!on; }

function getLight2State()      { return _light2State; }
function getLight2Brightness() { return _light2Brightness; }
function setLight2(on, brightness) {
  _light2State = !!on;
  if (brightness !== undefined && brightness > 0) _light2Brightness = brightness;
  if (!on && brightness === 0) _light2Brightness = _light2Brightness || 100; // keep last non-zero
}

module.exports = { init, setLogger, pushStatus, getLightState, setLight, getLight2State, getLight2Brightness, setLight2 };
