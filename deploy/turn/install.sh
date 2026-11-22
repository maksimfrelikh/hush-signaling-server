#!/usr/bin/env bash
# ============================================================================
# Install or update the TURN relay on THIS host: coturn's official image, run as
# the container `hushsend-turn` with a config rendered here. Run as root.
#
#   sudo bash deploy/turn/install.sh --import    # once, on a host that already runs coturn:
#                                                # copy its per-host values into the site file
#   sudo bash deploy/turn/install.sh --dry-run   # show what would change (secret masked)
#   sudo bash deploy/turn/install.sh             # render, (re)create the container, verify — or roll back
#
# Options:
#   --env FILE            per-host values      (default /etc/hushsend-turn/turn.env)
#   --signaling-env FILE  the signaling .env   (default /var/www/hush-signaling-server/.env)
#   --force               install even if the CURRENT coturn secret differs from TURN_SECRET
#
# The shared secret is read from the signaling server's .env (TURN_SECRET) every
# time: coturn's static-auth-secret is rendered FROM it, so the two can no
# longer drift apart. The rendered file is /etc/hushsend-turn/turnserver.conf
# (root:hushsend-turn 0640), mounted read-only into the container.
#
# The container runs COTURN_IMAGE (lib.sh) on the host network — the ports are
# the host's, opened in its firewall, no Docker port mapping — and Docker
# restarts it (`unless-stopped`). No Docker log, a read-only root, no
# capabilities, the system user hushsend-turn. --use-auth-secret is repeated on
# its command line: coturn that cannot read its config falls back to defaults,
# which relay for anyone; with the flag and no secret it refuses every request.
#
# After (re)creating the container it checks, against 127.0.0.1: the port is
# bound, STUN answers, a credential minted from the secret is accepted, one
# minted from another secret is refused, a TCP relay is refused, and no log file
# appeared. Any failure puts the previous config and container back. Then it
# runs verify-relay.sh end to end (through the live signaling server and the
# public address); that last step is reported, not enforced — it also depends
# on the router.
# ============================================================================
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/turn/lib.sh
. "$HERE/lib.sh"

SITE_ENV=/etc/hushsend-turn/turn.env
SIGNALING_ENV=/var/www/hush-signaling-server/.env
TARGET=/etc/hushsend-turn/turnserver.conf
LEGACY=/etc/turnserver.conf # what the distro's coturn.service reads: the values to import, the secret to compare
CONTAINER=hushsend-turn
RUN_USER=hushsend-turn
DRY_RUN=0 IMPORT=0 FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --import) IMPORT=1 ;;
    --force) FORCE=1 ;;
    --env) SITE_ENV=$2; shift ;;
    --signaling-env) SIGNALING_ENV=$2; shift ;;
    -h | --help) sed -n '2,35p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '%s\n' "$*"; }
