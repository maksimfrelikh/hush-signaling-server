#!/usr/bin/env bash
# ============================================================================
# CI check: does turnserver.conf.template render into a config coturn really
# loads, and does that config authenticate with the shared secret?
#
#   bash deploy/turn/check-template.sh
#
# No root needed: coturn runs as the current user on high ports. Checks:
#   1. coturn binds the RENDERED port (34780). If it silently discarded the file
#      (it does that on some config errors) it would run on its defaults: 3478.
#   2. STUN answers there.
#   3. A credential minted from the secret is accepted (allocation succeeds).
#   4. NEGATIVE CONTROL: one minted from another secret is refused.
#   5. A TCP relay (RFC 6062) is refused — no-tcp-relay took effect.
#   6. No coturn log file was written (log-file=/dev/null took effect).
#   7. NEGATIVE CONTROL for 5: the same config WITHOUT no-tcp-relay grants a
#      TCP relay, so the probe in 5 cannot pass on a server it never reached.
# ============================================================================
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=deploy/turn/lib.sh
. "$HERE/lib.sh"

for tool in turnserver turnutils_stunclient turnutils_uclient openssl; do
  command -v "$tool" >/dev/null || { echo "need $tool (package: coturn / openssl)" >&2; exit 2; }
done

WORK=$(mktemp -d)
TS_PID=
cleanup() {
  [ -n "$TS_PID" ] && kill "$TS_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

PORT=34780
SECRET=$(openssl rand -hex 24)
cat >"$WORK/turn.env" <<EOF
REALM=turn.ci.test
LISTEN_PORT=$PORT
TLS_LISTEN_PORT=34781
EXTERNAL_IP=
MIN_PORT=49300
MAX_PORT=49320
USER_QUOTA=12
TOTAL_QUOTA=1200
MAX_BPS=5000000
EOF
STATIC_AUTH_SECRET=$SECRET bash "$HERE/render.sh" "$WORK/turn.env" >"$WORK/turnserver.conf"
touch "$WORK/started"

# `-c` and NOT `-n`: `-n` means "ignore the configuration file".
turnserver -c "$WORK/turnserver.conf" --pidfile= >"$WORK/stdout" 2>&1 &
TS_PID=$!

fail() {
  echo "FAIL  $*" >&2
  echo "----- coturn stdout:" >&2
  cat "$WORK/stdout" >&2 || true
  exit 1
}

for _ in $(seq 1 30); do
  turn_udp_port_bound "$PORT" && break
  sleep 0.5
done
turn_udp_port_bound "$PORT" || fail "coturn is not listening on the rendered port $PORT — the config was not loaded"
echo "ok    coturn loaded the rendered config (listening on $PORT)"

addr=$(turn_stun_check 127.0.0.1 "$PORT") || fail "STUN did not answer on $PORT"
echo "ok    STUN answers (mapped address $addr)"

turn_alloc_accepted 127.0.0.1 "$PORT" "$SECRET" || fail "a correctly minted credential was REFUSED"
echo "ok    a credential minted from the shared secret is accepted"

turn_alloc_refused 127.0.0.1 "$PORT" "$SECRET" || fail "a credential minted from ANOTHER secret was accepted — authentication is off"
echo "ok    a credential from another secret is refused (negative control)"

verdict=$(turn_tcp_relay_probe 127.0.0.1 "$PORT" "$SECRET")
[ "$verdict" = refused ] || fail "TCP relay probe: $verdict (expected: refused) — no-tcp-relay did not take effect"
echo "ok    a TCP relay (RFC 6062) is refused — UDP relays only"

logs=$(turn_new_log_files "$WORK/started")
[ -z "$logs" ] || fail "coturn wrote a log file despite log-file=/dev/null: $logs"
# An option coturn does not know (or rejects) is reported before log-file is read — and, as
# measured on 4.18, that alone creates /var/tmp/turn_*.log. A startup banner is harmless.
! grep -qiE 'Bad configuration format|CONFIG ERROR|unknown option' "$WORK/stdout" ||
  fail "coturn rejected an option in the rendered config"
echo "ok    no log file, no rejected option"

# NEGATIVE CONTROL for the TCP relay probe: the same config without no-tcp-relay must be caught
# granting one — otherwise "refused" above could come from a probe that never reached coturn.
kill "$TS_PID" 2>/dev/null || true
wait "$TS_PID" 2>/dev/null || true
CONTROL_PORT=34784
sed -e '/^no-tcp-relay$/d' -e "s/^listening-port=$PORT\$/listening-port=$CONTROL_PORT/" \
  -e 's/^tls-listening-port=.*/tls-listening-port=34785/' "$WORK/turnserver.conf" >"$WORK/control.conf"
turnserver -c "$WORK/control.conf" --pidfile= >"$WORK/stdout" 2>&1 &
TS_PID=$!
for _ in $(seq 1 30); do
  turn_udp_port_bound "$CONTROL_PORT" && break
  sleep 0.5
done
verdict=$(turn_tcp_relay_probe 127.0.0.1 "$CONTROL_PORT" "$SECRET")
[ "$verdict" = granted ] || fail "negative control: without no-tcp-relay the probe said '$verdict', expected 'granted' — the probe cannot see a TCP relay"
echo "ok    negative control: without no-tcp-relay the same config DOES grant a TCP relay, and the probe sees it"

echo "PASS  turnserver.conf.template renders into a working relay config"
