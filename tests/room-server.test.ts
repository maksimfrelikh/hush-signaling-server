import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';

/**
 * Integration coverage for the 4-digit ROOM hardening in signaling-server.js (step 6a). The
 * 4-digit room/link/QR rendezvous now reuses the same anti-farming hygiene the words rooms had:
 *   - strictly 1:1 (creator + one joiner) — a 3rd joiner is bounced with 4002 'room full';
 *   - a TTL invalidates a room that never connects and FREES its 4-digit code (4009 afterwards;
 *     a token room is join-or-create, so it can simply be taken again);
 *     after connected, closing signaling does NOT drop live P2P — that part is the client's job
 *     and is covered by the ws-close e2e (the 1:1 client closes its own socket on connect), so here
 *     we only assert the rendezvous-window teardown;
 *   - per-IP create/join attempts are rate-limited (4011) to slow enumeration of the 10k space,
 *     keyed on clientIp() (X-Real-IP behind nginx). Loopback is EXEMPT — behind nginx a real client
 *     never looks like loopback, so the local proxy/dev/tests are never throttled.
 *
 * Each concern spawns its OWN signaling server (own port + env) and drives it with Node's global
 * WebSocket (undici), which lets us set the Origin the server requires and a fake X-Real-IP. SAS /
 * key-confirmation defeat a MITM regardless — these caps are abuse hygiene, not authn.
 */

const ORIGIN = 'http://localhost:5173'; // a dev origin the server trusts under NODE_ENV=development

/** A tiny promise-friendly WebSocket client that records inbound JSON frames and the close event. */
class TestClient {
  readonly ws: WebSocket;
  readonly messages: Record<string, unknown>[] = [];
  closeEvent: { code: number; reason: string } | null = null;

  constructor(url: string, headers: Record<string, string>) {
    this.ws = new WebSocket(url, { headers } as unknown as string[]);
    this.ws.onmessage = (e) => {
      try {
        this.messages.push(JSON.parse(String(e.data)));
      } catch {
        /* ignore non-JSON */
      }
    };
    this.ws.onclose = (e) => {
      this.closeEvent = { code: e.code, reason: e.reason };
    };
    this.ws.onerror = () => {}; // a connection error surfaces as a close; don't crash the test
  }

  opened(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('close', (e) => reject(new Error(`closed before open: ${e.code}`)), { once: true });
    });
  }

  /** Wait for a frame whose `type` matches; rejects on timeout. */
  waitFor(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const found = this.messages.find((m) => m.type === type);
      if (found) return resolve(found);
      const start = Date.now();
      const id = setInterval(() => {
        const hit = this.messages.find((m) => m.type === type);
        if (hit) {
          clearInterval(id);
          resolve(hit);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(id);
          reject(new Error(`timeout waiting for '${type}'`));
        }
      }, 20);
    });
  }

  /** Wait for the socket to close; rejects on timeout. */
  waitClose(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      if (this.closeEvent) return resolve(this.closeEvent);
      const start = Date.now();
      const id = setInterval(() => {
        if (this.closeEvent) {
          clearInterval(id);
          resolve(this.closeEvent);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(id);
          reject(new Error('timeout waiting for close'));
        }
      }, 20);
    });
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

const live: TestClient[] = [];
afterEach(() => {
  for (const c of live.splice(0)) c.close();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Refuse to run against a server we did not spawn.
 *
 * `waitForHealth` asks `/health` and takes `ok` for "my server is up" — but ANY server on that port
 * answers it. When the port is already taken (a stray `E2E_SIGNALING_PORT`, a leftover run, or the
 * other integration file: 8099/8100 were duplicated across two files that Vitest runs in PARALLEL),
 * our own spawn dies with EADDRINUSE into `stdio: 'ignore'`, the health check passes against the
 * STRANGER, and every assertion then fails as `timeout waiting for 'welcome'` — a message that
 * describes neither the cause nor the fix. Observed for real on 2026-09-17.
 *
 * This is the same hazard playwright.config.ts documents for its own `reuseExistingServer`; the
 * integration suite simply had no equivalent guard. Fail loudly and say what to do instead.
 */
async function assertPortFree(port: number): Promise<void> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `port ${port} is already in use — this test spawns its OWN signaling server and would ` +
              `silently attach to the stranger instead. Stop whatever holds ${port} (a dev/e2e run?) ` +
              `and retry.`
            : `cannot probe port ${port}: ${err.message}`,
        ),
      ),
    );
    srv.once('listening', () => srv.close(() => resolve()));
    srv.listen(port, '127.0.0.1');
  });
}

