# hush-signaling-server — deployment runbook

Two services, one operator: the **signaling server** (Node, this repo's code) and the **TURN relay**
(coturn, `deploy/turn/`) that Reliable mode falls back to. They share one secret, which is why they
live together. STUN for hushsend clients is NOT here — it is
[hushsend-stun-server](https://github.com/maksimfrelikh/hushsend-stun-server), a separate service
meant to end up under a different operator. The static frontend and the nginx vhost are in the
[hushsend](https://github.com/maksimfrelikh/hushsend) repo.

## 0. As deployed — laptop-server (hushsend.frelikh.dev)

| | |
|---|---|
| Checkout | `/var/www/hush-signaling-server` — a git clone of this repo (the dev clone is `~/projects/hush-signaling-server`) |
| Unit | `hushsend-signaling.service` = [`deploy/hushsend-signaling.service`](hushsend-signaling.service), runs as `frelikh`, system `/usr/bin/node` (v22) |
| Env | `/var/www/hush-signaling-server/.env`, mode 0600 — every variable is in [`.env.example`](../.env.example); `TRUST_PROXY=1`, `TURN_SECRET` set, `TURN_URLS=turn:turn.hushsend.frelikh.dev:3478` |
| Listens | `127.0.0.1:8080` only; nginx's `hushsend` vhost proxies `/ws` and `/health` to it with `X-Real-IP` (template: hushsend `deploy/nginx.conf.example`) |
| TURN | the distro's `coturn.service` with `/etc/turnserver.conf` rendered from [`deploy/turn/`](turn/) — `turn:` on 3478, relay 49160–49200/udp, `external-ip=<public>/<lan>` (home NAT), no `turns:` |
| Router + ufw | 80/443 tcp (nginx), 3478 tcp+udp (TURN), 49160–49200 udp (relay range) |

The box itself — network, firewall, other services, secrets — is described in the owner's private
`laptop-server/` notes, not here.

## 1. Signaling — install on a new host

```bash
sudo mkdir -p /var/www && sudo chown "$USER" /var/www
git clone https://github.com/maksimfrelikh/hush-signaling-server.git /var/www/hush-signaling-server
cd /var/www/hush-signaling-server
npm ci --omit=dev
cp .env.example .env && chmod 600 .env     # then edit: TRUST_PROXY=1, TURN_SECRET, TURN_URLS
sudo cp deploy/hushsend-signaling.service /etc/systemd/system/   # edit User/Group/paths first
sudo systemctl daemon-reload && sudo systemctl enable --now hushsend-signaling
curl -s 127.0.0.1:8080/health      # → ok
journalctl -u hushsend-signaling -n 5 | grep '\[config\]'
```

- **`TRUST_PROXY=1` and nginx's `proxy_set_header X-Real-IP $remote_addr;` are a pair.** Without
  both, every client looks like 127.0.0.1: the per-IP caps collapse into one bucket and the 4011
  rate limit (loopback-exempt) switches itself off. The `[config]` line shows `trustProxy=on`.
- nginx must proxy the WebSocket upgrade on `/ws` and keep `proxy_read_timeout` well above
  `PING_MS` (30 s).
- The allowed browser Origins are in the code (`APPS` in `signaling-server.js`):
  `https://hushsend.frelikh.dev` for `filetransfer`. A deployment under another domain changes it there.
- Node 22 or newer.

## 2. Updates

```bash
bash /var/www/hush-signaling-server/deploy/deploy.sh
```

Pull (fast-forward only) → `npm ci --omit=dev` → restart → `/health` → the `[config]` line. Keep that
order: `node_modules` is not in git, so a pull that changes dependencies needs the install before
the restart. A protocol change also needs the hushsend client deployed in the right order — the
commit message of the change says which side goes first.

## 3. Restart without a password

`sudo systemctl restart` asks for a password on laptop-server, so `deploy.sh` falls back to SIGKILL:
the unit has `Restart=on-failure`, and systemd relaunches it within 2 s (a clean SIGTERM exit would
NOT be restarted). Used 2026-09-25 and 2026-10-01. A narrow NOPASSWD rule removes the need for it
— add it once with `sudo visudo -f /etc/sudoers.d/frelikh-deploy`:

```
Cmnd_Alias HUSH_RESTART = /usr/bin/systemctl restart hushsend-signaling, /usr/bin/systemctl restart coturn, /usr/bin/systemctl restart hushsend-stun
frelikh ALL=(root) NOPASSWD: HUSH_RESTART
```

## 4. TURN relay (Reliable mode)

What it does, why the secret is shared and what each line of the config is for: the header and the
comments of [`turn/turnserver.conf.template`](turn/turnserver.conf.template).

### 4.1 The files

| File | What it is |
|---|---|
| `turn/turnserver.conf.template` | the coturn config, with per-host values as `@…@` |
| `turn/turn.env.example` | the per-host values; on a host they live in `/etc/hushsend-turn/turn.env` (0600) |
| `turn/render.sh` | renders the template; the secret comes in as `STATIC_AUTH_SECRET` |
| `turn/install.sh` | renders with the secret from the signaling `.env`, installs `/etc/turnserver.conf`, restarts coturn, checks, rolls back on failure |
| `turn/verify-relay.sh` | end to end: mints a credential from the LIVE signaling server and pushes data through the relay |
| `turn/check-template.sh` | CI: the template loads in a real coturn and authenticates with the secret |
| `turn/lib.sh` | the shared checks |

### 4.2 laptop-server: take over the coturn that already runs

```bash
bash /var/www/hush-signaling-server/deploy/deploy.sh          # brings the checkout (and deploy/turn) up to date
cd /var/www/hush-signaling-server
sudo bash deploy/turn/install.sh --import --dry-run   # writes /etc/hushsend-turn/turn.env, shows the diff
sudo bash deploy/turn/install.sh                      # installs, restarts coturn, checks, rolls back on failure
```

`--import` copies realm, ports, `external-ip` and the quotas from the current `/etc/turnserver.conf`
into `/etc/hushsend-turn/turn.env`, once. The diff then shows only what the template adds: logging
off (`log-file=/dev/null` — without it coturn writes `turn_*.log` with client addresses into
`/var/tmp` or the unit's private `/tmp`), explicit denies for `0.0.0.0/8`, `127.0.0.0/8` and IPv6
ULA, `no-software-attribute`, an explicit `tls-listening-port`, and no `proc-user` (the systemd unit
already runs coturn as `turnserver`). The installer refuses to run while coturn's current secret
differs from the signaling `TURN_SECRET` — that state means Reliable mode is broken right now.

### 4.3 A new host

```bash
sudo mkdir -p /etc/hushsend-turn && sudo chmod 700 /etc/hushsend-turn
sudo cp deploy/turn/turn.env.example /etc/hushsend-turn/turn.env && sudo chmod 600 /etc/hushsend-turn/turn.env
sudo nano /etc/hushsend-turn/turn.env      # REALM, EXTERNAL_IP if behind NAT, the relay range
sudo bash deploy/turn/install.sh           # installs coturn itself if it is missing
```

Open in the firewall (and forward on the router, behind NAT): `LISTEN_PORT` tcp+udp and the whole
`MIN_PORT`–`MAX_PORT` range udp. DNS: the `REALM` name → this host. Then point `TURN_URLS` in the
signaling `.env` at it and restart the signaling server.

**TURN on a different host than signaling** (a VPS later): the secret must exist on both. Copy
`TURN_SECRET` into a root-only file there and pass it with `--signaling-env <that file>` — the
installer reads only the `TURN_SECRET=` line from it.

### 4.4 After changing `TURN_SECRET`

Rotate in this order: write the new value into the signaling `.env` → `sudo bash
deploy/turn/install.sh --force` (renders coturn's copy from it) → `bash deploy/deploy.sh` (restarts
signaling with it). Between the second and third step, credentials minted with the old secret are
refused — do it at a quiet hour.

### 4.5 Check

```bash
bash deploy/turn/verify-relay.sh     # on the host: mint from the live signaling server, relay data
```

Run it after any change to either service. The installer runs it at the end too, but only reports
its result: it also depends on the router hairpinning the public address.

### 4.6 Capacity

One UDP port per allocation, two when both sides of a pair relay: 49160–49200 is ~41 allocations,
whatever `total-quota` says. To serve more, widen `MIN_PORT`–`MAX_PORT` in `turn.env`, the firewall
and the router together. `MAX_BPS` (5 MB/s per session) is what binds on a fast path.
