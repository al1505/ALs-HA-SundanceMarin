#!/usr/bin/env bash
# SessionStart hook: warn if the live HA integration version differs from
# the repo's version.toml — catches "fix committed but never deployed"
# (root cause of the 2026-07-06..10 Whirlpool outage).
set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION_TOML="$REPO_ROOT/version.toml"
LIVE_MANIFEST="//192.168.15.11/config/custom_components/als_sundance_marin/manifest.json"

REPO_VER=$(sed -n 's/^version = "\(.*\)"/\1/p' "$VERSION_TOML" 2>/dev/null)
LIVE_VER=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$LIVE_MANIFEST" 2>/dev/null | head -1)

if [ -z "$REPO_VER" ]; then
  # Can't even read our own version.toml — say nothing, don't block the session.
  exit 0
fi

if [ -z "$LIVE_VER" ]; then
  printf '{"systemMessage":"Deploy-Check: Live-HA-Host (SMB) nicht erreichbar - konnte Live-Version nicht pruefen. Repo steht auf %s."}\n' "$REPO_VER"
  exit 0
fi

if [ "$REPO_VER" != "$LIVE_VER" ]; then
  MSG="DEPLOY AUSSTEHEND: Repo-Version $REPO_VER, aber Live-Version auf dem HA-Host ist noch $LIVE_VER. Vor Abschluss jeder Session mit Code-Aenderungen an dieser Integration: SMB-Deploy (custom_components/als_sundance_marin -> \\\\\\\\192.168.15.11\\\\config\\\\custom_components\\\\als_sundance_marin) + __pycache__ leeren + HA-Neustart, dann erneut pruefen."
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$MSG" "$MSG"
else
  printf '{"systemMessage":"Deploy-Check OK: Live-Version (%s) = Repo-Version (%s)."}\n' "$LIVE_VER" "$REPO_VER"
fi
