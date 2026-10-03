#!/usr/bin/env bash
#
# Does the LIVE relay actually work end to end?
#
# `tests/turn-relay.test.ts` proves the CONTRACT on every push: a credential minted by
# the signaling server opens an allocation on a coturn configured with the same secret, and one
# minted under a different secret is refused. What it cannot prove is that THIS host's two services
# still agree — they are separate units with separate config (the signaling .env `TURN_SECRET` vs coturn's
# `static-auth-secret`). deploy/turn/install.sh renders the second from the first, but a `.env` changed
# without re-running it drifts again, and nothing on the box notices when that happens.
#
# The drift is invisible by design, which is why it needs a deliberate check. Every symptom stays
# green: the mint still succeeds, the client still assembles a TURN iceServer, the UI still says
# Reliable. Only the allocation fails — and only for the users whose direct path already failed, who
# are exactly the ones the mode exists for. The first report would come from a user, if it came.
#
# Run it after deploying, after touching either config, and whenever "Reliable" is in doubt:
#
#   bash deploy/turn/verify-relay.sh
#
# Reads the same server env the signaling service runs with (default /var/www/hush-signaling-server/.env)
# for TURN_URLS only — it never reads, prints or needs TURN_SECRET. The credential it uses is minted
# over the WebSocket exactly as a browser would, so this exercises the real path, not a reimplementation.
#
# Needs: node (for the WebSocket), turnutils_uclient (package `coturn`).
set -euo pipefail

SIGNALING_URL="${SIGNALING_URL:-ws://127.0.0.1:8080}"
ORIGIN="${ORIGIN:-https://hushsend.frelikh.dev}"
ENV_FILE="${ENV_FILE:-/var/www/hush-signaling-server/.env}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
fail() {
  printf '\033[1mFAIL\033[0m  %s\n' "$1" >&2
  exit 1
}

command -v node >/dev/null || fail "node not found"
command -v turnutils_uclient >/dev/null || fail "turnutils_uclient not found — install the 'coturn' package"

bold "▶ mint a credential from the live signaling server"
# Node's global WebSocket (22+). Prints "urls<TAB>username<TAB>credential" or exits non-zero.
CREDS=$(node -e '
const url = process.argv[1] + "?app=filetransfer&create=1&codeType=word";
const ws = new WebSocket(url, { headers: { Origin: process.argv[2] } });
const die = (m) => { console.error(m); process.exit(1); };
const t = setTimeout(() => die("timeout waiting for turn-credentials"), 10000);
ws.onerror = () => {};
ws.onclose = (e) => die("signaling socket closed before credentials: " + e.code);
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.type === "welcome") return ws.send(JSON.stringify({ type: "turn-request" }));
  if (m.type !== "turn-credentials") return;
  clearTimeout(t); ws.onclose = null;
  if (!m.urls || m.urls.length === 0) die("the signaling server returned NO relay urls — TURN_SECRET empty or the app is not managed");
  console.log([m.urls.join(","), m.username, m.credential].join("\t"));
  try { ws.close(); } catch {}
  process.exit(0);
};
' "$SIGNALING_URL" "$ORIGIN") || fail "could not mint a credential from $SIGNALING_URL"

URLS=$(printf '%s' "$CREDS" | cut -f1)
USERNAME=$(printf '%s' "$CREDS" | cut -f2)
CREDENTIAL=$(printf '%s' "$CREDS" | cut -f3)

NOW=$(date +%s)
printf '  urls      : %s\n' "$URLS"
printf '  username  : %s (expires in %ss)\n' "$USERNAME" "$((USERNAME - NOW))"
printf '  credential: %s chars (never printed)\n' "${#CREDENTIAL}"
[ "$USERNAME" -gt "$NOW" ] || fail "the minted username is not a FUTURE unix-expiry — coturn will refuse every allocation"

# TURN_URLS is a client-facing hostname, not a secret; take the first one and split host/port.
FIRST_URL=$(printf '%s' "$URLS" | cut -d, -f1)
HOSTPORT=${FIRST_URL#turn:}
HOSTPORT=${HOSTPORT#turns:}
HOSTPORT=${HOSTPORT%%\?*}
TURN_HOST=${HOSTPORT%%:*}
TURN_PORT=${HOSTPORT##*:}
[ "$TURN_PORT" = "$TURN_HOST" ] && TURN_PORT=3478

bold "▶ open a real allocation on $TURN_HOST:$TURN_PORT and push data through it"
OUT=$(turnutils_uclient -y -u "$USERNAME" -w "$CREDENTIAL" -p "$TURN_PORT" -n 4 -m 1 "$TURN_HOST" 2>&1 || true)
RELAYED=$(printf '%s' "$OUT" | grep -oE 'tot_recv_msgs=[0-9]+' | tail -1 | cut -d= -f2 || true)
RELAYED=${RELAYED:-0}

if [ "$RELAYED" -gt 0 ]; then
  printf '  relayed   : %s messages\n' "$RELAYED"
  printf '%s\n' "$OUT" | grep -E 'Total lost packets|round trip delay' | sed 's/^/  /' || true
  bold "▶ OK — the live signaling server and coturn share the same secret, and the relay carries data"
  exit 0
fi

printf '%s\n' "$OUT" | tail -20 | sed 's/^/  /'
cat >&2 <<'WHY'

The mint succeeded but the allocation did not. Reliable mode is therefore degraded to direct-only on
this host RIGHT NOW: users whose direct path fails will not connect, and the UI cannot tell them why
beyond the relay-unavailable hint. Most likely, in order:
  1. the signaling .env TURN_SECRET != coturn static-auth-secret (the usual cause; deploy/turn/install.sh renders one from the other — was it run since the .env changed?);
  2. coturn is not running, or not listening on the port TURN_URLS advertises;
  3. the relay port range (min-port..max-port) is closed in the firewall / not forwarded by the router;
  4. TURN_URLS points at a host that is not this coturn.
WHY
fail "the live relay refused a credential the live signaling server minted"
