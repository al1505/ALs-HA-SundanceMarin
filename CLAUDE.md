# ALs-HA-SundanceMarin — Projekt-Kontext

Custom-Integration + Lovelace-Card für den Sundance Marin 780 Whirlpool
(Elfin EW11 RS485-WiFi-Brücke, kein MQTT/Cloud).

## Deploy-Pflicht (PFLICHT, jede Session mit Code-Änderung)

**Dieses Repo hat ein Deploy-Ziel außerhalb von Git:** Der Live-HA-Host
(`192.168.15.11`) liest die Integration NICHT aus GitHub, sondern aus
`\\192.168.15.11\config\custom_components\als_sundance_marin\`. Ein
`git push` allein bewirkt **nichts** am laufenden System — das war die
Ursache des 4-Tage-Ausfalls 2026-07-06 bis 2026-07-10 (Fix lag 3 Wochen
ungenutzt im Repo).

**Abschlussprozess für JEDE Code-Änderung an dieser Integration:**

1. Version-Bump in `version.toml` + `custom_components/als_sundance_marin/manifest.json`
2. Commit + Push
3. **Deploy:** `custom_components\als_sundance_marin\*` → SMB nach
   `\\192.168.15.11\config\custom_components\als_sundance_marin\` kopieren
4. `__pycache__` im Zielordner leeren (alte `.pyc` überschatten sonst neue `.py`)
5. Config-Entry-Reload versuchen; falls die gesamte Domain zuvor fehlgeschlagen
   war (`/api/config` zeigt `als_sundance_marin` NICHT in `components`), reicht
   Reload nicht — **HA-Neustart nötig** (`POST /api/services/homeassistant/restart`,
   vorher beim User bestätigen — betrifft den ganzen Haushalt kurz)
6. Verifizieren: Live-`manifest.json`-Version == `version.toml`-Version,
   Entities in `/api/states` liefern echte Werte (nicht `unavailable`)

**Eine Session, die Code an dieser Integration ändert, gilt erst als
abgeschlossen, wenn Schritt 6 bestätigt ist — nicht schon bei Commit+Push.**

**Automatischer Reminder:** Ein SessionStart-Hook
(`.claude/hooks/check_deploy_sync.sh`) vergleicht bei jeder Session
Repo-`version.toml` gegen die Live-`manifest.json` und meldet eine
Diskrepanz sofort. Bei "DEPLOY AUSSTEHEND" zuerst deployen, bevor an
etwas anderem weitergearbeitet wird.

## Zugang

- HA-URL + Token: `H:\Haribo\ALs-Haribo\control\ha-credentials.env`
- SMB-Schreibzugriff: `\\192.168.15.11\config\`
- EW11-Bus direkt: `192.168.3.128:8899` (TCP, mehrere gleichzeitige Verbindungen möglich)
- Kein SSH auf `192.168.15.11` (nur NUC `192.168.15.30` hat Key-Auth)
- REST-Fehlerlogs: `/api/error_log` ist in HA 2026.7.1 tot (404) — WebSocket
  `ws://192.168.15.11:8123/api/websocket` + `system_log/list` nutzen

## Nicht verwechseln

- `als_sundance_marin_*` = DIESE Integration (EW11, lokal)
- `sundance_marin_*` = offizielle **smarttub** Cloud-Integration (unabhängig)
- `sundance_780_spa_spa_*` = alte Node.js/MQTT-Bridge (gestoppt, nicht diese)

Details siehe Memory-Einträge dieses Projekts (`coordinator-reconnect-selfcancel`,
`repo-fix-not-deployed-pattern`, `ha-access-and-live-deploy`).