/** Open a client to a given port. `realIp` (optional) is sent as X-Real-IP (only honored when the
 *  server runs with TRUST_PROXY=1; otherwise clientIp falls back to the loopback socket address). */
function client(port: number, query: string, realIp?: string): TestClient {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (realIp) headers['X-Real-IP'] = realIp;
  const c = new TestClient(`ws://127.0.0.1:${port}?${query}`, headers);
  live.push(c);
  return c;
}

async function waitForHealth(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`signaling server on :${port} did not become healthy`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Spawn an isolated signaling server (own port + env) and wait until it is healthy. */
async function startServer(port: number, extraEnv: Record<string, string>): Promise<ChildProcess> {
  await assertPortFree(port);
  const proc = spawn(process.execPath, ['signaling-server.js'], {
    env: { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), ...extraEnv },
    stdio: 'ignore',
  });
  await waitForHealth(port);
  return proc;
}

/** Create a 4-digit room and return [client, code]. */
async function createRoom(port: number, realIp?: string): Promise<[TestClient, string]> {
  const a = client(port, 'app=filetransfer&create=1', realIp);
  await a.opened();
  const welcome = await a.waitFor('welcome');
  return [a, welcome.room as string];
}

describe('4-digit room: lobby seat cap (codeType-dependent)', () => {
  const PORT = 8092;
  const MAX = 3; // small lobby cap for a fast test; the prod default is 8 (FILETRANSFER_MAX_PEERS)
  let server: ChildProcess;
  beforeAll(async () => {
    // TRUST_PROXY=1 + a distinct X-Real-IP per client. (The per-IP-per-room cap now defaults to the
    // room cap, so same-IP peers would also fit; distinct IPs keep this block focused purely on the
    // seat cap and mirror how real clients arrive behind nginx — each with its own X-Real-IP.)
    server = await startServer(PORT, { TRUST_PROXY: '1', FILETRANSFER_MAX_PEERS: String(MAX) });
  });
  afterAll(() => {
    server?.kill();
  });

  it('admits MORE than two peers — the 4-digit room is a LOBBY, not 1:1 (regression from the 6a clamp)', async () => {
    const [, code] = await createRoom(PORT, '203.0.113.1');
    // A second AND a third joiner both connect. Step 6a wrongly capped this at one joiner
    // (ROOM_MAX_PEERS = 2); the lobby is back, so a third (distinct-IP) peer is welcomed.
    for (const ip of ['203.0.113.2', '203.0.113.3']) {
      const j = client(PORT, `app=filetransfer&room=${code}`, ip);
      await j.opened();
      const welcome = await j.waitFor('welcome');
      expect(welcome.type).toBe('welcome');
    }
  });

  it('bounces the (maxPeers+1)-th joiner with 4002 "room full"', async () => {
    const [, code] = await createRoom(PORT, '198.51.100.1'); // creator takes one of MAX seats
    // Fill the remaining seats (MAX - 1 joiners), each from a distinct IP so none hit 4007 first.
    for (let i = 0; i < MAX - 1; i++) {
      const j = client(PORT, `app=filetransfer&room=${code}`, `198.51.100.${10 + i}`);
      await j.opened();
      await j.waitFor('welcome');
    }
    // One past the cap → room full.
    const over = client(PORT, `app=filetransfer&room=${code}`, '198.51.100.250');
    const close = await over.waitClose();
    expect(close.code).toBe(4002);
    expect(close.reason).toMatch(/full/i);
  });
});