die() { printf 'FAIL  %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root: sudo bash $0 $*"
for tool in docker openssl; do
  command -v "$tool" >/dev/null 2>&1 || die "missing $tool"
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
PREVIOUS=$TARGET
[ -e "$PREVIOUS" ] || PREVIOUS=$LEGACY
current() { [ -r "$PREVIOUS" ] && sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$PREVIOUS" | tail -1 | tr -d '\r'; }

if [ "$IMPORT" -eq 1 ]; then
  [ ! -e "$SITE_ENV" ] || die "$SITE_ENV already exists — edit it rather than importing again"
  [ -r "$PREVIOUS" ] || die "nothing to import: neither $TARGET nor $LEGACY exists"
  mkdir -p "$(dirname "$SITE_ENV")"
  chmod 0700 "$(dirname "$SITE_ENV")"
  (
    umask 077
    {
      echo "# Imported from $PREVIOUS on $(date -u +%Y-%m-%dT%H:%MZ) by deploy/turn/install.sh --import."
      echo "# Plain KEY=value lines, no inline comments. No secret here (see TURN_SECRET in the signaling .env)."
      echo "REALM=$(current realm)"
      echo "LISTEN_PORT=$(current listening-port || true)"
      echo "TLS_LISTEN_PORT=$(current tls-listening-port || true)"
      echo "RELAY_IP=$(current relay-ip || true)"
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
  say "wrote $SITE_ENV from $PREVIOUS (set RELAY_IP if it is empty):"
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
if [ -r "$PREVIOUS" ]; then
  say "--- changes to $TARGET (from $PREVIOUS, secret masked):"
  diff -u <(mask "$PREVIOUS") <(mask "$WORK/turnserver.conf") || true
else
  say "--- $TARGET (new, secret masked):"
  mask "$WORK/turnserver.conf"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  say "--- dry run: nothing changed"
  exit 0
fi

# --- the image, and the user the container runs as ----------------------------------
docker image inspect "$COTURN_IMAGE" >/dev/null 2>&1 || docker pull -q "$COTURN_IMAGE" >/dev/null
if ! getent passwd "$RUN_USER" >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$RUN_USER"
  say "created the system user $RUN_USER"
fi
RUN_UID=$(id -u "$RUN_USER")
RUN_GID=$(id -g "$RUN_USER")

running() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; }
if ! running && turn_udp_port_bound "$LISTEN_PORT"; then
  die "UDP $LISTEN_PORT is held by something else (ss -lunp | grep $LISTEN_PORT) — the distro's coturn.service? Stop it first."
fi

# --- install, keeping the previous config and container -------------------------------
BACKUP=
if [ -e "$TARGET" ]; then
  BACKUP="$TARGET.bak-$(date +%Y%m%d-%H%M%S)"
  cp -p "$TARGET" "$BACKUP"
fi
PREV_IMAGE=$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)
install -m 0640 -o root -g "$RUN_GID" "$WORK/turnserver.conf" "$TARGET"

start_container() { # image
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" --restart unless-stopped --network host \
    --user "$RUN_UID:$RUN_GID" --read-only --tmpfs /tmp --tmpfs /var/tmp --tmpfs /var/lib/coturn \
    --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
    --memory 256m --log-driver none \
    --mount "type=bind,source=$TARGET,target=/etc/coturn/turnserver.conf,readonly" \
    "$1" -c /etc/coturn/turnserver.conf --use-auth-secret --pidfile= >/dev/null
}
start_container "$COTURN_IMAGE"

rollback() {
  printf 'FAIL  %s\n' "$1" >&2
  [ -z "$BACKUP" ] || cp -p "$BACKUP" "$TARGET"
  if [ -n "$PREV_IMAGE" ] && start_container "$PREV_IMAGE"; then
    printf 'ROLLED BACK: %s runs its previous image and config (%s).\n' "$CONTAINER" "${BACKUP:-none saved}" >&2
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    printf 'No previous container to go back to: %s is removed, nothing relays on %s.\n' "$CONTAINER" "$LISTEN_PORT" >&2
  fi
  exit 1
}

for _ in $(seq 1 30); do
  turn_udp_port_bound "$LISTEN_PORT" && break
  sleep 0.5
done
running || rollback "$CONTAINER is not running (it keeps no log: run the image in the foreground with --log-file=stdout to see why)"
turn_udp_port_bound "$LISTEN_PORT" || rollback "coturn does not listen on $LISTEN_PORT — the config was not loaded"
addr=$(turn_stun_check 127.0.0.1 "$LISTEN_PORT") || rollback "STUN does not answer on 127.0.0.1:$LISTEN_PORT"
say "ok    STUN answers on $LISTEN_PORT (mapped $addr)"
turn_alloc_accepted 127.0.0.1 "$LISTEN_PORT" "$SECRET" || rollback "a credential minted from TURN_SECRET was refused"
say "ok    a credential minted from TURN_SECRET is accepted"
turn_alloc_refused 127.0.0.1 "$LISTEN_PORT" "$SECRET" || rollback "a credential from ANOTHER secret was accepted — authentication is off"
say "ok    a credential from another secret is refused"
case "$(turn_tcp_relay_probe 127.0.0.1 "$LISTEN_PORT" "$SECRET")" in
  refused) say "ok    a TCP relay is refused (UDP relays only)" ;;
  granted) rollback "coturn granted a TCP relay — no-tcp-relay did not take effect" ;;
  *) say "WARN  the TCP relay probe got no clear answer (output above) — CI's check-template.sh proves the refusal; not rolling back for an inconclusive probe" ;;
esac
# Its writable places are tmpfs, so a log could only be there — and only until a restart.
logs=$(docker exec "$CONTAINER" find /tmp /var/tmp /var/lib/coturn -name 'turn_*.log' 2>&1) ||
  rollback "could not look for log files in $CONTAINER: $logs"
[ -z "$logs" ] || rollback "coturn wrote log files: $logs"
say "ok    no coturn log file"
say "INSTALLED  $CONTAINER ($COTURN_IMAGE) with $TARGET (previous: ${BACKUP:-none})"

# --- end to end, through the live signaling server and the public address ------------
if command -v node >/dev/null 2>&1; then
  say "--- end to end (verify-relay.sh):"
  ENV_FILE="$SIGNALING_ENV" bash "$HERE/verify-relay.sh" ||
    say "WARN  the end-to-end check failed although the local checks passed — suspect the router, the firewall or TURN_URLS rather than this config"
fi
