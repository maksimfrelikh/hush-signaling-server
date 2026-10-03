import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { createHmac } from 'node:crypto';

/**
 * The one Reliable-mode property nothing tested: does a credential the SIGNALING server mints actually
 * open a relay on COTURN, and does data cross it?
 *
 * `turn-credentials.test.ts` covers the mint in isolation (username shape, HMAC, empty-urls fallback)
 * and hushsend's `privacy.spec.ts` covers the client assembling an `iceServer` from the reply — but both
 * stop at the wire format. hushsend's playwright.config.ts says so outright: "we never run an actual relay ... we only
 * verify cred assembly". So the ONE thing that has to hold in production — the signaling server's
 * `TURN_SECRET` being the same string as coturn's `static-auth-secret` — was checked by nobody. Drift
 * it and every mint still looks perfect, every unit test still passes, and Reliable mode degrades to
 * direct-only for every user whose direct path fails. Verified by hand against the live host on
 * 2026-09-19 (allocation accepted, 14.4 MB relayed, 0 packets lost); this is that check, automated.
 *
 * SHAPE. Spawn a real coturn on loopback with a known secret, spawn the signaling server with the SAME
 * secret, ask it for credentials over the WebSocket exactly as the client does, then drive
 * `turnutils_uclient` with what it returned and require that bytes actually cross the relay.
 *
 * The negative control is the point. "Matching secret ⇒ relay works" would also pass against a coturn
 * with authentication switched off entirely, which is the failure this exists to catch — so the second
 * case mints a credential under a DIFFERENT secret and requires the SAME relay to refuse it.
 *
 * Needs the coturn binaries (`turnserver`, `turnutils_uclient`). They are absent on a bare dev box, so
 * the suite skips rather than fails there — but a skip in CI would silently delete the coverage, so CI
 * sets REQUIRE_RELAY_TEST=1 and the guard below turns the skip into a hard failure.
 */

const SIGNALING_PORT = 8110; // distinct from every other integration file (8091-8103)
const TURN_PORT = 3489; // NOT 3478: a dev box may be running a real coturn (the deploy host does)
const RELAY_MIN = 49300;
const RELAY_MAX = 49320;
const SECRET = 'integration-turn-shared-secret';
const WRONG_SECRET = 'not-the-secret-coturn-was-given';
const ORIGIN = 'http://localhost:5173';
const TTL_S = 600;

function have(bin: string): boolean {
  return spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
}
const HAVE_COTURN = have('turnserver') && have('turnutils_uclient');

// coturn 4.18 (Homebrew) no longer has the admin CLI or the DTLS switch, and fails to start when told
// `--no-cli` / `--no-dtls`; 4.6 (Ubuntu, laptop-server, CI) needs `--no-cli` before it accepts
// `--allow-loopback-peers`. So the two flags go only to the old line.
const COTURN_VERSION = HAVE_COTURN
  ? (spawnSync('turnserver', ['--version'], { encoding: 'utf8' }).stdout ?? '').trim()
  : '';
const LEGACY_COTURN_FLAGS = /^4\.[0-6]\./.test(COTURN_VERSION) ? ['--no-cli', '--no-dtls'] : [];

// A skip that CI cannot absorb silently: REQUIRE_RELAY_TEST=1 makes a missing coturn a failure.
if (!HAVE_COTURN && process.env.REQUIRE_RELAY_TEST === '1') {
  throw new Error(
    'REQUIRE_RELAY_TEST=1 but coturn is missing: install `coturn` (turnserver + turnutils_uclient). ' +
      'This guard exists so CI cannot lose the signaling↔coturn secret check by skipping it.',
  );
}

async function assertPortFree(port: number): Promise<void> {
  const srv = net.createServer();
  await new Promise<void>((resolve, reject) => {
    srv.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `port ${port} is already in use — this test spawns its OWN servers and would silently ` +
              `attach to the stranger instead. Stop whatever holds ${port} and retry.`
            : `cannot probe port ${port}: ${err.message}`,
        ),
      ),
    );
    srv.once('listening', () => srv.close(() => resolve()));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * `Connection: close`, so the probe leaves no idle keep-alive socket in fetch's pool.
 * `relayAttempt` blocks the event loop (spawnSync) for ~4–6.5 s, Node's HTTP server drops an idle
 * socket after 5 s, and while blocked nothing on this side can see it go — so when the uclient run
 * outlasted the server's timeout, the NEXT test's WebSocket handshake was handed that dead socket and
 * failed (CI from the 2026-10-01 nightly: a bare `error` and no `close` on Node 22.23, a 1006 on
 * 22.22).
 */