describe('token rendezvous (codeType=token) — link/QR + codeless reconnect: client-taken, join-or-create, strictly 1:1', () => {
  const PORT = 8095;
  let server: ChildProcess;
  beforeAll(async () => {
    // A generous 4-digit lobby cap to prove the TOKEN cap is independent of it (codeType-dependent),
    // not merely inheriting a small default.
    server = await startServer(PORT, { TRUST_PROXY: '1', FILETRANSFER_MAX_PEERS: '8' });
  });
  afterAll(() => {
    server?.kill();
  });

  /** A client-drawn token, exactly as the app draws one (16 random bytes → 22 base64url chars). */
  const drawToken = (): string => Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString('base64url');

  it('still allocates a 128-bit token on the compat create=1 path, NOT a 4-digit code', async () => {
    const a = client(PORT, 'app=filetransfer&create=1&codeType=token', '203.0.117.1');
    await a.opened();
    const token = (await a.waitFor('welcome')).room as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes base64url → 22 chars, no '.'
    expect(token).not.toMatch(/^\d{4}$/); // structural interloper-resistance: cannot be enumerated
  });

  it('rejects a malformed token on join with 4001 "bad room" (strict format/length validator)', async () => {
    const bad = client(PORT, 'app=filetransfer&room=not.a.token&codeType=token', '203.0.117.2');
    const close = await bad.waitClose();
    expect(close.code).toBe(4001);
    expect(close.reason).toMatch(/bad room/i);
  });

  it('JOIN-OR-CREATE: a well-formed token nobody holds is opened by its first arrival, and the second finds it', async () => {
    // This is how a codeless reconnect meets: both devices derive the same token and each asks for
    // it — whoever is first opens the room. A link/QR creator takes its own random token the same
    // way, so on the wire the two are indistinguishable. (Used to be 4009 'room not found'.)
    const token = drawToken();
    const first = client(PORT, `app=filetransfer&room=${token}&codeType=token`, '203.0.117.3');
    await first.opened();
    const welcome = await first.waitFor('welcome');
    expect(welcome.room).toBe(token); // the server echoes the CLIENT's token
    expect(welcome.peers).toEqual([]); // alone — nobody to pair with yet

    const second = client(PORT, `app=filetransfer&room=${token}&codeType=token`, '203.0.117.4');
    await second.opened();
    const w2 = await second.waitFor('welcome');
    expect((w2.peers as unknown[]).length).toBe(1); // found the first arrival
    await first.waitFor('peer-joined');
  });

  it('a 4-digit room join still requires an EXISTING room (4009) — join-or-create is the token shape only', async () => {
    const miss = client(PORT, 'app=filetransfer&room=0000', '203.0.117.5');
    const close = await miss.waitClose();
    expect(close.code).toBe(4009);
  });

  it('is strictly 1:1 — a third arrival is bounced with 4002 even though the 4-digit lobby allows 8', async () => {
    const token = drawToken();
    const a = client(PORT, `app=filetransfer&room=${token}&codeType=token`, '203.0.117.10');
    await a.opened();
    await a.waitFor('welcome');

    const b = client(PORT, `app=filetransfer&room=${token}&codeType=token`, '203.0.117.11');
    await b.opened();
    await b.waitFor('welcome'); // the single intended receiver

    // A third arrival (a forwarded link, a squatter) is refused → guarantees ONE peer.
    const c = client(PORT, `app=filetransfer&room=${token}&codeType=token`, '203.0.117.12');
    const close = await c.waitClose();
    expect(close.code).toBe(4002);
    expect(close.reason).toMatch(/full/i);
  });
});

describe('token room opened by a JOIN is managed like one made by CREATE: TTL armed at first arrival', () => {
  const PORT = 8103;
  const TTL_MS = 800;
  let server: ChildProcess;
  beforeAll(async () => {
    server = await startServer(PORT, { TRUST_PROXY: '1', TOKEN_ROOM_TTL_MS: String(TTL_MS) });
  });
  afterAll(() => {
    server?.kill();
  });

  it('expires a token room nobody else reached (room-closed/expired + 4010), and the token can be taken again', async () => {
    // A reconnecting device that waits alone hits this: it answers by taking the same token again
    // (the client re-takes it well before the default 3-min TTL anyway). No 4009 exists for tokens.
    const token = 'A'.repeat(22);
    const a = client(PORT, `app=filetransfer&room=${token}&codeType=token`, '203.0.118.1');
    await a.opened();
    await a.waitFor('welcome');
    const closed = await a.waitFor('room-closed', TTL_MS + 2000);
    expect(closed.reason).toBe('expired');
    const close = await a.waitClose();
    expect(close.code).toBe(4010);

    const again = client(PORT, `app=filetransfer&room=${token}&codeType=token`, '203.0.118.2');
    await again.opened();
    expect((await again.waitFor('welcome')).room).toBe(token);
  });
});

