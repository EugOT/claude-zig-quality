#!/usr/bin/env bash
# =============================================================================
# DRAFT — inspect before running. Deploy the ZQ reports platform to himalayas.
#
# Idempotent, read-then-act. Copies the server + a report JSON, installs the
# launchd agent, (re)loads it, and verifies :4000 answers over the meshnet.
# This is the canonical meshnet report surface for all computers.
#
# Usage (after inspection):
#   ./deploy.sh /path/to/report-data.json          # deploy + register one report
# Pre-req: SSH alias `himalayas` works non-interactively (BatchMode).
# =============================================================================
set -euo pipefail

HOST="himalayas"
MESHNET_IP="100.100.39.44"
PORT="4000"
REMOTE_APP_DIR="/Users/etretiakov/zq-report"
REMOTE_REPORTS_DIR="/Users/etretiakov/zq-report/reports"
PLIST="ai.eugot.zq-reports.plist"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_JSON="${1:-}"

ssh_h() { ssh -o ConnectTimeout=10 -o BatchMode=yes "$HOST" "$@"; }

echo "==> Preflight: confirm canonical report port :$PORT is available"
if ssh_h "lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1"; then
  echo "    ERROR: something already listens on :$PORT. Stop the stale report service first."
  ssh_h "lsof -nP -iTCP:$PORT -sTCP:LISTEN"
  exit 1
fi

echo "==> Ensure remote dirs"
ssh_h "mkdir -p '$REMOTE_APP_DIR' '$REMOTE_REPORTS_DIR'"

echo "==> Copy server"
scp -o ConnectTimeout=10 -o BatchMode=yes "$HERE/report-server.exs" "$HOST:$REMOTE_APP_DIR/report-server.exs"

if [[ -n "$DATA_JSON" && -f "$DATA_JSON" ]]; then
  base="$(basename "$DATA_JSON")"
  echo "==> Copy report: $base"
  if ! scp -o ConnectTimeout=10 -o BatchMode=yes "$DATA_JSON" "$HOST:$REMOTE_REPORTS_DIR/$base"; then
    echo "    FAILED to copy report data: $DATA_JSON" >&2
    exit 1
  fi
fi

echo "==> Install + (re)load launchd agent"
scp -o ConnectTimeout=10 -o BatchMode=yes "$HERE/$PLIST" "$HOST:/Users/etretiakov/Library/LaunchAgents/$PLIST"
ssh_h "launchctl unload -w '/Users/etretiakov/Library/LaunchAgents/$PLIST' 2>/dev/null || true; \
       launchctl load -w '/Users/etretiakov/Library/LaunchAgents/$PLIST'"

echo "==> Wait for first boot (cold-cache Mix.install compiles ~15 deps; can take minutes)"
for i in $(seq 1 60); do
  if curl -sS -m 5 -o /dev/null -w "" "http://$MESHNET_IP:$PORT/" 2>/dev/null; then
    code=$(curl -sS -m 5 -o /dev/null -w "%{http_code}" "http://$MESHNET_IP:$PORT/" 2>/dev/null || echo 000)
    echo "    up: HTTP $code at http://$MESHNET_IP:$PORT/"
    break
  fi
  sleep 5
  [[ $i -eq 60 ]] && { echo "    FAILED to come up in 300s; check the log below"; ssh_h "tail -30 /Users/etretiakov/zq-report/server.err.log 2>/dev/null"; exit 1; }
done

echo "==> Verify a report route renders (if a report was deployed)"
if [[ -n "$DATA_JSON" ]]; then
  name="$(basename "$DATA_JSON" .json)"
  curl -sS -m 8 -o /dev/null -w "    /r/$name -> HTTP %{http_code}\n" "http://$MESHNET_IP:$PORT/r/$name" || true
fi

echo "==> Done. Reports index: http://$MESHNET_IP:$PORT/"
echo "    Logs: ssh $HOST 'tail -f /Users/etretiakov/zq-report/server.log'"
