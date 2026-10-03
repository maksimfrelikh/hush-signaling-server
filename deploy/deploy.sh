#!/usr/bin/env bash
# ============================================================================
# Update the RUNNING signaling server from its production checkout.
#
#   bash /var/www/hush-signaling-server/deploy/deploy.sh
#
# pull (fast-forward only) → npm ci --omit=dev → restart → /health → the [config] line.
# Run it as the user the unit runs as (the checkout's owner). Order matters:
# node_modules is not in git, so a pull that changes dependencies needs the
# install BEFORE the restart.
#
# Restart: `sudo -n systemctl restart` when a NOPASSWD rule allows it (see
# deploy/DEPLOY.md § Restart without a password); otherwise SIGKILL the main
# process — the unit has Restart=on-failure, so systemd relaunches it from the
# updated checkout within RestartSec (a clean SIGTERM exit would NOT be restarted).
# ============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
UNIT="${UNIT:-hushsend-signaling}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8080/health}"

cd "$APP_DIR"
before=$(git rev-parse --short HEAD)
git pull --ff-only
after=$(git rev-parse --short HEAD)
npm ci --omit=dev --no-audit --no-fund

old_pid=$(systemctl show -p MainPID --value "$UNIT")
if sudo -n systemctl restart "$UNIT" 2>/dev/null; then
  echo "restarted $UNIT (systemctl)"
else
  [ "${old_pid:-0}" -gt 0 ] || { echo "$UNIT has no main PID — is it running?" >&2; exit 1; }
  kill -9 "$old_pid"
  echo "no passwordless sudo: SIGKILLed $old_pid; systemd relaunches $UNIT (Restart=on-failure)"
fi

for _ in $(seq 1 30); do
  new_pid=$(systemctl show -p MainPID --value "$UNIT")
  if [ "${new_pid:-0}" -gt 0 ] && [ "$new_pid" != "$old_pid" ] && curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -fsS "$HEALTH_URL" >/dev/null || { echo "FAIL  $HEALTH_URL does not answer" >&2; exit 1; }
[ "$(systemctl show -p MainPID --value "$UNIT")" != "$old_pid" ] || { echo "FAIL  $UNIT was not restarted" >&2; exit 1; }

# The startup line echoes the effective config without secrets: trustProxy must be on, and turn
# configured with the URL count you expect — anything else means the .env did not load.
journalctl -u "$UNIT" -n 30 --no-pager 2>/dev/null | grep '\[config\]' | tail -1 ||
  echo "(journal not readable by this user — check the [config] line with: journalctl -u $UNIT -n 5)"
echo "deployed $before → $after"