describe('word-room seat cap stays strictly 1:1 (security — serializes secret-word guessing)', () => {
  const PORT = 8097;
  let server: ChildProcess;
  beforeAll(async () => {
    // A generous 4-digit lobby cap to prove the WORD cap is independent of it (codeType-dependent),
    // not merely inheriting a small default.
    server = await startServer(PORT, { TRUST_PROXY: '1', FILETRANSFER_MAX_PEERS: '8' });
  });
  afterAll(() => {
    server?.kill();
  });

  it('rejects a third joiner in a word room with 4002 even though the 4-digit lobby allows 8', async () => {
    const a = client(PORT, 'app=filetransfer&create=1&codeType=word', '203.0.115.1');
    await a.opened();
    const word = (await a.waitFor('welcome')).room as string;

    const b = client(PORT, `app=filetransfer&room=${word}&codeType=word`, '203.0.115.2');
    await b.opened();
    await b.waitFor('welcome');

    const c = client(PORT, `app=filetransfer&room=${word}&codeType=word`, '203.0.115.3');
    const close = await c.waitClose();
    expect(close.code).toBe(4002);
    expect(close.reason).toMatch(/full/i);
  });
});

describe('4-digit room: TTL until connected', () => {
  const PORT = 8093;
  const TTL_MS = 1000; // short test TTL so the room auto-expires quickly
  let server: ChildProcess;
  beforeAll(async () => {
    server = await startServer(PORT, { ROOM_TTL_MS: String(TTL_MS) });
  });
  afterAll(() => {
    server?.kill();
  });

  it('auto-expires a never-connected room: members get room-closed/expired and the code is freed', async () => {
    const [a, code] = await createRoom(PORT);

    const closed = await a.waitFor('room-closed', TTL_MS + 2000);
    expect(closed.reason).toBe('expired');

    // The 4-digit code is returned to the pool: a fresh join now finds no room (4009).
    const late = client(PORT, `app=filetransfer&room=${code}`);
    const close = await late.waitClose();
    expect(close.code).toBe(4009); // room not found
  });

  it('lets the creator destroy the room early: the joiner gets room-closed and the code is freed', async () => {
    const [a, code] = await createRoom(PORT);
    const b = client(PORT, `app=filetransfer&room=${code}`);
    await b.opened();
    await b.waitFor('welcome');

    a.send({ type: 'destroy' });

    const closed = await b.waitFor('room-closed');
    expect(closed.reason).toBe('destroyed');

    const late = client(PORT, `app=filetransfer&room=${code}`);
    const close = await late.waitClose();
    expect(close.code).toBe(4009);
  });
});

describe('4-digit room: idle TTL re-armed on join', () => {
  const PORT = 8096;
  const TTL_MS = 1500; // generous margins so the timing assertions aren't flaky
  let server: ChildProcess;
  beforeAll(async () => {
    // TRUST_PROXY=1 + distinct X-Real-IPs so three peers can share the lobby without the
    // per-IP-per-room cap; ROOM_TTL_MS short enough to observe expiry in a couple of seconds.
    server = await startServer(PORT, { TRUST_PROXY: '1', ROOM_TTL_MS: String(TTL_MS) });
  });
  afterAll(() => {
    server?.kill();
  });

  it(
    'a join within the window re-arms the TTL — an active lobby outlives the original deadline; then idle → expire + 4009',
    async () => {
      const [a, code] = await createRoom(PORT, '203.0.114.1'); // armed for TTL_MS at create

      // Join BEFORE the first deadline → re-arms the idle timer to a fresh TTL_MS.
      await sleep(TTL_MS - 500);
      const b = client(PORT, `app=filetransfer&room=${code}`, '203.0.114.2');
      await b.opened();
      await b.waitFor('welcome');

      // Cross PAST the ORIGINAL deadline. Had the join NOT re-armed the TTL, the room would already
      // be gone; instead a fresh join still succeeds → proof the timer was re-armed on b's join.
      await sleep(TTL_MS - 500); // total elapsed ≈ 2*(TTL-500) = TTL+500 > TTL
      const c = client(PORT, `app=filetransfer&room=${code}`, '203.0.114.3');
      await c.opened();
      const welcome = await c.waitFor('welcome');
      expect(welcome.type).toBe('welcome'); // alive past the original deadline → re-arm worked

      // Now go IDLE (no more joins). After the last re-armed window elapses the room self-destructs
      // and frees the code: members get room-closed/expired and a later join finds nothing (4009).
      const closed = await a.waitFor('room-closed', TTL_MS + 2000);
      expect(closed.reason).toBe('expired');
      const late = client(PORT, `app=filetransfer&room=${code}`, '203.0.114.9');
      const close = await late.waitClose();
      expect(close.code).toBe(4009);
    },
    20_000,
  );
});

