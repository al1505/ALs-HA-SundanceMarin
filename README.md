# ALs-HA-SundanceMarin

Home Assistant Custom Integration + Custom Card für den **Sundance Marin 780** Whirlpool,
verbunden via **Elfin EW11** RS485-WiFi-Brücke.

**Kein MQTT, kein externer Service** — die Integration läuft direkt in Home Assistant.

[![PayPal](https://img.shields.io/badge/PayPal-Support-blue.svg?logo=paypal)](https://paypal.me/aloisschacherl)

---

## Projektziele

| Deliverable | Beschreibung |
|---|---|
| **Custom Integration** | Python-Integration für HA (`custom_components/sundance_marin/`) — ersetzt den bisherigen Node.js MQTT-Bridge |
| **Custom Card** | Lovelace-Karte (`lovelace/sundance-marin-card.js`) — Nachbau des bisherigen Web-Panels als HA-Karte |

---

## Hintergrund

Das Vorgängerprojekt `ALs-Sundance` war ein **Node.js-Service**, der:
1. Per TCP mit dem EW11 (RS-485-WiFi-Brücke) kommuniziert
2. Balboa-Frames parst
3. Status + Befehle via **MQTT** an Home Assistant weitergibt

Dieses Projekt entfernt MQTT vollständig und integriert direkt in HA.

---

## Architektur

```
Sundance Marin 780 Spa
        │
   RS-485 Bus
        │
   Elfin EW11 (TCP 192.168.3.128:8899)
        │
   asyncio TCP in HA
        │
   DataUpdateCoordinator (coordinator.py)
   ├── climate.py    → Temperatur-Steuerung
   ├── switch.py     → Düse 1, Düse 2, Gebläse
   ├── light.py      → Innen-/Außenlicht + Farbeffekte
   ├── binary_sensor.py → Heizstatus, Zirkulationspumpe
   └── select.py     → Heizmodus (Auto/Nacht/Smart)
        │
   HA WebSocket API
        │
   sundance-marin-card.js (Custom Card)
```

---

## Projektstruktur

```
ALs-HA-SundanceMarin/
├── custom_components/
│   └── sundance_marin/        ← HA Custom Integration
│       ├── manifest.json
│       ├── __init__.py
│       ├── config_flow.py
│       ├── const.py
│       ├── coordinator.py
│       ├── balboa.py
│       ├── climate.py
│       ├── switch.py
│       ├── light.py
│       ├── binary_sensor.py
│       ├── select.py
│       └── strings.json
├── lovelace/
│   └── sundance-marin-card.js ← Lovelace Custom Card
├── reference/                 ← Original JS-Code (Referenz, nicht ausführen)
│   ├── balboa-parser.js       ← Protokoll-Parser (JS → Python portieren!)
│   ├── spa-client.js          ← TCP-Client (JS → Python portieren!)
│   ├── web-server.js          ← Web-Panel HTML/CSS/JS (Card-Referenz!)
│   └── protocol-notes.md      ← Verifizierte Byte-Offsets & Protokoll-Details
└── README.md
```

---

## Phase 1: Custom Integration

### 1.1 Einstiegspunkt: `manifest.json`

```json
{
  "domain": "sundance_marin",
  "name": "Sundance Marin",
  "version": "1.0.0",
  "config_flow": true,
  "documentation": "https://github.com/al1505/ALs-HA-SundanceMarin",
  "requirements": [],
  "iot_class": "local_push",
  "codeowners": ["@al1505"]
}
```

**Keine externen Requirements** — nur Python-Standardbibliotheken + HA-interne asyncio.

### 1.2 `const.py` — Konstanten

Alle Protokoll-Konstanten aus `reference/balboa-parser.js` portieren:

```python
DOMAIN = "sundance_marin"
DEFAULT_HOST = "192.168.3.128"
DEFAULT_PORT = 8899
MIN_CMD_INTERVAL = 0.5   # Sekunden zwischen Befehlen (Bus-Arbitration)
WATCHDOG_TIMEOUT = 60    # Sekunden ohne Frame → Reconnect

STATUS_M1 = 0xFF
STATUS_M2 = 0xAF
MIN_STATUS_DLEN = 40     # Nur Spa-Pack-Hauptframes akzeptieren (Topside=27 ignorieren)

# Byte-Offsets in d = frame[4:-2]
OFF_CURRENT_TEMP = 3
OFF_HEATING      = 10
OFF_PUMP_STATUS  = 11    # bits 3-4 = Zirk-Pumpe
OFF_PUMPS        = 12    # bit 1 = pump1; bits 2-3 = pump2
OFF_LIGHT        = 13    # ≠0 = Innenlicht an
OFF_MOTOR_FLAGS  = 14    # bits 2-3 = Gebläse
OFF_LIGHT2       = 6     # bit 3 (0x08) = Außenlicht
OFF_HEAT_MODE    = 15    # bits 0-1
OFF_SET_TEMP     = 21

HEAT_MODE_NAMES = ["Auto", "Nacht", "Smart"]

LIGHT_EFFECTS = ["Hellblau", "Grün", "Dunkelblau", "Gelb", "Violett", "Rot", "Rainbow"]

TOGGLE_CODES = {
    "PUMP1":    0x04,
    "PUMP2":    0x05,
    "BLOWER":   0x0C,
    "LIGHT":    0x11,
    "LIGHT2":   0x12,   # ⚠ aus Konvention abgeleitet, noch nicht live-verifiziert
}

# Aus Live-RS-485-Trace 2026-05-21 erfasst
COLOR_PAYLOADS = {
    "Hellblau":   bytes([0x32,0x01,0x04,0x00,0x64,0x00,0x7F,0x7F]+[0]*18+[0xD4]),
    "Grün":       bytes([0x32,0x01,0x03,0x00,0x32,0x00,0xFF,0x00]+[0]*18+[0x38]),
    "Dunkelblau": bytes([0x32,0x01,0x05,0x00,0x32,0x00,0x00,0xFF]+[0]*18+[0x1F]),
    "Gelb":       bytes([0x32,0x01,0x08,0x00,0x32,0x7F,0x7F,0x00]+[0]*18+[0x5C]),
    "Violett":    bytes([0x32,0x01,0x06,0x00,0x32,0x7F,0x00,0x7F]+[0]*18+[0x38]),
    "Rot":        bytes([0x32,0x01,0x01,0x00,0x32,0xFF,0x00,0x00]+[0]*18+[0xA3]),
    "Rainbow":    bytes([0x32,0x01,0x10,0x00,0x64,0xA4,0x5A,0x00]+[0]*18+[0x9D]),
}
```

### 1.3 `balboa.py` — Protokoll-Parser

Port von `reference/balboa-parser.js`. Drei Kernfunktionen:

**Frame extrahieren:**
```python
def extract_frame(buf: bytes) -> tuple[bytes | None, bytes]:
    """Extrahiert ersten vollständigen Balboa-Frame aus rohem TCP-Stream.
    Returns: (frame, remaining_buf) oder (None, buf) wenn noch unvollständig."""
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
        total = length + 3
        if len(buf) - start < total:
            return None, buf[start:]
        if buf[start + total - 1] != 0x7E:
            pos = start + 1
            continue
        return buf[start:start + total], buf[start + total:]
    return None, b""
```

**Status parsen:**
```python
def parse_status_frame(frame: bytes) -> dict | None:
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
```

**Befehle bauen:**
```python
def _build_message(m1: int, m2: int, payload: bytes) -> bytes:
    length = len(payload) + 3
    body = bytes([length, m1, m2]) + payload
    csum = sum(body) & 0xFF
    return bytes([0x7E]) + body + bytes([csum, 0x7E])

def build_toggle(item: str) -> bytes:
    code = TOGGLE_CODES[item]
    return _build_message(0x0A, 0xBF, bytes([0x07, code]))

def build_set_temp(temp_c: float) -> bytes:
    raw = max(20, min(84, round(temp_c * 2)))
    return _build_message(0x0A, 0xBF, bytes([0x20, raw]))

def build_color(color_name: str) -> bytes:
    payload = COLOR_PAYLOADS[color_name]
    return _build_message(0x54, 0xBF, payload)
```

### 1.4 `coordinator.py` — DataUpdateCoordinator

Der Coordinator hält die TCP-Verbindung zum EW11 und verteilt Status-Updates an alle Entities.

**Wichtig:** HA's DataUpdateCoordinator nutzt `async_refresh()`. Da der Spa **push-basiert** ist
(sendet Status-Frames selbst, ca. alle 1-2 Sekunden), wird der Coordinator im **push-Modus** betrieben:
- Kein Polling-Intervall (`update_interval=None`)
- TCP-Reader läuft als permanenter asyncio-Task
- Jeder empfangene Status-Frame ruft `self.async_set_updated_data(data)` auf

```python
class SundanceCoordinator(DataUpdateCoordinator):
    def __init__(self, hass, host, port):
        super().__init__(hass, _LOGGER, name=DOMAIN, update_interval=None)
        self.host = host
        self.port = port
        self._reader = None
        self._writer = None
        self._cmd_lock = asyncio.Lock()
        self._last_cmd_at = 0
        self._buf = b""
        self._light_effect = None
        self._light2_effect = None

    async def async_connect(self):
        """TCP-Verbindung aufbauen + Reader-Task starten."""
        self._reader, self._writer = await asyncio.open_connection(self.host, self.port)
        self.hass.async_create_task(self._read_loop())

    async def _read_loop(self):
        """Permanenter asyncio-Task: liest TCP-Stream, parst Frames."""
        while True:
            try:
                chunk = await self._reader.read(4096)
                if not chunk:
                    break
                self._buf += chunk
                while True:
                    frame, self._buf = extract_frame(self._buf)
                    if frame is None:
                        break
                    status = parse_status_frame(frame)
                    if status:
                        self.async_set_updated_data(status)
            except Exception:
                break
        # Reconnect nach Verbindungsabbruch (mit Backoff)
        await asyncio.sleep(10)
        await self.async_connect()

    async def send_command(self, frame: bytes):
        """Befehl senden mit 500ms-Mindestabstand (Bus-Arbitration)."""
        async with self._cmd_lock:
            elapsed = asyncio.get_event_loop().time() - self._last_cmd_at
            if elapsed < MIN_CMD_INTERVAL:
                await asyncio.sleep(MIN_CMD_INTERVAL - elapsed)
            self._writer.write(frame)
            await self._writer.drain()
            self._last_cmd_at = asyncio.get_event_loop().time()
```

### 1.5 `config_flow.py` — HA-UI-Konfiguration

Minimaler ConfigFlow mit zwei Feldern:

| Feld | Default | Typ |
|---|---|---|
| `host` | `192.168.3.128` | string |
| `port` | `8899` | int |

Verbindungstest im Validation-Step: kurz connect + warte auf ersten Frame (max. 5 Sekunden).
Bei Fehler: `errors["base"] = "cannot_connect"`.

### 1.6 `__init__.py` — Integration-Setup

```python
PLATFORMS = ["climate", "switch", "light", "binary_sensor", "select"]

async def async_setup_entry(hass, entry):
    coordinator = SundanceCoordinator(hass, entry.data["host"], entry.data["port"])
    await coordinator.async_connect()
    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True
```

### 1.7 Entities

#### `climate.py` — Temperatur-Steuerung

```
Entity-Klasse: ClimateEntity
hvac_modes: [HVACMode.HEAT, HVACMode.OFF]
temperature_unit: UnitOfTemperature.CELSIUS
min_temp: 10, max_temp: 40, target_temperature_step: 0.5
current_temperature: coordinator.data["current_temp"]
target_temperature: coordinator.data["set_temp"]
hvac_mode: HEAT wenn current_temp nicht None, sonst OFF
```

`async_set_temperature()` → `coordinator.send_command(build_set_temp(temp))`

`async_set_hvac_mode()` → **kein Toggle**, einfach ignorieren oder "OFF" als display-only behandeln
(Spa kann nicht per Befehl komplett abgeschaltet werden)

#### `switch.py` — Düse 1, Düse 2, Gebläse

Pro Entity eine `SwitchEntity`:
- `is_on`: aus `coordinator.data`
- `async_turn_on/off()`: beide rufen `build_toggle(item)` auf (Spa toggelt immer)

**Entities:**
| unique_id | name | item |
|---|---|---|
| `sundance_pump1` | Spa Düse 1 | PUMP1 |
| `sundance_pump2` | Spa Düse 2 | PUMP2 |
| `sundance_blower` | Spa Gebläse | BLOWER |

#### `light.py` — Innenlicht + Außenlicht

`LightEntity` mit `ColorMode.ONOFF` + `effect_list = LIGHT_EFFECTS`.

**Innenlicht (`sundance_light`):**
- `is_on`: `coordinator.data["light"]`
- `turn_on(effect=...)`: Wenn Licht aus → erst Toggle senden, dann nach 600ms Farbbefehl
- `turn_on()` ohne effect: nur Toggle
- `turn_off()`: Toggle wenn Licht an
- `effect`: optimistisch gespeichert im Coordinator (`_light_effect`), da keine Readback-Möglichkeit

**Außenlicht (`sundance_light2`):**
- `is_on`: `coordinator.data["light2"]`
- Nur EIN/AUS (Toggle), **keine Farbeffekte**

#### `binary_sensor.py` — Heizstatus + Zirkulationspumpe

| unique_id | name | key | device_class |
|---|---|---|---|
| `sundance_heating` | Spa Heizstatus | `heating` | `heat` |
| `sundance_circ_pump` | Spa Zirkulationspumpe | `circ_pump` | `running` |

#### `select.py` — Heizmodus

`SelectEntity` mit options `["Auto", "Nacht", "Smart"]`.
- `current_option`: `coordinator.data["heat_mode_name"]`
- `select_option()`: **Kein direkter Befehl bekannt** — Heizmodus kann per Toggle-Taste am Gerät gewechselt werden. Implementierung entweder:
  a) Vorerst read-only (kein command_topic)
  b) Mehrfach-Toggle senden bis Zielzustand erreicht (riskant, besser a)

