#!/usr/bin/env bash
# ============================================================================
# Render turnserver.conf.template to stdout.
#
#   STATIC_AUTH_SECRET=<the signaling server's TURN_SECRET> \
#     bash deploy/turn/render.sh <turn.env> [template]
#
# Used by install.sh (on the host) and check-template.sh (in CI). Replacement is
# literal (awk index/substr), so a secret with &, \, | or / in it cannot break
# the output the way a sed substitution would.
# ============================================================================
set -euo pipefail

ENV_FILE="${1:-}"
TEMPLATE="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/turnserver.conf.template}"

if [ -z "$ENV_FILE" ]; then
  echo "usage: STATIC_AUTH_SECRET=… $0 <turn.env> [template]" >&2
  exit 2
fi
[ -r "$ENV_FILE" ] || { echo "render: cannot read $ENV_FILE" >&2; exit 2; }
[ -r "$TEMPLATE" ] || { echo "render: cannot read $TEMPLATE" >&2; exit 2; }

# turn.env is ours: plain KEY=value lines. Read it in a subshell-free way and
# export only the keys we know, so nothing else in the file leaks into the run.
REALM= LISTEN_PORT= TLS_LISTEN_PORT= EXTERNAL_IP= MIN_PORT= MAX_PORT= USER_QUOTA= TOTAL_QUOTA= MAX_BPS=
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in '' | '#'*) continue ;; esac
  key=${line%%=*}
  val=${line#*=}
  case "$key" in
    REALM | LISTEN_PORT | TLS_LISTEN_PORT | EXTERNAL_IP | MIN_PORT | MAX_PORT | USER_QUOTA | TOTAL_QUOTA | MAX_BPS)
      printf -v "$key" '%s' "$val" ;;
    *) echo "render: $ENV_FILE: unknown key '$key' (ignored)" >&2 ;;
  esac
done <"$ENV_FILE"

fail() { echo "render: $*" >&2; exit 2; }
[ -n "${STATIC_AUTH_SECRET:-}" ] || fail "STATIC_AUTH_SECRET is empty — pass the signaling server's TURN_SECRET"
case "$STATIC_AUTH_SECRET" in *[[:space:]]*) fail "the secret contains whitespace — coturn would truncate it" ;; esac
[ -n "$REALM" ] || fail "$ENV_FILE: REALM is empty"
for v in LISTEN_PORT TLS_LISTEN_PORT MIN_PORT MAX_PORT USER_QUOTA TOTAL_QUOTA MAX_BPS; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || fail "$ENV_FILE: $v must be a number, got '${!v}'"
done
[ "$MIN_PORT" -lt "$MAX_PORT" ] || fail "MIN_PORT ($MIN_PORT) must be below MAX_PORT ($MAX_PORT)"
[ "$LISTEN_PORT" != "$TLS_LISTEN_PORT" ] || fail "LISTEN_PORT and TLS_LISTEN_PORT must differ"
if [ -n "$EXTERNAL_IP" ] && ! [[ "$EXTERNAL_IP" =~ ^[0-9a-fA-F.:]+(/[0-9a-fA-F.:]+)?$ ]]; then
  fail "EXTERNAL_IP must be PUBLIC or PUBLIC/PRIVATE, got '$EXTERNAL_IP'"
fi

export STATIC_AUTH_SECRET REALM LISTEN_PORT TLS_LISTEN_PORT EXTERNAL_IP MIN_PORT MAX_PORT USER_QUOTA TOTAL_QUOTA MAX_BPS

out=$(awk '
  function repl(s, key, val,    out, i) {
    out = ""
    while ((i = index(s, key)) > 0) {
      out = out substr(s, 1, i - 1) val
      s = substr(s, i + length(key))
    }
    return out s
  }
  {
    line = $0
    if (line == "external-ip=@EXTERNAL_IP@" && ENVIRON["EXTERNAL_IP"] == "") {
      print "# external-ip is not set: this host has its public address on an interface"
      next
    }
    n = split("STATIC_AUTH_SECRET REALM LISTEN_PORT TLS_LISTEN_PORT EXTERNAL_IP MIN_PORT MAX_PORT USER_QUOTA TOTAL_QUOTA MAX_BPS", keys, " ")
    for (k = 1; k <= n; k++) line = repl(line, "@" keys[k] "@", ENVIRON[keys[k]])
    print line
  }
' "$TEMPLATE")

if printf '%s\n' "$out" | grep -qE '@[A-Z_]+@'; then
  fail "a placeholder survived rendering: $(printf '%s\n' "$out" | grep -oE '@[A-Z_]+@' | sort -u | tr '\n' ' ')"
fi
printf '%s\n' "$out"
