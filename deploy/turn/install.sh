#!/usr/bin/env bash
# ============================================================================
# Install or update the TURN relay's coturn config on THIS host. Run as root.
#
#   sudo bash deploy/turn/install.sh --import    # once, on a host that already runs coturn:
#                                                # copy its per-host values into the site file
#   sudo bash deploy/turn/install.sh --dry-run   # show what would change (secret masked)
#   sudo bash deploy/turn/install.sh             # render, install, restart, verify — or roll back
#
# Options:
#   --env FILE            per-host values      (default /etc/hushsend-turn/turn.env)
#   --signaling-env FILE  the signaling .env   (default /var/www/hush-signaling-server/.env)
#   --force               install even if the CURRENT coturn secret differs from TURN_SECRET
#
# The shared secret is read from the signaling server's .env (TURN_SECRET) every
# time: coturn's static-auth-secret is rendered FROM it, so the two can no
# longer drift apart. The rendered file goes to /etc/turnserver.conf, which the
# distro's coturn.service reads.
#
# After restarting coturn it checks, against 127.0.0.1: the port is bound,
# STUN answers, a credential minted from the secret is accepted, one minted
# from another secret is refused, and no log file appeared. Any failure puts
# the previous config back. Then it runs verify-relay.sh end to end (through
# the live signaling server and the public address); that last step is
# reported, not enforced — it also depends on the router.
# ============================================================================
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/turn/lib.sh
. "$HERE/lib.sh"

SITE_ENV=/etc/hushsend-turn/turn.env
SIGNALING_ENV=/var/www/hush-signaling-server/.env
TARGET=/etc/turnserver.conf
UNIT=coturn
DRY_RUN=0 IMPORT=0 FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --import) IMPORT=1 ;;
    --force) FORCE=1 ;;
    --env) SITE_ENV=$2; shift ;;
    --signaling-env) SIGNALING_ENV=$2; shift ;;
    -h | --help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash $0 $*"

# --- coturn and its client tools ----------------------------------------------
if ! command -v turnserver >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || die "coturn is not installed and this is not a Debian/Ubuntu host — install it first"
  say "installing coturn…"
  apt-get update -qq && apt-get install -y coturn
fi
for tool in turnutils_stunclient turnutils_uclient openssl; do
  command -v "$tool" >/dev/null 2>&1 || die "missing $tool (package coturn / openssl)"
done

# --- the shared secret: ONE source, the signaling server's .env ---------------
[ -r "$SIGNALING_ENV" ] || die "cannot read $SIGNALING_ENV (pass --signaling-env)"
SECRET=$(sed -n 's/^[[:space:]]*TURN_SECRET=//p' "$SIGNALING_ENV" | tail -1 | tr -d '\r')
SECRET=${SECRET%"${SECRET##*[![:space:]]}"}
case "$SECRET" in
  \"*\") SECRET=${SECRET#\"}; SECRET=${SECRET%\"} ;;
  \'*\') SECRET=${SECRET#\'}; SECRET=${SECRET%\'} ;;
esac
[ -n "$SECRET" ] || die "TURN_SECRET is empty in $SIGNALING_ENV — set it there first (it is also what the signaling server mints with)"