**Empfehlung: vorerst read-only implementieren.**

### 1.8 Device-Info

Alle Entities teilen ein gemeinsames Device:

```python
DeviceInfo(
    identifiers={(DOMAIN, "sundance_780")},
    name="Sundance Marin 780",
    model="Sundance Marin 780",
    manufacturer="Sundance Spas / Balboa",
)
```

---

## Phase 2: Custom Card

### Referenz

Das vollständige HTML/CSS/JS des bisherigen Web-Panels ist in `reference/web-server.js`
(ab Zeile 128, `_HTML`-Konstante). Es enthält:
- Dark-Theme-CSS (bereits fertig)
- Temperatur-Anzeige + Setpoint-Regler
- Buttons für Pumpen, Gebläse
- Sensor-Readings (Heizstatus, Zirkulation, Heizmodus)
- Innenlicht-Farbkreise (7 Farben + Aus-Button)
- Außenlicht EIN/AUS
- Status-Bar mit Zeitstempel

### Card-Implementierung (`sundance-marin-card.js`)

HA Custom Cards sind **native Custom Elements** (kein Framework nötig).

```javascript
class SundanceMarinCard extends HTMLElement {
  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  setConfig(config) {
    // optionale Konfiguration (entity_prefix etc.)
  }

  static getConfigElement() { /* Editor */ }
  static getStubConfig() { return {}; }
}
customElements.define("sundance-marin-card", SundanceMarinCard);
```

