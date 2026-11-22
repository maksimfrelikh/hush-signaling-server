# shellcheck shell=bash
# ============================================================================
# Shared checks for the TURN relay — sourced by install.sh (on the host) and
# check-template.sh (in CI). Needs openssl, node (relay-probe.mjs), and coturn's
# client tools (turnutils_*) or docker to run them from the image below.
# ============================================================================

TURN_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# coturn itself: its official image, pinned by digest so a re-pushed tag cannot change what runs.
# Ubuntu's coturn package (universe) gets no security fixes. To upgrade, change this line and the
# same one in hushsend-stun-server, then run install.sh; CI tests exactly this image.
COTURN_IMAGE=coturn/coturn:4.19.2-r0@sha256:ccdbc51e6f072130b0fc9eebda21f8d026d0a25581746c52557e887818011a3f

# The client tools: the host's own where installed (a dev box, CI's wrappers), else from the image.
# `--init`: a tool running as PID 1 would ignore the SIGTERM that `timeout` sends.
if command -v turnutils_uclient >/dev/null 2>&1; then
  TURN_STUNCLIENT=(turnutils_stunclient)
  TURN_UCLIENT=(turnutils_uclient)
else
  TURN_STUNCLIENT=(docker run --rm --init --network host --entrypoint turnutils_stunclient "$COTURN_IMAGE")
  TURN_UCLIENT=(docker run --rm --init --network host --entrypoint turnutils_uclient "$COTURN_IMAGE")
fi

# `timeout` is coreutils; macOS lacks it. The perl fallback is the classic portable one: alarm()
# survives exec, so the command itself is killed by SIGALRM when the time is up.
_turn_timeout() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else perl -e 'alarm shift; exec @ARGV' "$@"; fi; }

# Is something listening on this UDP port? (`ss` on Linux, `lsof` elsewhere.)
turn_udp_port_bound() { # port
  if command -v ss >/dev/null 2>&1; then ss -lun | grep -qE "[:.]$1[[:space:]]"; else lsof -nP -iUDP:"$1" >/dev/null 2>&1; fi
}

# A credential exactly as the signaling server mints one (use-auth-secret /
# TURN REST API scheme): username = a future unix expiry,
# password = base64(HMAC-SHA1(secret, username)).
turn_mint_user() { echo $(($(date +%s) + ${1:-600})); }
turn_mint_password() { printf '%s' "$1" | openssl dgst -sha1 -hmac "$2" -binary | base64; }

# STUN binding over UDP. Prints the mapped address, fails if none came back.
turn_stun_check() { # host port
  local out addr
  out=$(_turn_timeout 15 "${TURN_STUNCLIENT[@]}" -p "$2" "$1" 2>&1 || true)
  addr=$(printf '%s' "$out" | grep -oiE 'reflexive addr: [0-9a-f.:]+' | head -1 | sed 's/.*: //')
  [ -n "$addr" ] || { printf '%s\n' "$out" | tail -5 >&2; return 1; }
  printf '%s\n' "$addr"
}

# One allocation attempt with relay-probe.mjs, which releases the allocation it
# gets. Prints "allocated", or "allocation refused: <code> <reason>".
turn_alloc_attempt() { # host port user password
  _turn_timeout 40 env TURN_USERNAME="$3" TURN_CREDENTIAL="$4" node "$TURN_LIB_DIR/relay-probe.mjs" --allocate-only "$1" "$2" 2>&1 || true
}

# A correctly minted credential must be accepted.
turn_alloc_accepted() { # host port secret
  local user pass out
  user=$(turn_mint_user)
  pass=$(turn_mint_password "$user" "$3")
  out=$(turn_alloc_attempt "$1" "$2" "$user" "$pass")
  if ! printf '%s' "$out" | grep -qx 'allocated'; then
    printf '%s\n' "$out" | tail -8 >&2
    return 1
  fi
  return 0
}

# NEGATIVE CONTROL: a credential minted under a different secret must be refused.
# Without it, a relay with authentication switched off would pass the check above.
turn_alloc_refused() { # host port secret
  local user pass out
  user=$(turn_mint_user)
  pass=$(turn_mint_password "$user" "not-$3")
  out=$(turn_alloc_attempt "$1" "$2" "$user" "$pass")
  printf '%s' "$out" | grep -q '^allocation refused: 401'
}

# Ask for an RFC 6062 TCP RELAY (`-t -T`: TCP to the server, TCP allocation) with a correctly
# minted credential. Nothing outside the host is contacted: with a loopback relay-ip (CI) a granted
# allocation stops at CreatePermission (403), with a public one the client relays between its own
# two allocations on this host. Prints:
#   refused  — 442 "TCP Transport is not allowed": no-tcp-relay is in effect
#   granted  — the allocation went through (CreatePermission reached, or the connections completed)
#   unknown  — anything else, e.g. no answer; proves nothing either way
turn_tcp_relay_probe() { # host port secret
  local user pass out
  user=$(turn_mint_user)
  pass=$(turn_mint_password "$user" "$3")
  out=$(_turn_timeout 40 "${TURN_UCLIENT[@]}" -t -T -u "$user" -w "$pass" -p "$2" -e 127.0.0.1 -r 9 -n 1 -m 1 "$1" 2>&1 || true)
  if printf '%s' "$out" | grep -q 'error 442'; then
    echo refused
  elif printf '%s' "$out" | grep -qiE 'create permission|connections are completed'; then
    echo granted
  else
    printf '%s\n' "$out" | tail -5 >&2
    echo unknown
  fi
}

# coturn log files newer than the given reference file, in every place coturn
# falls back to — including the private /tmp of a systemd unit with PrivateTmp.
turn_new_log_files() { # reference-file
  find /var/log /var/tmp /tmp -maxdepth 4 -name 'turn_*.log' -newer "$1" 2>/dev/null || true
}