describe('lobby roster protocol: welcome.peers + peer-joined carry {id, joinedAt} — no device label', () => {
  const PORT = 8098;
  let server: ChildProcess;
  beforeAll(async () => {
    server = await startServer(PORT, { TRUST_PROXY: '1' });
  });
  afterAll(() => {
    server?.kill();
  });

  it('welcome.peers is a roster of {id, joinedAt}; peer-joined carries the same; a sent device is dropped', async () => {
    // An OLD client still sends a coarse `device` label — the server must neither keep nor relay it
    // (removed 2026-09-27: no screen showed it, so it was metadata for nobody).
    const a = client(PORT, 'app=filetransfer&create=1&device=Desktop', '203.0.116.1');
    await a.opened();
    const aWelcome = await a.waitFor('welcome');
    const code = aWelcome.room as string;
    expect(aWelcome.peers).toEqual([]); // first in the room → empty roster

    const b = client(PORT, `app=filetransfer&room=${code}&device=${'X'.repeat(40)}`, '203.0.116.2');
    await b.opened();
    const bWelcome = await b.waitFor('welcome');

    // B's welcome roster lists A: its id + a numeric server-stamped joinedAt, and nothing else.
    const roster = bWelcome.peers as Array<Record<string, unknown>>;
    expect(roster).toHaveLength(1);
    expect(Object.keys(roster[0]).sort()).toEqual(['id', 'joinedAt']);
    expect(typeof roster[0].id).toBe('string');
    expect(roster[0].joinedAt as number).toBeGreaterThan(0);

    // A's peer-joined for B: the same two facts, no device.
    const joined = (await a.waitFor('peer-joined')) as unknown as Record<string, unknown>;
    expect(Object.keys(joined).sort()).toEqual(['joinedAt', 'peerId', 'type']);
    expect(typeof joined.peerId).toBe('string');
    expect(joined.joinedAt as number).toBeGreaterThan(0);
  });
});

describe('per-IP create/join attempt rate-limit', () => {
  const PORT = 8094;
  const MAX = 3; // attempts per window per IP
  let server: ChildProcess;
  beforeAll(async () => {
    // TRUST_PROXY=1 so clientIp() reads our fake X-Real-IP (the real prod path). A long window so the
    // counter doesn't reset mid-test; a tiny MAX so we trip it in a few attempts.
    server = await startServer(PORT, { TRUST_PROXY: '1', IP_RL_MAX: String(MAX), IP_RL_WINDOW_MS: '60000' });
  });
  afterAll(() => {
    server?.kill();
  });

  it('allows up to MAX attempts from one remote IP, then bounces with 4011', async () => {
    const IP = '203.0.113.10';
    // The first MAX create attempts succeed — normal flow within budget is NOT broken.
    for (let i = 0; i < MAX; i++) {
      const c = client(PORT, 'app=filetransfer&create=1', IP);
      await c.opened();
      const welcome = await c.waitFor('welcome');
      expect(welcome.type).toBe('welcome');
    }
    // The next attempt from the SAME IP is over budget → bounced.
    const over = client(PORT, 'app=filetransfer&create=1', IP);
    const close = await over.waitClose();
    expect(close.code).toBe(4011);
    expect(close.reason).toMatch(/attempts/i);
  });

  it('keeps a separate budget per IP — a different remote IP is unaffected', async () => {
    // A fresh IP starts with a clean window even though 203.0.113.10 is already over budget above.
    const c = client(PORT, 'app=filetransfer&create=1', '198.51.100.30');
    await c.opened();
    const welcome = await c.waitFor('welcome');
    expect(welcome.type).toBe('welcome');
  });

  it('exempts loopback — a local client is never throttled (no X-Real-IP → loopback socket)', async () => {
    // Far more attempts than MAX, all from loopback (no X-Real-IP): every one must succeed. This is
    // why the e2e suite (all from 127.0.0.1) is immune to the limiter.
    for (let i = 0; i < MAX + 3; i++) {
      const c = client(PORT, 'app=filetransfer&create=1');
      await c.opened();
      const welcome = await c.waitFor('welcome');
      expect(welcome.type).toBe('welcome');
    }
  });
});