### Entity-IDs die die Card lesen muss

| Entity-ID | Typ | Verwendung |
|---|---|---|
| `climate.spa_temperatur` | climate | current_temp, target_temp, hvac_mode |
| `switch.spa_duse_1` | switch | Pumpen-Button-Status |
| `switch.spa_duse_2` | switch | Pumpen-Button-Status |
| `switch.spa_geblase` | switch | Gebläse-Button-Status |
| `binary_sensor.spa_heizstatus` | binary_sensor | Heizstatus-Anzeige |
| `binary_sensor.spa_zirkulationspumpe` | binary_sensor | Zirkulations-Anzeige |
| `select.spa_heizmodus` | select | Heizmodus-Anzeige |
| `light.spa_innenlicht` | light | Licht-Status + aktiver Effekt |
| `light.spa_aussenlicht` | light | Außenlicht-Status |

### Services die die Card aufrufen muss

```javascript
// Temperatur setzen
hass.callService("climate", "set_temperature", {
  entity_id: "climate.spa_temperatur",
  temperature: 38.5
});

// Switch togglen (Düse, Gebläse)
hass.callService("switch", "turn_on", { entity_id: "switch.spa_duse_1" });
hass.callService("switch", "turn_off", { entity_id: "switch.spa_duse_1" });

// Licht + Farbe
hass.callService("light", "turn_on", {
  entity_id: "light.spa_innenlicht",
  effect: "Hellblau"
});
hass.callService("light", "turn_off", { entity_id: "light.spa_innenlicht" });
```

