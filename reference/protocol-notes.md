# Balboa M7 Protokoll — Sundance Marin 780 / Elfin EW11
## Verifikationsstand: Live-Trace 2026-05-21 bis 2026-05-23

---

## Verbindung

- **Gerät:** Elfin EW11 RS485-WiFi-Brücke
- **TCP-Ziel:** `192.168.3.128:8899`
- **Protokoll:** Balboa M7 (raw TCP, kein Handshake)
- **Einschränkung:** EW11 erlaubt exakt **1 gleichzeitige TCP-Verbindung**

---

## Frame-Format

```
0x7E  [len]  [M1]  [M2]  [data …]  [csum]  0x7E

len  = Anzahl Bytes nach dem len-Byte (M1 + M2 + data + csum)
csum = Summe aller Bytes von [len] bis letztem [data] byte, mod 256
```

⚠ Die exakte Checksum-Variante für Sundance 780 ist noch nicht verifiziert.
Checksummen-Prüfung ist derzeit DEAKTIVIERT — 82 gültige Frames wurden ohne Prüfung empfangen.

---

## Status-Frame (Spa → Controller)

```
M1 = 0xFF, M2 = 0xAF
```

Nur Frames mit **dlen >= 40** akzeptieren (= Spa-Pack-Hauptframe).
Kürzere Frames (dlen=27) kommen von Topside-Panels und enthalten Nullwerte.

`d = frame[4 : frame.length-2]` (nach M1/M2, vor csum/0x7E)

### Byte-Offsets (VERIFIZIERT aus Live-Trace)

| Offset | Bedeutung | Formel | Verifikation |
|--------|-----------|--------|--------------|
| `d[3]` | Aktuelle Temperatur | `d[3] / 2` = °C; `0xFF` = Anzeige aus | ✅ 2026-05-21: d[3]=0x4B → 75/2=37.5°C bestätigt |
| `d[10]` | Heizstatus | Bits 4-5 ≠ 0 → heizt | ✅ Verifiziert |
| `d[11]` | Pumpen-Status (Zirk.) | Bits 3-4 = Zirk.-Pumpe Geschwindigkeit | ✅ 2026-05-22: 0x1C=circ ON hoch, 0x14=circ ON mittel, 0x04=circ OFF |
| `d[12]` | Pumpen (Düsen) | Bit 1 = pump1, Bits 2-3 = pump2 speed | ✅ 2026-05-22: 0x02=pump1 ON, 0x08=pump2 ON |
| `d[13]` | Innenlicht | ≠ 0 → Innenlicht an | ✅ 2026-05-21: 0xFF wenn Licht an |
| `d[14]` | Motor-Flags | Bits 2-3 = Gebläse-Speed ≠ 0 → Gebläse an | ✅ 2026-05-23: 0x00=alles aus, 0x4E=Gebläse an |
| `d[6]` | Außenlicht | Bit 3 (0x08) → Außenlicht an | ⚠ Hypothese 2026-05-23: 0x02=aus✓, 0x0A=an✓, 0x02 bei pump1=an ohne light2✓ |
| `d[6]`  | Heizmodus | Bits 0-1: 0=Auto, 1=Nacht, 2=Tag | ✅ Verifiziert live 880 2026-06-22 (d[15] war FALSCH/immer 0 am 880) |
| `d[21]` | Zieltemperatur | `d[21] / 2` = °C | ✅ 2026-05-21: d[21]=0x4C → 76/2=38°C bestätigt |

### Achtung: Falsche Offsets in anderen Quellen
- Viele Quellen nennen d[2] für Temp → **FALSCH** für Sundance Marin (d[2]=immer 0)
- Viele Quellen nennen d[20] für Setpoint → **FALSCH** für Sundance Marin (d[20]=immer 0)

---

## Steuer-Befehle (Controller → Spa)

### Toggle-Befehl (EIN/AUS)
```
buildMessage(0x0A, 0xBF, [0x07, CODE])
```

| Item | Code | Status |
|------|------|--------|
| PUMP1 (Düse 1) | 0x04 | ✅ Verifiziert |
| PUMP2 (Düse 2) | 0x05 | ✅ Verifiziert |
| BLOWER (Gebläse) | 0x0C | ✅ Verifiziert |
| LIGHT (Innenlicht) | 0x11 | ✅ Verifiziert |
| LIGHT2 (Außenlicht) | 0x12 | ⚠ Aus Balboa M7-Konvention abgeleitet, noch nicht live-verifiziert |
| CLEARRAY | 0x1E | ⚠ Noch nicht live-verifiziert |

### Temperatur setzen
```
buildMessage(0x0A, 0xBF, [0x20, raw])
raw = tempC * 2  (geclampet 20-84 = 10-42°C)
```

### Heizmodus setzen (privilegiert, cmd=0xD2) — ✅ verifiziert live 880 2026-06-22
```
7E 06 11 BF D2 <mode> <crc8_privileged> 7E
mode: 0=Auto, 1=Nacht, 2=Tag   (liest zurück in Status d[6] & 0x03)
```
Beispiele: Tag=`7e0611bfd202cf7e`, Nacht=`7e0611bfd201c67e`, Auto=`7e0611bfd200c17e`.
SmartTub-„Smart" ist eine Zeitplan-Ebene, kein d[6]-Wert — nicht über diesen Befehl setzbar.

### Frame-Builder (Python-Äquivalent)
```python
def build_message(m1: int, m2: int, payload: list[int]) -> bytes:
    length = len(payload) + 3  # M1 + M2 + payload + csum
    body = bytes([length, m1, m2] + payload)
    csum = sum(body) & 0xFF
    return bytes([0x7E]) + body + bytes([csum, 0x7E])
```

---

## Lichtfarben (Innenlicht)

M1=0x54, M2=0xBF, 27-Byte-Payload.
**Aus Live-RS-485-Trace vom 2026-05-21 erfasst.**

Format: `[0x32, 0x01, code, 0x00, brightness, R, G, B, 0x00×18, inner_csum]`

| Farbe | Code | Brightness | R | G | B | inner_csum |
|-------|------|-----------|---|---|---|------------|
| Hellblau | 0x04 | 0x64 | 0x00 | 0x7F | 0x7F | 0xD4 |
| Grün | 0x03 | 0x32 | 0x00 | 0xFF | 0x00 | 0x38 |
| Dunkelblau | 0x05 | 0x32 | 0x00 | 0x00 | 0xFF | 0x1F |
| Gelb | 0x08 | 0x32 | 0x7F | 0x7F | 0x00 | 0x5C |
| Violett | 0x06 | 0x32 | 0x7F | 0x00 | 0x7F | 0x38 |
| Rot | 0x01 | 0x32 | 0xFF | 0x00 | 0x00 | 0xA3 |
| Rainbow | 0x10 | 0x64 | 0xA4 | 0x5A | 0x00 | 0x9D |

**Außenlicht hat keine Farbsteuerung** (nur EIN/AUS per Toggle-Befehl).

---

## Timing / Bus-Arbitration

- **Mindestabstand zwischen Befehlen:** 500 ms
- Befehle müssen seriell (gequeued) gesendet werden
- EW11 überträgt alles transparent auf den RS-485-Bus

---

## Watchdog

- Kein Frame empfangen in > 60 Sekunden → TCP-Verbindung neu aufbauen
- Reconnect mit exponentiellem Backoff: 10s → 20s → 40s → 60s (Cap)