async function waitForHealth(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  const probe = { headers: { connection: 'close' } };
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`, probe)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`signaling server on :${port} did not become healthy`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** coturn listens on UDP, so readiness is probed by asking it for a STUN binding until it answers. */
async function waitForTurn(port: number, timeoutMs = 10000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const r = spawnSync('turnutils_stunclient', ['-p', String(port), '127.0.0.1'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    if (/reflexive addr/i.test((r.stdout ?? '') + (r.stderr ?? ''))) return;
    if (Date.now() - start > timeoutMs) throw new Error(`coturn on :${port} did not answer STUN in time`);
    await new Promise((r2) => setTimeout(r2, 200));
  }
}

/**
 * Drive a real TURN allocation with these credentials and report whether bytes crossed the relay.
 * Judged on messages RECEIVED back through the relay, not on the exit code: an allocation refused for
 * bad auth and one that succeeded can both exit 0 depending on build, but only one moves data.
 */
function relayAttempt(user: string, cred: string): { relayed: number; out: string } {
  const r = spawnSync(
    'turnutils_uclient',
    ['-y', '-u', user, '-w', cred, '-p', String(TURN_PORT), '-n', '4', '-m', '1', '127.0.0.1'],
    { encoding: 'utf8', timeout: 45000 },
  );
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  let relayed = 0;
  for (const m of out.matchAll(/tot_recv_msgs=(\d+)/g)) relayed = Math.max(relayed, Number(m[1]));
  return { relayed, out };
}

/** Ask the signaling server for credentials exactly as the browser client does. */
function mintFromSignalingServer(): Promise<{ urls: string[]; username: string; credential: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SIGNALING_PORT}?app=filetransfer&create=1&codeType=word`, {
      headers: { Origin: ORIGIN },
    } as unknown as string[]);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      reject(new Error('timeout waiting for turn-credentials'));
    }, 8000);
    // A failed handshake must fail HERE: Node 22.23's WebSocket reports one with `error` alone (no
    // `close`), which a no-op handler turned into an 8 s "timeout" that pointed at the server.
    ws.onerror = (e) => {
      clearTimeout(timer);
      const why = (e as ErrorEvent).message || e.type;
      reject(new Error(`signaling socket error before credentials: ${why}`));
    };
    ws.onclose = (e) => {
      clearTimeout(timer);
      reject(new Error(`signaling socket closed before credentials: ${e.code}`));
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as Record<string, unknown>;
      if (m.type === 'welcome') return ws.send(JSON.stringify({ type: 'turn-request' }));
      if (m.type !== 'turn-credentials') return;
      clearTimeout(timer);
      ws.onclose = null;
      const creds = {
        urls: m.urls as string[],
        username: String(m.username),
        credential: String(m.credential),
      };
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(creds);
    };
  });
}

describe.skipIf(!HAVE_COTURN)('Reliable mode — a minted credential really opens a relay on coturn', () => {
  let signaling: ChildProcess;
  let turn: ChildProcess;

  beforeAll(async () => {
    await assertPortFree(SIGNALING_PORT);

    // A real coturn in the same REST-credential mode production uses. Loopback peers are DENIED by
    // default (anti-SSRF), and turnutils_uclient relays to 127.0.0.1 here, so they are allowed for
    // this test only — the deployed config keeps the default (see deploy/turn/turnserver.conf.template).
    turn = spawn(
      'turnserver',
      [
        '-n',
        '--listening-ip=127.0.0.1',
        `--listening-port=${TURN_PORT}`,
        `--min-port=${RELAY_MIN}`,
        `--max-port=${RELAY_MAX}`,
        '--use-auth-secret',
        `--static-auth-secret=${SECRET}`,
        '--realm=hushsend.test',
        '--allow-loopback-peers',
        // coturn ≤4.6 REFUSES to start with `allow-loopback-peers` unless the admin CLI is secured; we
        // do not want that CLI in a test at all (LEGACY_COTURN_FLAGS). The default pidfile is also
        // unwritable as a normal user, which is non-fatal but noisy.
        ...LEGACY_COTURN_FLAGS,
        '--pidfile=',
        '--no-tls',
        '--log-file=stdout',
      ],
      { stdio: 'ignore' },
    );
    await waitForTurn(TURN_PORT);

    // The signaling server, given the SAME secret — the pairing this test exists to check.
    signaling = spawn(process.execPath, ['signaling-server.js'], {
      env: {
        ...process.env,
        NODE_ENV: 'development',
        HOST: '127.0.0.1',
        PORT: String(SIGNALING_PORT),
        TURN_SECRET: SECRET,
        TURN_URLS: `turn:127.0.0.1:${TURN_PORT}`,
        TURN_CRED_TTL_S: String(TTL_S),
      },
      stdio: 'ignore',
    });
    await waitForHealth(SIGNALING_PORT);
  }, 60000);

  afterAll(() => {
    signaling?.kill();
    turn?.kill();
  });

  it('mints over the WebSocket, and the relay accepts it and carries data', async () => {
    const creds = await mintFromSignalingServer();
    expect(creds.urls).toEqual([`turn:127.0.0.1:${TURN_PORT}`]);
    // The username is the expiry coturn enforces offline — it must be in the future, or every
    // allocation is refused no matter how right the secret is.
    expect(Number(creds.username)).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const { relayed, out } = relayAttempt(creds.username, creds.credential);
    expect(relayed, `no bytes crossed the relay:\n${out}`).toBeGreaterThan(0);
  }, 90000);

  it('NEGATIVE CONTROL — a credential minted under a DIFFERENT secret is refused by the same relay', async () => {
    const creds = await mintFromSignalingServer();
    // Same username (so the expiry is still valid); only the shared secret differs. This is exactly
    // what a TURN_SECRET that has drifted from coturn's static-auth-secret looks like on the wire.
    const forged = createHmac('sha1', WRONG_SECRET).update(creds.username).digest('base64');
    expect(forged).not.toBe(creds.credential);

    const { relayed, out } = relayAttempt(creds.username, forged);
    expect(relayed, `the relay accepted a credential signed with the WRONG secret:\n${out}`).toBe(0);
  }, 90000);
});
