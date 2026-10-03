# shellcheck shell=bash
# ============================================================================
# Shared checks for the TURN relay — sourced by install.sh (on the host) and
# check-template.sh (in CI). Needs the coturn client tools (turnutils_*) and
# openssl.
# ============================================================================

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
  out=$(_turn_timeout 15 turnutils_stunclient -p "$2" "$1" 2>&1 || true)
  addr=$(printf '%s' "$out" | grep -oiE 'reflexive addr: [0-9a-f.:]+' | head -1 | sed 's/.*: //')
  [ -n "$addr" ] || { printf '%s\n' "$out" | tail -5 >&2; return 1; }
  printf '%s\n' "$addr"
}

# One allocation attempt; prints turnutils_uclient's output. `-y` makes the client
# relay to itself, so no outside peer is needed. Against a relay that denies
# loopback and private peers (this one does), the data step is refused with a
# 403 AFTER a successful allocation — which is fine: what these checks read is
# whether the ALLOCATION (i.e. the credential) was accepted.
turn_alloc_attempt() { # host port user password
  _turn_timeout 40 turnutils_uclient -y -u "$3" -w "$4" -p "$2" -n 1 -m 1 "$1" 2>&1 || true
}

# A correctly minted credential must be accepted. coturn's client prints
# "Cannot complete Allocation" when the credential is refused.
turn_alloc_accepted() { # host port secret
  local user pass out
  user=$(turn_mint_user)
  pass=$(turn_mint_password "$user" "$3")
  out=$(turn_alloc_attempt "$1" "$2" "$user" "$pass")
  if printf '%s' "$out" | grep -q 'Cannot complete Allocation'; then
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
  printf '%s' "$out" | grep -q 'Cannot complete Allocation'
}

# coturn log files newer than the given reference file, in every place coturn
# falls back to — including the private /tmp of a systemd unit with PrivateTmp.
turn_new_log_files() { # reference-file
  find /var/log /var/tmp /tmp -maxdepth 4 -name 'turn_*.log' -newer "$1" 2>/dev/null || true
}
