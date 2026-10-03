# hush-signaling-server

Signaling for [hushsend](https://github.com/maksimfrelikh/hushsend) — and for hushclip, the
shared-clipboard app on the same server. A WebSocket rendezvous that relays opaque SDP/ICE between
browsers and **never carries file data**. It is untrusted by design: confidentiality and
authenticity are established client-side (a PAKE, a SAS compared by two humans, or a link secret —
each bound to the DTLS fingerprints), so a hostile copy of this server can refuse service but cannot
read or impersonate anyone.

This repo is the whole server side its operator runs:

| Part | What | Runs as |
|---|---|---|
| signaling | `signaling-server.js` — Node + `ws` | systemd `hushsend-signaling`, loopback `:8080` behind nginx |
| TURN relay | coturn config for hushsend's Reliable mode — [`deploy/turn/`](deploy/turn/) | the distro's `coturn.service` |

They share one secret (`TURN_SECRET` = coturn's `static-auth-secret`), which is why they live together;
the installer renders coturn's copy from the signaling `.env`. **STUN** for hushsend clients is a
different project, [hushsend-stun-server](https://github.com/maksimfrelikh/hushsend-stun-server), kept
apart on purpose — it is meant to end up under a different operator.

## Apps and rendezvous

`filetransfer` (hushsend) — every room is *managed*: it expires 3 minutes after it comes into being if
nobody connects (`room-closed`, close 4010, the code is freed), and create/join attempts are
rate-limited per IP (60/min, close 4011).

| codeType | Code | Seats | Used by |
|---|---|---|---|
| *(default)* | 4 digits, allocated by the server | a lobby of up to 8 (`FILETRANSFER_MAX_PEERS`); the TTL is an idle timeout | the room method |
| `word` | one word of the EFF short list, allocated by the server | 1:1 | the words method |
| `token` | 22 base64url characters (128 bits), **taken** by the client — join-or-create | 1:1 | link / QR and the codeless reconnect — indistinguishable to this server |

`clipboard` (hushclip) — a shared-code mesh of one person's own devices: no TTL, no rate limit, no relay.

## Protocol

JSON text frames on `wss://<host>/ws?app=<id>&…`:

- connect: `create=1[&codeType=word]` allocates a room; `room=<code>[&codeType=word|token]` joins one
  (a token room is created by its first arrival).
- server → peer: `welcome {selfId, room, peers: [{id, joinedAt}]}`, `peer-joined {peerId, joinedAt}`,
  `peer-left {peerId}`, `room-closed {reason}`, `turn-credentials {urls, username, credential, ttl}`.
- peer → server: `signal {to, data}` (delivered as `signal {from, data}` — the server sets `from`),
  `turn-request`, `destroy` (managed rooms).
- close codes: 4000 unknown app · 4001 bad room · 4002 room full · 4003 origin not allowed · 4005 no
  free rooms / server busy · 4006 too many connections · 4007 too many from your network · 4008 rate
  limit · 4009 room not found · 4010 expired · 4011 too many attempts.

The hushsend client validates every frame with zod (`src/types/protocol.ts` there). Client and server
share no code on purpose, so **a protocol change lands in both repositories in the same pass.**

## Run it

```bash
npm ci
npm start                 # 127.0.0.1:8080; NODE_ENV≠production allows http://localhost:5173 (DEV_ORIGINS)
npm test                  # integration tests: rooms, words, tokens, TURN credentials, a real relay
```

The relay test needs coturn's `turnserver` and `turnutils_uclient` on the PATH and skips without
them; `REQUIRE_RELAY_TEST=1` (set in CI) makes their absence a failure. Every variable the server
reads is in [`.env.example`](.env.example).

hushsend's own e2e suite runs this server: hushsend pins this repository by commit in its
`devDependencies` (`hush-signaling-server`) and starts `node_modules/hush-signaling-server/signaling-server.js`.
After changing the server, bump that pin there.

## Deploy

[`deploy/DEPLOY.md`](deploy/DEPLOY.md): install, updates (`deploy/deploy.sh`), restarting without a
password, and the TURN relay (`deploy/turn/install.sh`).

## License

MIT — see [LICENSE](LICENSE).