### CSS / Design

Das CSS aus `reference/web-server.js` (Zeilen 134-181) **direkt übernehmen**.
Es ist bereits optimiert für dunkles Theme, mobile-first, 480px max-width.
In der Card als Shadow DOM einbetten:

```javascript
this.attachShadow({ mode: "open" });
this.shadowRoot.innerHTML = `<style>${CSS}</style>${HTML}`;
```

---

## Installation auf Home Assistant

### Custom Integration

1. Verzeichnis `custom_components/sundance_marin/` in HA-Config kopieren:
   ```
   /config/custom_components/sundance_marin/
   ```
2. HA neu starten
3. Einstellungen → Integrationen → Integration hinzufügen → "Sundance Marin"
4. IP-Adresse des EW11 eingeben: `192.168.3.128`, Port: `8899`

### Custom Card

1. `lovelace/sundance-marin-card.js` nach `/config/www/` kopieren
2. In HA: Einstellungen → Dashboards → Ressourcen → Hinzufügen
   - URL: `/local/sundance-marin-card.js`
   - Typ: JavaScript-Modul
3. Im Dashboard: Karte hinzufügen → "Benutzerdefiniert: sundance-marin-card"

---

## Bekannte Einschränkungen / offene Punkte

| Punkt | Status | Aktion |
|---|---|---|
| Checksum-Verifikation | ⚠ Deaktiviert | Checksum-Formel aus Traces verifizieren |
| LIGHT2 Toggle-Code 0x12 | ⚠ Hypothese | Live-Trace mit Außenlicht-Toggle verifizieren |
| CLEARRAY 0x1E | ⚠ Nicht getestet | Live-Trace mit Clearray-Toggle |
| Heizmodus-Befehl | ❌ Unbekannt | Vorerst read-only |
| Außenlicht Helligkeit | ❌ Unbekannt | Trace ausstehend |
| EW11 Single-Connection | ⚠ Wichtig | Nur 1 TCP-Verbindung erlaubt — HA darf keine zweite öffnen |

---

## Netzwerk

| Ressource | Adresse |
|---|---|
| EW11 (Spa-Bridge) | `192.168.3.128:8899` |
| Home Assistant | `192.168.15.11:8123` |
| OhmPilot (alte Node.js-Version) | `192.168.15.117` |
| Windows-PC (SMB-Mount `H:\`) | `192.168.15.117` (OhmPilot-Filesystem) |

---

## Git

Repository: `https://github.com/al1505/ALs-HA-SundanceMarin` (privat)

```bash
git init
git remote add origin https://github.com/al1505/ALs-HA-SundanceMarin.git
git add .
git commit -m "feat: initial project scaffold + protocol reference"
git push -u origin master
```