# --- per-host values -------------------------------------------------------------
current() { [ -r "$TARGET" ] && sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$TARGET" | tail -1 | tr -d '\r'; }

if [ "$IMPORT" -eq 1 ]; then
  [ ! -e "$SITE_ENV" ] || die "$SITE_ENV already exists — edit it rather than importing again"
  [ -r "$TARGET" ] || die "nothing to import: $TARGET does not exist"
  mkdir -p "$(dirname "$SITE_ENV")"
  chmod 0700 "$(dirname "$SITE_ENV")"
  (
    umask 077
    {
      echo "# Imported from $TARGET on $(date -u +%Y-%m-%dT%H:%MZ) by deploy/turn/install.sh --import."
      echo "# Plain KEY=value lines, no inline comments. No secret here (see TURN_SECRET in the signaling .env)."
      echo "REALM=$(current realm)"
      echo "LISTEN_PORT=$(current listening-port || true)"
      echo "TLS_LISTEN_PORT=$(current tls-listening-port || true)"
      echo "EXTERNAL_IP=$(current external-ip || true)"
      echo "MIN_PORT=$(current min-port || true)"
      echo "MAX_PORT=$(current max-port || true)"
      echo "USER_QUOTA=$(current user-quota || true)"
      echo "TOTAL_QUOTA=$(current total-quota || true)"
      echo "MAX_BPS=$(current max-bps || true)"
    } >"$SITE_ENV"
  )
  # coturn's own defaults for what the old file left unset
  sed -i -e 's/^LISTEN_PORT=$/LISTEN_PORT=3478/' -e 's/^TLS_LISTEN_PORT=$/TLS_LISTEN_PORT=5349/' \
    -e 's/^MIN_PORT=$/MIN_PORT=49152/' -e 's/^MAX_PORT=$/MAX_PORT=65535/' \
    -e 's/^USER_QUOTA=$/USER_QUOTA=0/' -e 's/^TOTAL_QUOTA=$/TOTAL_QUOTA=0/' -e 's/^MAX_BPS=$/MAX_BPS=0/' "$SITE_ENV"
  say "wrote $SITE_ENV from $TARGET:"
  sed 's/^/    /' "$SITE_ENV"
fi
[ -r "$SITE_ENV" ] || die "no $SITE_ENV — copy deploy/turn/turn.env.example there and fill it in, or run with --import on a host that already runs coturn"
LISTEN_PORT=$(sed -n 's/^LISTEN_PORT=//p' "$SITE_ENV" | tail -1)

# --- the two copies of the secret must already agree ------------------------------
CURRENT_SECRET=$(current static-auth-secret || true)
if [ -n "$CURRENT_SECRET" ] && [ "$CURRENT_SECRET" != "$SECRET" ]; then
  if [ "$FORCE" -eq 1 ]; then
    say "WARN  the current coturn secret differs from TURN_SECRET — installing TURN_SECRET (--force)"
  else
    die "the current coturn secret differs from TURN_SECRET in $SIGNALING_ENV. Either Reliable mode is broken right now or the .env is wrong — find out which (bash $HERE/verify-relay.sh) before installing; --force installs TURN_SECRET."
  fi
fi

# --- render and show the change ---------------------------------------------------
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STATIC_AUTH_SECRET=$SECRET bash "$HERE/render.sh" "$SITE_ENV" >"$WORK/turnserver.conf"
mask() { sed -E 's/^([[:space:]]*static-auth-secret[[:space:]]*=).*/\1<masked>/' "$1"; }
say "--- changes to $TARGET (secret masked):"
if [ -r "$TARGET" ]; then
  diff -u <(mask "$TARGET") <(mask "$WORK/turnserver.conf") || true
else
  mask "$WORK/turnserver.conf"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  say "--- dry run: nothing changed"
  exit 0
fi

# --- install, keeping the previous file ----------------------------------------------
BACKUP=
if [ -e "$TARGET" ]; then
  BACKUP="$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$TARGET" "$BACKUP"
fi
GROUP=root
getent group turnserver >/dev/null 2>&1 && GROUP=turnserver
install -m 0640 -o root -g "$GROUP" "$WORK/turnserver.conf" "$TARGET"
touch "$WORK/started"
systemctl enable "$UNIT" >/dev/null 2>&1 || true
systemctl restart "$UNIT"

rollback() {
  printf 'FAIL  %s\n' "$1" >&2
  if [ -n "$BACKUP" ]; then
    cp -p "$BACKUP" "$TARGET"
    systemctl restart "$UNIT" || true
    printf 'ROLLED BACK to %s — coturn is on its previous config.\n' "$BACKUP" >&2
  else
    systemctl stop "$UNIT" || true
    printf 'There was no previous config; coturn is stopped.\n' >&2
  fi
  exit 1
}

for _ in $(seq 1 30); do
  turn_udp_port_bound "$LISTEN_PORT" && break
  sleep 0.5
done
systemctl is-active --quiet "$UNIT" || rollback "coturn is not running after the restart (journalctl -u $UNIT -n 30)"
turn_udp_port_bound "$LISTEN_PORT" || rollback "coturn does not listen on $LISTEN_PORT — the config was not loaded"
addr=$(turn_stun_check 127.0.0.1 "$LISTEN_PORT") || rollback "STUN does not answer on 127.0.0.1:$LISTEN_PORT"
say "ok    STUN answers on $LISTEN_PORT (mapped $addr)"
turn_alloc_accepted 127.0.0.1 "$LISTEN_PORT" "$SECRET" || rollback "a credential minted from TURN_SECRET was refused"
say "ok    a credential minted from TURN_SECRET is accepted"
turn_alloc_refused 127.0.0.1 "$LISTEN_PORT" "$SECRET" || rollback "a credential from ANOTHER secret was accepted — authentication is off"
say "ok    a credential from another secret is refused"
logs=$(turn_new_log_files "$WORK/started")
[ -z "$logs" ] || rollback "coturn wrote log files after the restart: $logs"
say "ok    no coturn log file"
say "INSTALLED  $TARGET (previous: ${BACKUP:-none})"

# --- end to end, through the live signaling server and the public address ------------
if command -v node >/dev/null 2>&1; then
  say "--- end to end (verify-relay.sh):"
  ENV_FILE="$SIGNALING_ENV" bash "$HERE/verify-relay.sh" ||
    say "WARN  the end-to-end check failed although the local checks passed — suspect the router, the firewall or TURN_URLS rather than this config"
fi
