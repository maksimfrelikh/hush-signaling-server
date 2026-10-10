# hush-signaling-server — guide for Claude Code

The server side of hushsend that its operator runs: the signaling server (`signaling-server.js`,
Node + `ws`) and the config of the TURN relay (`deploy/turn/`). Start with [README.md](README.md)
(apps, rendezvous, protocol) and [deploy/DEPLOY.md](deploy/DEPLOY.md) (what runs where).

## The three repositories

| Repo | Owns |
|---|---|
| [hushsend](https://github.com/maksimfrelikh/hushsend) | the client; the nginx vhost (`/ws` proxy); the client's view of the protocol (zod schemas) |
| **hush-signaling-server** (this) | signaling + the TURN relay; their integration tests; their deploy |
| [hushsend-stun-server](https://github.com/maksimfrelikh/hushsend-stun-server) | STUN for clients, run apart from this operator |

- Client and server share **no code** on purpose. A protocol change lands in this repo AND in
  hushsend (`src/types/protocol.ts`, SessionController) in the same pass, with the deploy order
  written in the commit message.
- hushsend's e2e suite runs this server from its pinned devDependency
  (`"hush-signaling-server": "github:maksimfrelikh/hush-signaling-server#<sha>"`). After a change
  here, bump that pin in hushsend so its e2e runs against it.
- There is no other copy of this server anywhere. hushsend used to carry one in `server/`; it
  drifted and was removed on 2026-10-03.

## Invariants

- **Pure signaling.** Never carries, stores or logs app data. The server is untrusted; nothing here
  may become a security property the client relies on — limits and TTLs are hygiene, not authn.
- **Binds loopback; behind nginx with `TRUST_PROXY=1` + `X-Real-IP`.** Without the pair every
  client is 127.0.0.1 and the per-IP limits collapse (deploy/DEPLOY.md § 1).
- **`.env.example` lists every variable the code reads**, with its default. Add the line in the
  same commit as the `process.env` read.
- **`TURN_SECRET` exists in two places on a host — the signaling `.env` and coturn's config — and
  the second is rendered from the first** by `deploy/turn/install.sh`. Never edit
  `/etc/turnserver.conf` by hand: change the template or the host's `/etc/hushsend-turn/turn.env`
  and re-run the installer.
- **coturn must not log.** `log-file=/dev/null` stays in the template; `check-template.sh` fails if
  coturn writes a log file or prints to stdout (an option it does not know prints a warning and
  creates `/var/tmp/turn_*.log` before `log-file` is read — that is why `no-loopback-peers` is gone).
- **UDP relays only.** `no-tcp-relay` stays in the template: WebRTC never asks for an RFC 6062 TCP
  relay, and granting one makes the host a TCP proxy for anyone who mints a credential from the
  public `/ws`. `check-template.sh` proves the refusal (442) and, as a negative control, that the
  same config without the line grants one; `install.sh` re-checks it on the host after a restart.
- The managed-room rules (TTL until connected, 1:1 seat caps for word and token rooms, the per-IP
  attempt limit, join-or-create token rooms) are explained in the header comments of
  `signaling-server.js`; keep those comments true when the code changes.

## Tests

`npm test` — vitest over `tests/`: rooms, words, tokens, TURN credentials, and a real relay
(`turn-relay.test.ts` needs `turnserver` + `turnutils_uclient`; it skips without them unless
`REQUIRE_RELAY_TEST=1`). Each file spawns its own server on a fixed loopback port (8091–8110, TURN
3489) — keep new ones distinct, files run in parallel. `bash deploy/turn/check-template.sh` checks
the TURN template against a real coturn. CI runs all of it on every push (coturn 4.6.1 from Ubuntu,
the version laptop-server runs).

On the Mac the Bash sandbox cannot bind ports: run the suite in a terminal tab
(`PATH=/opt/homebrew/bin:$PATH npx vitest run`). Homebrew's coturn is 4.18, which no longer knows
`--no-cli` / `--no-dtls`; the relay test passes them only to coturn ≤4.6. All 28 tests passed there
on 2026-10-03, the relay included.

## Deploy

Deploys are the owner's: they run `deploy/deploy.sh` and `deploy/turn/install.sh` on the host. Write
the change, say which command to run, and verify afterwards (`curl 127.0.0.1:8080/health`, the
`[config]` line, `deploy/turn/verify-relay.sh`). Keep deploy/DEPLOY.md § 0 true for laptop-server.