describe('per-IP-per-room cap DEFAULTS to the room seat cap (one IP may fill a room — co-located group)', () => {
  const PORT = 8099;
  const MAX = 3; // small room cap for a fast test; MAX_PER_IP_PER_ROOM is deliberately UNSET below.
  let server: ChildProcess;
  beforeAll(async () => {
    // TRUST_PROXY=1 so clientIp() reads our fake X-Real-IP. We deliberately DO NOT set
    // MAX_PER_IP_PER_ROOM — the point of this block is that its default now equals the room cap
    // (FILETRANSFER_MAX_PEERS), so a single IP can occupy the room up to the cap (the meeting/class/
    // office-behind-one-NAT case), with the ROOM CAP — not a hardcoded 2 — as the binding per-room limit.
    server = await startServer(PORT, { TRUST_PROXY: '1', FILETRANSFER_MAX_PEERS: String(MAX) });
  });
  afterAll(() => {
    server?.kill();
  });

  it('admits room-cap peers ALL sharing one IP — no 4007 below the cap (group behind one NAT)', async () => {
    const IP = '203.0.118.1'; // every peer behind ONE public IP (one office/class wifi)
    const [, code] = await createRoom(PORT, IP); // creator takes seat 1 from IP
    for (let i = 0; i < MAX - 1; i++) {
      // Fill the remaining seats from the SAME IP. With the old hardcoded MAX_PER_IP_PER_ROOM=2 the
      // 3rd same-IP peer would have been bounced 4007; now the per-IP cap defaults to the room cap (3).
      const j = client(PORT, `app=filetransfer&room=${code}`, IP);
      await j.opened();
      const welcome = await j.waitFor('welcome');
      expect(welcome.type).toBe('welcome');
    }
  });

  it('bounces the (cap+1)-th same-IP peer with 4002 room-full — the ROOM CAP binds, not 4007', async () => {
    const IP = '203.0.118.2';
    const [, code] = await createRoom(PORT, IP);
    for (let i = 0; i < MAX - 1; i++) {
      const j = client(PORT, `app=filetransfer&room=${code}`, IP);
      await j.opened();
      await j.waitFor('welcome');
    }
    // One past the room cap: the seat-cap check (4002) runs before the per-IP check, and since the
    // per-IP default == the room cap, the binding per-room limit is the room cap → 4002, NOT 4007.
    const over = client(PORT, `app=filetransfer&room=${code}`, IP);
    const close = await over.waitClose();
    expect(close.code).toBe(4002);
    expect(close.reason).toMatch(/full/i);
  });
});

describe('per-IP-per-room cap: a LOWER MAX_PER_IP_PER_ROOM override re-tightens anti-domination (4007)', () => {
  const PORT = 8100;
  const MAX = 4; // room cap
  const PER_IP = 2; // override BELOW the room cap → one IP may take only 2 of the 4 seats
  let server: ChildProcess;
  beforeAll(async () => {
    server = await startServer(PORT, {
      TRUST_PROXY: '1',
      FILETRANSFER_MAX_PEERS: String(MAX),
      MAX_PER_IP_PER_ROOM: String(PER_IP),
    });
  });
  afterAll(() => {
    server?.kill();
  });

  it('admits PER_IP same-IP peers, then bounces the next with 4007 while the room still has free seats', async () => {
    const IP = '203.0.119.1';
    const [, code] = await createRoom(PORT, IP); // same-IP peer 1 (creator)
    for (let i = 0; i < PER_IP - 1; i++) {
      const j = client(PORT, `app=filetransfer&room=${code}`, IP);
      await j.opened();
      await j.waitFor('welcome');
    }
    // The (PER_IP+1)-th SAME-IP peer is over the override even though the room (cap MAX=4) has free
    // seats → 4007, NOT 4002. Proves a lower override re-arms the per-room anti-domination cap.
    const over = client(PORT, `app=filetransfer&room=${code}`, IP);
    const close = await over.waitClose();
    expect(close.code).toBe(4007);
    expect(close.reason).toMatch(/network/i);

    // The remaining seats are still reachable from a DIFFERENT IP → the cap is per-IP, not per-room.
    const other = client(PORT, `app=filetransfer&room=${code}`, '203.0.119.99');
    await other.opened();
    const welcome = await other.waitFor('welcome');
    expect(welcome.type).toBe('welcome');
  });
});
