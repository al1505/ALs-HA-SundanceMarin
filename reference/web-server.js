'use strict';

/* ════════════════════════════════════════════════════════════════════════════
   Web Remote — tiny HTTP server on port 3001
   Serves the spa control panel HTML and a minimal REST API.

   API:
     GET  /           → HTML control panel
     GET  /api/status → current spa status JSON
     POST /api/cmd    → send command
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

// ─── Request handler ──────────────────────────────────────────────────────────

function _handleRequest(req, res) {
  // CORS for HA iFrame
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/api/status') {
    const status = _getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status || {}));
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

  if (req.method === 'GET' && (req.url === '/' || req.url === '/remote')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
      await _sendCommand(_parser.buildToggleCommand(cmd.item));
      break;
    }
    case 'setTemp': {
      const t = parseFloat(cmd.tempC);
      if (!isFinite(t) || t < 10 || t > 40) throw new Error('Temp out of range');
      await _sendCommand(_parser.buildSetTempCommand(t));
      break;
    }
    case 'color': {
      if (cmd.light === 'outer') throw new Error('Außenlicht hat keine Farbeffekte');
      const status = _getStatus();
      const isOn = status && status.light;
      if (!isOn) {
        // Innenlicht ist aus — zuerst einschalten (toggle), dann Farbe setzen
        await _sendCommand(_parser.buildToggleCommand('LIGHT'));
        // spa-client enforces 500ms between commands; await the next send naturally
      }
      await _sendCommand(_parser.buildLightColorCommand(cmd.effect));
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
<title>Sundance Marin — Fernsteuerung</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;color:#e8eaf0;font-family:system-ui,sans-serif;
       max-width:480px;margin:0 auto;padding:12px 10px 30px}
  h1{font-size:1.1rem;font-weight:600;color:#7eb8f7;margin-bottom:12px;
     display:flex;align-items:center;gap:8px}
  .dot{width:9px;height:9px;border-radius:50%;background:#4caf50;flex-shrink:0}
  .dot.off{background:#f44336}
  .card{background:#1e2130;border-radius:12px;padding:14px;margin-bottom:10px}
  .card-title{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;
               color:#7a8090;margin-bottom:10px}
  .row{display:flex;gap:8px;flex-wrap:wrap}
  button{border:none;border-radius:8px;padding:9px 14px;font-size:.82rem;
          font-weight:500;cursor:pointer;transition:opacity .15s;min-width:60px}
  button:active{opacity:.7}
  .btn-on {background:#1e6bbf;color:#fff}
  .btn-off{background:#2a2f3e;color:#9aa0b0}
  .btn-dim{background:#3a2010;color:#e09050;font-size:.78rem}
  .temp-row{display:flex;align-items:center;gap:10px;margin-top:6px}
  .temp-val{font-size:1.8rem;font-weight:700;color:#7eb8f7;min-width:80px}
  .temp-sub{font-size:.75rem;color:#7a8090}
  .temp-ctrl{display:flex;gap:6px;align-items:center}
  .temp-ctrl button{width:36px;height:36px;border-radius:50%;font-size:1.1rem;padding:0;min-width:0}
  .sp-val{font-size:1rem;color:#e8eaf0;min-width:50px;text-align:center;font-variant-numeric:tabular-nums}
  .btn-set{padding:9px 16px;background:#1e6bbf;color:#fff;border-radius:8px;font-size:.82rem;min-width:0}
  .color-row{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px;align-items:center}
  .color-btn{width:34px;height:34px;border-radius:50%;border:2px solid transparent;
              cursor:pointer;transition:border-color .15s;flex-shrink:0}
  .color-btn.active{border-color:#fff;box-shadow:0 0 0 1px rgba(255,255,255,.4)}
  .color-btn-off{width:34px;height:34px;border-radius:50%;background:#2a2f3e;
                 border:2px solid #444;cursor:pointer;display:flex;align-items:center;
                 justify-content:center;font-size:.85rem;color:#9aa0b0;flex-shrink:0;
                 transition:border-color .15s}
  .color-btn-off:hover{border-color:#888}
  .section-row{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .lbl{font-size:.85rem;min-width:44px;font-weight:500}
  .lbl.on{color:#7eb8f7}
  .lbl.off{color:#7a8090}
  .readings{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .reading{background:#161924;border-radius:8px;padding:8px 10px}
  .reading-lbl{font-size:.68rem;text-transform:uppercase;letter-spacing:.06em;color:#5a6070;margin-bottom:2px}
  .reading-val{font-size:.95rem;font-weight:600}
  .rv-on{color:#4caf50}
  .rv-off{color:#5a6070}
  .rv-warm{color:#f59e0b}
  .status-bar{font-size:.7rem;color:#5a6070;text-align:right;margin-top:8px}
  .cmd-fb{font-size:.72rem;color:#f59e0b;margin-top:4px;min-height:1em}
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
        <button class="btn-off" onclick="adjSP(-0.5)" title="-0.5°C">−</button>
        <span class="sp-val" id="sp-val">—</span>
        <button class="btn-off" onclick="adjSP(+0.5)" title="+0.5°C">+</button>
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
    <button id="btn-pump2" onclick="toggle('PUMP2','fb-pump')">Düse 2 ⚠</button>
    <button id="btn-blower" onclick="toggle('BLOWER','fb-pump')">Gebläse</button>
  </div>
  <div class="cmd-fb" id="fb-pump"></div>
</div>

<!-- ─── Sensoren ──────────────────────────────────────────────────── -->
<div class="card">
  <div class="card-title">Sensoren (nur Anzeige)</div>
  <div class="readings">
    <div class="reading">
      <div class="reading-lbl">Heizung</div>
      <div class="reading-val" id="rv-heating">—</div>
    </div>
    <div class="reading">
      <div class="reading-lbl">Zirkulation</div>
      <div class="reading-val" id="rv-circ">—</div>
    </div>
    <div class="reading">
      <div class="reading-lbl">Heizmodus</div>
      <div class="reading-val" id="rv-heatmode">—</div>
    </div>
    <div class="reading">
      <div class="reading-lbl">Clearray</div>
      <div class="reading-val rv-off" id="rv-clearray">⚠ Trace ausstehend</div>
    </div>
  </div>
</div>

<!-- ─── Innenlicht ────────────────────────────────────────────────── -->
<div class="card">
  <div class="card-title">Innenlicht</div>
  <div class="section-row">
    <span class="lbl off" id="lbl-light">Aus</span>
    <span style="font-size:.78rem;color:#5a6070;flex:1">Farbe wählen = einschalten</span>
  </div>
  <div class="color-row" id="colors-inner">
    <!-- color circles + off button built by JS -->
  </div>
  <div class="cmd-fb" id="fb-light"></div>
</div>

<!-- ─── Außenlicht ────────────────────────────────────────────────── -->
<div class="card">
  <div class="card-title">Außenlicht</div>
  <div class="section-row">
    <span class="lbl off" id="lbl-light2">Aus</span>
    <button id="btn-light2" onclick="toggle('LIGHT2','fb-light2')">EIN / AUS</button>
  </div>
  <div style="font-size:.78rem;color:#5a6070;margin-top:4px">
    Keine Farben — nur EIN/AUS. Helligkeit: Trace ausstehend.
  </div>
  <div class="cmd-fb" id="fb-light2"></div>
</div>

<div class="status-bar" id="status-bar">wird geladen…</div>

<script>
const COLORS = [
  {name:'Hellblau',   hex:'#37B5E8'},
  {name:'Grün',       hex:'#2ECAA3'},
  {name:'Dunkelblau', hex:'#4C8CEE'},
  {name:'Gelb',       hex:'#F2BE48'},
  {name:'Violett',    hex:'#B25CBD'},
  {name:'Rot',        hex:'#EE4653'},
  {name:'Rainbow',    hex:'linear-gradient(135deg,#EE4653,#F2BE48,#2ECAA3,#4C8CEE)'}
];

let _state = {};
let _sp = null;

// Build inner light color circles + "Aus" button
(function buildInnerLightButtons() {
  const c = document.getElementById('colors-inner');
  COLORS.forEach(col => {
    const d = document.createElement('div');
    d.className = 'color-btn';
    d.title = col.name + ' — Licht einschalten';
    d.style.background = col.hex;
    d.setAttribute('data-color', col.name);
    d.onclick = () => sendColor(col.name);
    c.appendChild(d);
  });
  // "Aus" button (circle style, dark)
  const off = document.createElement('div');
  off.className = 'color-btn-off';
  off.title = 'Innenlicht ausschalten';
  off.textContent = '✕';
  off.onclick = () => innerLightOff();
  c.appendChild(off);
})();

async function fetchStatus() {
  try {
    const r = await fetch('/api/status');
    if (!r.ok) throw new Error(r.status);
    const s = await r.json();
    _state = s;
    if (_sp === null && s.setTemp) _sp = s.setTemp;
    updateUI(s);
  } catch(e) {
    document.getElementById('conn-dot').className = 'dot off';
    document.getElementById('status-bar').textContent = 'Keine Verbindung — ' + e.message;
  }
}

function updateUI(s) {
  document.getElementById('conn-dot').className = Object.keys(s).length ? 'dot' : 'dot off';

  document.getElementById('cur-temp').textContent =
    s.currentTemp != null ? s.currentTemp.toFixed(1) + '°C' : '—';
  if (_sp === null) _sp = s.setTemp || 38;
  document.getElementById('sp-val').textContent = (_sp || 38).toFixed(1) + '°C';

  setBtn('btn-pump1', s.pump1);
  setBtn('btn-pump2', s.pump2);
  setBtn('btn-blower', s.blower);

  // Sensoren
  setReading('rv-heating', s.heating, s.heating ? 'Aktiv' : 'Aus', 'rv-warm', 'rv-off');
  setReading('rv-circ', s.circPump, s.circPump ? 'Läuft' : 'Aus', 'rv-on', 'rv-off');
  const hm = document.getElementById('rv-heatmode');
  if (hm) { hm.textContent = s.heatModeName || '—'; hm.className = 'reading-val'; }

  // Innenlicht
  const lblL = document.getElementById('lbl-light');
  if (lblL) { lblL.textContent = s.light ? 'An' : 'Aus'; lblL.className = 'lbl ' + (s.light ? 'on' : 'off'); }

  // Außenlicht
  const lblL2 = document.getElementById('lbl-light2');
  if (lblL2) { lblL2.textContent = s.light2 ? 'An' : 'Aus'; lblL2.className = 'lbl ' + (s.light2 ? 'on' : 'off'); }
  setBtn('btn-light2', s.light2);

  document.getElementById('status-bar').textContent =
    new Date().toLocaleTimeString('de') + (s.currentTemp != null ? '  |  ' + s.currentTemp.toFixed(1) + '°C → ' + (s.setTemp||'—') + '°C' : '');
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

function adjSP(delta) {
  if (_sp === null) _sp = _state.setTemp || 38;
  _sp = Math.max(10, Math.min(40, parseFloat((_sp + delta).toFixed(1))));
  document.getElementById('sp-val').textContent = _sp.toFixed(1) + '°C';
}

async function sendSetTemp() {
  feedback('fb-temp', '⏳ Sende Temperatur-Befehl…');
  const res = await cmd({type:'setTemp', tempC: _sp});
  feedback('fb-temp', res ? '✓ Gesendet (' + _sp.toFixed(1) + '°C)' : '✗ Fehler', 4000);
  setTimeout(fetchStatus, 1500);
}

async function toggle(item, fbId) {
  if (fbId) feedback(fbId, '⏳ ' + item + '…');
  const res = await cmd({type:'toggle', item});
  if (fbId) feedback(fbId, res ? '✓ ' + item + ' gesendet' : '✗ Fehler', 3000);
  setTimeout(fetchStatus, 1200);
}

async function sendColor(effect) {
  // Mark active color
  document.getElementById('colors-inner').querySelectorAll('.color-btn').forEach(b =>
    b.classList.toggle('active', b.getAttribute('data-color') === effect));
  feedback('fb-light', '⏳ ' + effect + '…');
  const res = await cmd({type:'color', effect, light:'inner'});
  feedback('fb-light', res ? '✓ ' + effect + ' gesendet' : '✗ Fehler', 3000);
  setTimeout(fetchStatus, 1500);
}

async function innerLightOff() {
  if (!_state.light) return; // already off
  feedback('fb-light', '⏳ Licht ausschalten…');
  const res = await cmd({type:'toggle', item:'LIGHT'});
  feedback('fb-light', res ? '✓ Licht aus' : '✗ Fehler', 3000);
  setTimeout(fetchStatus, 1200);
}

async function cmd(payload) {
  try {
    const r = await fetch('/api/cmd', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const t = await r.text();
      console.warn('cmd error', t);
      return false;
    }
    return true;
  } catch(e) {
    console.warn('cmd fetch error', e);
    return false;
  }
}

setInterval(fetchStatus, 2000);
fetchStatus();
</script>
</body>
</html>`;

module.exports = { init, setLogger };
