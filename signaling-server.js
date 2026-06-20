// signaling-server.js
// Mesh-capable WebRTC signaling relay. PURE signaling — never carries application data.
//
// ROOM MODEL
//   - filetransfer: rooms are CREATED, not picked. "Create" makes the server allocate a
//     fresh unused code (returned in `welcome`); the creator shares it. "Join" enters an EXISTING
//     code — the server never creates a room on join, so a typo / expired code yields "room not
//     found" instead of a ghost room. This kills accidental crowding on memorable codes
//     (1234/0000), since nobody picks the code anymore. THREE rendezvous codeTypes:
//       · '' (default, 4-digit) — the ROOM method. A mesh LOBBY (filetransfer.maxPeers, default 8)
//         where peers see each other and each picks whom to raise a 1:1 channel with. A 4-digit code
//         stops *accidental* collisions but is NOT unguessable — a scanner can enumerate the 10k
//         space; the human SAS is what stops a MITM.
//       · 'word' — the WORDS method. Strictly 1:1 (ONE_TO_ONE_MAX_PEERS) to serialize secret-word
//         guessing; PAKE over the secret words authenticates.
//       · 'token' — the link/QR method. A 128-bit CSPRNG token (unguessable, base64url) replaces the
//         4-digit code; strictly 1:1 so a forwarded link still reaches a SINGLE receiver. Strangers
//         can't enumerate/squat it — interloper-resistance is STRUCTURAL, not just rate-limited. The
//         secret S (link fragment, never sent here) authenticates client-side.
//     Every filetransfer room is HARDENED (`managed: true` → TTL *until connected* + the per-IP
//     attempt rate-limit), self-destructing after a short TTL (freeing the code so a leaked/known one
//     can't be farmed). A 1:1 transfer may fall back to coturn (configured client-side in iceServers).
//     Lengthen the 4-digit ROOM code (see filetransfer.allocate) if you also want it unfindable.
//   - clipboard: shared-clipboard mesh. KEEPS the shared-code model (joinMayCreate) — your
//     own devices type the same code on purpose. NO server fallback (pure P2P + gossip).
//
// Peer ids are human-readable words (e.g. "brave-otter") — a LABEL, not proof of identity.
// The real "no MITM" guarantee is the SAS/PAKE anchor on the CLIENT, not the name. The
// origin/room checks and the caps below are HYGIENE / anti-DoS, NOT authn: the server is
// assumed untrusted; all confidentiality/authenticity lives client-side.
//
// Signaling is ADDRESSED (routed to one peer), so the same server serves a 1:1 pick inside a
// lobby and a full mesh alike.
//
// Protocol (JSON text frames):
//   server -> peer:  { type:'welcome', selfId, room, peers:[...ids] }
//                    { type:'peer-joined', peerId } | { type:'peer-left', peerId }
//   peer  -> server: { type:'signal', to:<id>, data:<opaque> }
//   server forwards: { type:'signal', from:<id>, data:<opaque> }
// Connect URL: ?app=<id>&create=1   (allocate a new room)  OR  ?app=<id>&room=<code> (join)
//
// DEPLOYMENT (front + back on one host behind nginx):
//   - Bind to loopback (HOST=127.0.0.1, default below) so the only thing that can reach Node
//     is nginx on the same host. Nothing external hits Node directly, so no one can inject a
//     fake X-Real-IP by bypassing the proxy.
//   - Set TRUST_PROXY=1 and have nginx set `X-Real-IP $remote_addr` (see the bundled nginx
//     conf). clientIp() then reads that, NOT the client-controllable leftmost X-Forwarded-For.
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomInt, randomBytes, createHmac } from 'crypto';
import { WORDLIST } from './wordlist.js'; // server's OWN copy (client/server share no code)
const PORT         = Number(process.env.PORT) || 8080;
const HOST         = process.env.HOST || '127.0.0.1'; // loopback — only the local nginx reaches us
const HEARTBEAT_MS = Number(process.env.PING_MS) || 30000;
const MAX_PAYLOAD  = Number(process.env.MAX_PAYLOAD) || 64 * 1024; // SDP/ICE are small; 64KB is plenty
const DEV          = process.env.NODE_ENV !== 'production';
const TRUST_PROXY  = process.env.TRUST_PROXY === '1'; // 1 when behind nginx/LB — see clientIp() + nginx conf
const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS) || 1; // reverse-proxy hops you run (nginx = 1)
// Resource caps (anti-DoS). App-level limits that COMPLEMENT, not replace, OS/proxy limits.
const MAX_CONNS_TOTAL     = Number(process.env.MAX_CONNS_TOTAL)     || 5000;
const MAX_CONNS_PER_IP    = Number(process.env.MAX_CONNS_PER_IP)    || 20;
const MAX_PER_IP_PER_ROOM = Number(process.env.MAX_PER_IP_PER_ROOM) || 2;   // stops one IP filling a lobby
const MAX_ROOMS           = Number(process.env.MAX_ROOMS)           || 2000;
const ALLOC_TRIES         = 50;                                             // free-code search attempts
const MSG_WINDOW_MS       = Number(process.env.MSG_WINDOW_MS)       || 10000;
const MSG_SOFT_LIMIT      = Number(process.env.MSG_SOFT_LIMIT)      || 100;  // over → drop (don't relay)
const MSG_HARD_LIMIT      = Number(process.env.MSG_HARD_LIMIT)      || 300;  // over → close (clear flood)
// Managed-room hardening — applies to the WHOLE file-transfer rendezvous: the 4-digit ROOM path, the
// words method (codeType=word), AND the link/QR token method (codeType=token). The `managed` flag
// governs the self-destruct TTL + the per-IP create/join rate-limit ONLY. The SEAT CAP is a SEPARATE,
// codeType-dependent decision (see `maxPeers` in the handler): the 4-digit ROOM rendezvous is a LOBBY
// (filetransfer.maxPeers, default 8) where several peers see each other and each picks whom to open a
// 1:1 channel with; the WORDS and link/QR TOKEN rendezvous are strictly 1:1 (ONE_TO_ONE_MAX_PEERS) —
// words to serialize secret-word guessing, token because a one-time link/QR has a single receiver. A
// leaked/known code still can't be farmed forever (TTL), and per-IP create/join attempts are
// rate-limited (see ipAttempts). SAS / key-confirmation / link-secret defeat a MITM regardless — this
// is abuse hygiene / defense-in-depth, NOT authn. The clipboard mesh opts out of all of it.
// The WORDS rendezvous (codeType=word) AND the link/QR high-entropy TOKEN rendezvous (codeType=token)
// are BOTH strictly 1:1 — they share this seat cap. words: serializes secret-word guessing. token:
// the link/QR is one-time / for a single receiver, and cap-2 guarantees ONE receiver even if the link
// is forwarded (a second joiner is bounced 4002); the unguessable token keeps strangers out structurally.
const ONE_TO_ONE_MAX_PEERS = 2;                                              // words + link/QR token: strictly 1:1
// TTL until connected: a room not used within the window is invalidated and its code freed. AFTER a
// pair is connected, closing signaling does NOT drop the live P2P DataChannel — the TTL only bounds
// the PRE-connection rendezvous window (so a 10GB+ transfer can outlive it). The 4-digit, words and
// token paths keep separate env knobs (same 3-min default). The 4-digit lobby is an IDLE timeout
// (re-armed on each join); the words AND token rooms arm once at CREATE and never re-arm — for words
// it bounds guessing, for token it is the natural pre-connect wait window of a strictly-1:1 link/QR.
const ROOM_TTL_MS       = Number(process.env.ROOM_TTL_MS)       || 180000;   // 4-digit room/link/QR lobby (~3 min, idle)
const WORD_ROOM_TTL_MS  = Number(process.env.WORD_ROOM_TTL_MS)  || 180000;   // words rendezvous   (~3 min, from-create)
const TOKEN_ROOM_TTL_MS = Number(process.env.TOKEN_ROOM_TTL_MS) || 180000;   // link/QR token room (~3 min, from-create)
// link/QR high-entropy rendezvous TOKEN (codeType=token). 16 bytes = 128 bits of CSPRNG entropy →
// unguessable, so a stranger can't enumerate/squat it the way the 4-digit space can be scanned. It is
// base64url with NO padding (so the link `<token>.<S>` splits cleanly on the first '.', and neither
// half contains '.'). 16 bytes encode to exactly 22 base64url chars — the allocator emits and the
// validator enforces that exact shape. The token is PUBLIC routing only (the secret S in the link
// fragment is what authenticates, client-side, and never reaches the server).
const TOKEN_ROOM_BYTES = 16;
const TOKEN_ROOM_LEN   = Math.ceil((TOKEN_ROOM_BYTES * 4) / 3); // 16 → 22 base64url chars (no padding)
const TOKEN_RE         = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_ROOM_LEN}}$`);
const allocToken       = () => randomBytes(TOKEN_ROOM_BYTES).toString('base64url'); // CSPRNG, 128-bit, base64url
// Per-IP create/join attempt rate-limit (managed apps only; REMOTE IPs only — loopback is the
// trusted local nginx/dev/tests). Fixed window. Slows enumeration/squatting of the small 4-digit
// space; legitimate use (incl. reconnect, which re-uses the rendezvous) makes only a few attempts.
const IP_RL_WINDOW_MS  = Number(process.env.IP_RL_WINDOW_MS)  || 60000;      // ~1 min window
const IP_RL_MAX        = Number(process.env.IP_RL_MAX)        || 60;         // create/join attempts per window per IP
// TURN relay credentials (Reliable / relay-fallback mode). The signaling server mints SHORT-LIVED,
// HMAC-derived coturn credentials on demand (coturn `use-auth-secret` / "REST API" scheme) so a 1:1
// pair that can't reach each other directly can fall back to a relay. The shared secret is coturn's
// `static-auth-secret` and lives ONLY here — the client never sees it, only a per-session derived
// credential. coturn recomputes the same HMAC from the `username` and enforces the embedded expiry,
// so there is NO server↔coturn round-trip. Leave TURN_SECRET empty to disable: the server then
// answers turn-request with empty urls and the client stays direct-only (Max-privacy). coturn is
// deployed SEPARATELY (see deploy/coturn.conf.example) and needs an open relay-port range + quotas.
const TURN_SECRET     = process.env.TURN_SECRET || '';                       // == coturn static-auth-secret; SERVER-ONLY, never sent to clients
const TURN_URLS       = (process.env.TURN_URLS || '')                        // comma-separated turn(s):… URIs → array; '' ⇒ relay disabled
  .split(',').map((s) => s.trim()).filter(Boolean);
const TURN_CRED_TTL_S = Number(process.env.TURN_CRED_TTL_S) || 3600;         // credential lifetime (~1h); the username embeds the unix-expiry
const devOrigins = DEV ? ['http://localhost:5173'] : [];
// base32-ish alphabet without ambiguous chars (no 0/o/1/l), for longer codes if needed.
const SAFE32 = 'abcdefghijkmnpqrstuvwxyz23456789';
const randStr = (n, alphabet = SAFE32) =>
  Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');
// "words" method rendezvous: a PUBLIC room id drawn from EFF short #2. Membership lookup
// (handles e.g. "yo-yo") instead of a regex, since we own the authoritative list anyway.
const WORD_SET = new Set(WORDLIST);
const pickWord = () => WORDLIST[randomInt(WORDLIST.length)];
const APPS = {
  // hushsend.frelikh.dev — create/join, strictly 1:1 transfer (coturn fallback client-side)
  filetransfer: {
    // Managed: self-destruct TTL + per-IP create/join rate-limit (anti-farming of the PUBLIC code
    // space), for ALL three codeTypes (4-digit room, words, token). The SEAT CAP is NOT tied to
    // `managed` — it is codeType-dependent (see `maxPeers` in the handler): the 4-digit ROOM
    // rendezvous is a LOBBY of up to `maxPeers` peers (each sees the others and picks whom to open a
    // 1:1 channel with); the words AND link/QR token rendezvous are strictly 1:1 (ONE_TO_ONE_MAX_PEERS).
    managed: true,
    maxPeers: Number(process.env.FILETRANSFER_MAX_PEERS) || 8, // 4-digit ROOM lobby size (words/token are always 1:1)
    code: /^\d{4}$/,                                  // 4-digit ROOM rendezvous label (NOT a secret)
    allocate: () => String(randomInt(10000)).padStart(4, '0'),  // ← lengthen here for unguessable ROOM codes
    // Parallel "words" rendezvous (?codeType=word). The 4-digit `code`/`allocate` path is the
    // ROOM method only now; only the words method asks for a word.
    wordCode: {
      valid: (s) => WORD_SET.has(s),                  // membership, not regex (covers "yo-yo")
      allocate: () => pickWord(),                      // one PUBLIC word from EFF short #2
    },
    // link/QR high-entropy rendezvous (?codeType=token). A 128-bit unguessable token replaces the
    // 4-digit code for link/QR (the link already carries it, so no UX cost) — strangers can't
    // enumerate/squat it. PUBLIC routing only; the secret S (link fragment) still authenticates.
    tokenCode: {
      valid: (s) => TOKEN_RE.test(s),                 // strict format/length (base64url, 22 chars)
      allocate: allocToken,                            // 16 CSPRNG bytes → base64url
    },
    joinMayCreate: false,                             // join must hit an EXISTING room
    origins: ['https://hushsend.frelikh.dev', ...devOrigins],
  },
  // hushclip.frelikh.dev — shared-clipboard mesh, shared code among own devices, no fallback
  clipboard: {
    maxPeers: Number(process.env.CLIPBOARD_MAX_PEERS) || 8,
    code: /^[A-Za-z0-9-]{1,32}$/,                     // bounded; tighten to your client's format
    allocate: () => randStr(6),                       // only used if a client sends create=1
    joinMayCreate: true,                              // first device creates the room by joining
    origins: ['https://hushclip.frelikh.dev', ...devOrigins],
  },
};
// Readable id parts. ids are labels, NOT secrets, so plain word picks are fine.
const ADJECTIVES = ['brave','calm','swift','bright','quiet','clever','gentle','bold','lucky','merry','eager','jolly','keen','neat','proud','witty','sunny','cozy','mellow','nimble','plucky','snappy','spry','zesty','breezy','chipper','dapper','frosty','golden','hardy','jovial','lively','peppy','quirky','rustic','silky','tidy','upbeat','vivid','wily'];
const ANIMALS    = ['otter','fox','panda','koala','lynx','robin','heron','finch','gecko','tapir','bison','ibex','lemur','narwhal','quokka','raccoon','walrus','badger','beaver','falcon','marmot','ocelot','pelican','puffin','wombat','alpaca','bobcat','cardinal','dolphin','ferret','gopher','hedgehog','iguana','jaguar','kestrel','mongoose','newt','osprey','raven','sparrow'];
const pick = (arr) => arr[randomInt(arr.length)];
// unique readable id within a room (so addressing `to` stays unambiguous)
function makeReadableId(peers) {
  for (let i = 0; i < 20; i++) {
    const id = `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
    if (!peers.has(id)) return id;
  }
  let id; // ultra-rare collision fallback
  do { id = `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${randomInt(100)}`; } while (peers.has(id));
  return id;
}
// Roster entry a peer's socket projects to others (welcome.peers / peer-joined): readable id +
// coarse device hint + the server-stamped join time. Cosmetic metadata, never authn.
function peerInfo(ws) {
  return { id: ws._id, device: ws._device || '', joinedAt: ws._joinedAt || 0 };
}
// allocate a fresh code not currently in use for this app (atomic: handler is synchronous).
// `allocate` is the per-codeType generator (4-digit for room/link/QR, a word for "words").
function allocateCode(app, allocate) {
  for (let i = 0; i < ALLOC_TRIES; i++) {
    const c = allocate();
    if (!rooms.has(`${app}:${c}`)) return c;
  }
  return null; // space too crowded
}
// Resolve the code shape (validator + allocator) for this connection's codeType. The default is the
// app's 4-digit `code`/`allocate` (the ROOM method); `?codeType=word` selects the word rendezvous;
// `?codeType=token` selects the link/QR high-entropy token rendezvous.
function codeSpec(cfg, codeType) {
  if (codeType === 'word'  && cfg.wordCode)  return cfg.wordCode;
  if (codeType === 'token' && cfg.tokenCode) return cfg.tokenCode;
  return { valid: (s) => cfg.code.test(s), allocate: cfg.allocate };
}
// Strip the IPv6-mapped-IPv4 prefix so "::ffff:203.0.113.7" is counted as "203.0.113.7".
function normalizeIp(ip) {
  if (!ip) return 'unknown';
  ip = String(ip).trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1] : ip;
}
// Real client IP, used for the per-IP caps. Behind a proxy we must NOT trust the LEFTMOST
// X-Forwarded-For entry — that's whatever the client sent, and an appending proxy (nginx's
// $proxy_add_x_forwarded_for) leaves it client-controlled, which would let one attacker rotate
// fake IPs and slip every per-IP cap (then only MAX_CONNS_TOTAL is left). We trust ONLY what
// our own proxy sets:
//   1) X-Real-IP  (nginx: `proxy_set_header X-Real-IP $remote_addr;` overwrites any client value)
//   2) else the XFF entry our proxy appended: the Nth from the RIGHT (N = TRUSTED_PROXY_HOPS).
function clientIp(req) {
  if (TRUST_PROXY) {
    const real = req.headers['x-real-ip'];
    if (real) return normalizeIp(Array.isArray(real) ? real[0] : real);
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      const fromRight = parts[parts.length - TRUSTED_PROXY_HOPS];
      if (fromRight) return normalizeIp(fromRight);
    }
  }
  return normalizeIp(req.socket.remoteAddress);
}
const rooms      = new Map(); // "appId:code" -> Map<peerId, ws>
const roomMeta   = new Map(); // "appId:code" -> { creatorId, timer } — managed rooms (TTL + creator-destroy)
const ipCounts   = new Map(); // ip -> live connection count (global per-IP cap)
const ipAttempts = new Map(); // ip -> { windowStart, count } — per-IP create/join attempt rate (managed apps)
// Loopback is the trusted local path: behind nginx the real client always arrives via X-Real-IP and
// never looks like loopback, so 127.0.0.1 / ::1 here is only the local proxy, dev, or tests — never
// throttled. (Keeps the per-IP attempt rate-limit targeted at REMOTE enumeration.)
const isLoopback = (ip) => ip === '127.0.0.1' || ip === '::1';
// Per-IP fixed-window rate-limit for room create/join ATTEMPTS (counts failed joins too, so it bounds
// enumeration of the small 4-digit code space). Loopback is exempt (above). Returns true when the
// caller is OVER budget for the current window and should be bounced; mutates the window in place.
function attemptRateLimited(ip) {
  if (isLoopback(ip)) return false;
  const now = Date.now();
  let rec = ipAttempts.get(ip);
  if (!rec || now - rec.windowStart > IP_RL_WINDOW_MS) { rec = { windowStart: now, count: 0 }; ipAttempts.set(ip, rec); }
  rec.count++;
  return rec.count > IP_RL_MAX;
}
// Invalidate a managed room: notify its members (except an optional initiator), close their sockets
// (4010), free the rendezvous code, and cancel the TTL. Used by the TTL timer (reason 'expired') and
// the creator's destroy command (reason 'destroyed'). Safe to call once. NOTE: after a pair is
// already connected, closing signaling does NOT drop the live P2P DataChannel — the TTL only bounds
// the PRE-connection rendezvous window.
function closeRoom(key, reason, exceptId) {
  const meta = roomMeta.get(key);
  if (meta && meta.timer) clearTimeout(meta.timer);
  roomMeta.delete(key);
  const peers = rooms.get(key);
  if (!peers) return;
  rooms.delete(key); // free the code immediately so a new create can reuse it
  for (const [id, peer] of peers) {
    if (id === exceptId) continue;
    sendJSON(peer, { type: 'room-closed', reason });
    peer.close(4010, reason);
  }
}
// Build a managed-room TTL timer that invalidates the room (freeing its code) when it fires. unref()
// so a pending timer never keeps the process alive. The 4-digit lobby re-arms this on every join
// (idle-timeout: an actively-joined lobby lives, a stale one expires); the words room arms it once at
// CREATE and never re-arms (its TTL bounds secret-word guessing regardless of join activity).
function makeTtlTimer(key, ttlMs) {
  const timer = setTimeout(() => closeRoom(key, 'expired'), ttlMs);
  if (timer.unref) timer.unref();
  return timer;
}
// Health endpoint for LB/uptime checks; WS upgrades are handled separately by the WSS.
const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('upgrade required');
  }
});
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
wss.on('connection', (ws, req) => {
  ws.on('error', () => {}); // FIRST: a socket 'error' with no listener crashes the whole process
  const url        = new URL(req.url, 'http://localhost');
  const app        = url.searchParams.get('app') || '';
  const wantCreate = url.searchParams.get('create') === '1';
  const roomParam  = url.searchParams.get('room') || '';
  const codeType   = url.searchParams.get('codeType') || ''; // '' = 4-digit room; 'word' = EFF short #2; 'token' = link/QR 128-bit token
  // COARSE, cosmetic device label for the lobby roster (e.g. "Desktop" / "Mobile"). Client-supplied
  // and relayed to room peers — NOT trusted, NOT authn (the SAS is). Strip control chars and cap the
  // length server-side so a hostile/huge value can't bloat frames or break the roster UI.
  const device     = String(url.searchParams.get('device') || '').split('').filter((c) => c >= ' ').join('').slice(0, 32);
  const origin     = req.headers.origin;
  const ip         = clientIp(req);
  const cfg = APPS[app];
  if (!cfg)                                          return ws.close(4000, 'unknown app');
  // Two codeTypes are strictly 1:1: the WORDS rendezvous (codeType=word) and the link/QR high-entropy
  // TOKEN rendezvous (codeType=token). Every OTHER rendezvous (4-digit room, clipboard) is a multi-peer
  // lobby. `is1to1` drives BOTH the seat cap and the TTL (1:1 rooms arm from CREATE and never re-arm).
  // (`managed` ≠ 1:1 — see ONE_TO_ONE_MAX_PEERS.)
  const isWordRoom  = codeType === 'word'  && !!cfg.wordCode;
  const isTokenRoom = codeType === 'token' && !!cfg.tokenCode;
  const is1to1      = isWordRoom || isTokenRoom;
  // Origin is hygiene, not authn (a non-browser client can omit it). Browsers always send it.
  if (!origin || !cfg.origins.includes(origin))      return ws.close(4003, 'origin not allowed');
  // Global resource caps (checked before we create/join anything).
  if (wss.clients.size > MAX_CONNS_TOTAL)             return ws.close(4005, 'server busy');
  if ((ipCounts.get(ip) || 0) >= MAX_CONNS_PER_IP)   return ws.close(4006, 'too many connections');
  // Per-IP create/join attempt rate-limit (managed apps only — the file-transfer rendezvous). Counts
  // EVERY attempt that gets this far, including ones that will fail to find a room, so it bounds
  // enumeration of the small 4-digit code space. Loopback is exempt (attemptRateLimited).
  if (cfg.managed && attemptRateLimited(ip))         return ws.close(4011, 'too many attempts');
  // Resolve the code shape for this codeType (4-digit by default; a word for ?codeType=word).
  const spec = codeSpec(cfg, codeType);
  // Resolve the room: CREATE (server allocates) vs JOIN (must already exist, unless app opts in).
  let code, key, peers;
  if (wantCreate) {
    if (rooms.size >= MAX_ROOMS)                      return ws.close(4005, 'server busy');
    code = allocateCode(app, spec.allocate);
    if (code == null)                                 return ws.close(4005, 'no free rooms');
    key = `${app}:${code}`;
    peers = new Map();
    rooms.set(key, peers);
  } else {
    if (!spec.valid(roomParam))                       return ws.close(4001, 'bad room');
    code = roomParam;
    key = `${app}:${code}`;
    peers = rooms.get(key);
    if (!peers) {
      if (!cfg.joinMayCreate)                         return ws.close(4009, 'room not found');
      if (rooms.size >= MAX_ROOMS)                    return ws.close(4005, 'server busy');
      peers = new Map();
      rooms.set(key, peers);
    }
  }
  // Seat cap is codeType-dependent (NOT the `managed` flag): the WORDS and the link/QR TOKEN
  // rendezvous are both strictly 1:1 (ONE_TO_ONE_MAX_PEERS) — words serializes guessing, token
  // guarantees a single receiver for a one-time link. The 4-digit ROOM and the clipboard mesh keep
  // their lobby size (cfg.maxPeers). An extra joiner past the cap gets "room full".
  const maxPeers = is1to1 ? ONE_TO_ONE_MAX_PEERS : cfg.maxPeers;
  if (peers.size >= maxPeers)                         return ws.close(4002, 'room full');
  // Per-IP-per-room cap: stops a single IP from filling a lobby on its own (anti-squat).
  let sameIp = 0;
  for (const p of peers.values()) if (p._ip === ip) sameIp++;
  if (sameIp >= MAX_PER_IP_PER_ROOM)                 return ws.close(4007, 'too many from your network');
  // Accepted — register.
  const selfId = makeReadableId(peers);
  ws._id = selfId; ws._ip = ip; ws._roomKey = key; ws.isAlive = true;
  ws._device = device; ws._joinedAt = Date.now(); // lobby-roster metadata (cosmetic; OUR clock for joinedAt)
  ws._msgWindowStart = Date.now(); ws._msgCount = 0;
  ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
  ws.on('pong', () => { ws.isAlive = true; });
  // newcomer learns its id, the room code (esp. needed for create), and the roster already here
  // (each peer's id + coarse device + server-stamped joinedAt) so it can pick whom to pair with.
  sendJSON(ws, { type: 'welcome', selfId, room: code, peers: [...peers.values()].map(peerInfo) });
  // everyone else learns a peer arrived (with its device + joinedAt for their roster)
  for (const peer of peers.values()) {
    sendJSON(peer, { type: 'peer-joined', peerId: selfId, device: ws._device, joinedAt: ws._joinedAt });
  }
  peers.set(selfId, ws);
  // Managed-room lifecycle: on CREATE pin the creator (only it may destroy the room) and arm the TTL
  // so a leaked/known rendezvous can't be guessed against forever. The 4-digit and words paths use
  // their own TTL knobs (same 3-min default). After connected the client ignores the resulting
  // signaling close (the P2P channel lives on).
  //
  // The 4-digit lobby uses an IDLE timeout: each JOIN re-arms the timer, so an actively-joined lobby
  // stays alive while a stale one (ROOM_TTL_MS with no new joins) still expires and frees the code.
  // The 1:1 WORDS and TOKEN rooms do NOT re-arm — their TTL stays armed from CREATE (a re-arm would
  // let an attacker keep a 1:1 room alive by rejoining; for words it would also defeat the guessing
  // bound). Each path has its own TTL knob (same 3-min default).
  if (cfg.managed && wantCreate) {
    const ttlMs = isWordRoom ? WORD_ROOM_TTL_MS : isTokenRoom ? TOKEN_ROOM_TTL_MS : ROOM_TTL_MS;
    roomMeta.set(key, { creatorId: selfId, timer: makeTtlTimer(key, ttlMs) });
  } else if (cfg.managed && !is1to1) {
    // JOIN into a 4-digit lobby → re-arm the idle TTL (the room meta was created by the creator).
    const meta = roomMeta.get(key);
    if (meta) {
      clearTimeout(meta.timer);
      meta.timer = makeTtlTimer(key, ROOM_TTL_MS);
    }
  }
  ws.on('message', (data) => {
    // fixed-window message rate limit (bounds relay-flood and parse-CPU abuse)
    const now = Date.now();
    if (now - ws._msgWindowStart > MSG_WINDOW_MS) { ws._msgWindowStart = now; ws._msgCount = 0; }
    if (++ws._msgCount > MSG_HARD_LIMIT) return ws.close(4008, 'rate limit');
    if (ws._msgCount > MSG_SOFT_LIMIT) return;              // drop, don't relay
    let msg;
    try { msg = JSON.parse(data); } catch { return; }       // binary / garbage -> ignored
    // Creator-only managed-room teardown: free the code + evict the joiner. Honored ONLY from the
    // socket that created the room (a joiner can't tear down someone else's rendezvous). The
    // creator's own socket is left open (exceptId) — it manages its own next step client-side.
    if (msg.type === 'destroy') {
      const meta = roomMeta.get(ws._roomKey);
      if (meta && meta.creatorId === selfId) closeRoom(ws._roomKey, 'destroyed', selfId);
      return;
    }
    // TURN credentials for the Reliable / relay-fallback mode (MANAGED apps only — the file-transfer
    // rendezvous; clipboard has no server fallback). The client asks when a direct path fails. We mint
    // a SHORT-LIVED coturn credential (use-auth-secret scheme): the username is a FUTURE unix-expiry,
    // and the credential is base64(HMAC-SHA1(static-auth-secret, username)). coturn recomputes the same
    // HMAC and enforces the expiry, so the shared secret never leaves this process — only the derived
    // per-session credential is sent. If TURN is unconfigured (no TURN_SECRET) OR the app isn't managed,
    // we answer with EMPTY urls so the client treats relay as unavailable and stays direct-only — never
    // an error, never a leak. Bounded by the per-socket message rate-limit above (no extra limiter).
    if (msg.type === 'turn-request') {
      if (!cfg.managed || !TURN_SECRET) {
        return sendJSON(ws, { type: 'turn-credentials', urls: [], username: '', credential: '', ttl: 0 });
      }
      const username = String(Math.floor(Date.now() / 1000) + TURN_CRED_TTL_S); // unix-expiry coturn checks
      const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64');
      return sendJSON(ws, { type: 'turn-credentials', urls: TURN_URLS, username, credential, ttl: TURN_CRED_TTL_S });
    }
    if (msg.type !== 'signal' || !msg.to || msg.to === selfId) return;
    const target = peers.get(msg.to);                        // only peers in THIS room are addressable
    if (!target || target.readyState !== target.OPEN) return;
    sendJSON(target, { type: 'signal', from: selfId, data: msg.data }); // server sets `from` (no spoofing)
  });
  ws.on('close', () => {
    const n = (ipCounts.get(ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);
    peers.delete(selfId);
    for (const peer of peers.values()) sendJSON(peer, { type: 'peer-left', peerId: selfId });
    // identity-guarded delete: stays correct even if a future async close handler interleaves
    if (rooms.get(key) === peers && peers.size === 0) {
      rooms.delete(key);
      // Cancel a managed room's TTL when it empties on its own, so the timer can't later fire on a
      // DIFFERENT room that reused the same freed code.
      const meta = roomMeta.get(key);
      if (meta && meta.timer) clearTimeout(meta.timer);
      roomMeta.delete(key);
    }
  });
});
// Heartbeat: drop ghosts that never fired 'close' (frees their room + IP slot).
// terminate() emits 'close', so the cleanup handler above still runs.
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
  // Prune stale per-IP attempt windows so the map can't grow unbounded with one-shot IPs.
  const now = Date.now();
  for (const [ip, rec] of ipAttempts) if (now - rec.windowStart > IP_RL_WINDOW_MS) ipAttempts.delete(ip);
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(interval));
function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
// Graceful shutdown: stop accepting, close open sockets, then exit.
function shutdown() {
  clearInterval(interval);
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref(); // force-exit if sockets linger
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.listen(PORT, HOST, () => {
  console.log(`Mesh signaling server listening on ${HOST}:${PORT}`);
  // Deploy config summary (NO secrets) — one scannable line to confirm the LIVE config after a
  // start/restart (see deploy/DEPLOY.md). TRUST_PROXY + nginx's `X-Real-IP` are CRITICAL behind a
  // proxy: without them every client looks like loopback (127.0.0.1), so the per-IP caps collapse
  // onto a single bucket and the 4011 attempt rate-limit (loopback-exempt) silently never fires.
  // We print WHETHER TURN is configured + how many relay URLs are set, but NEVER the TURN_SECRET
  // itself (it is shared with coturn and is server-only — see server/.env.example).
  console.log(
    `[config] env=${DEV ? 'development' : 'production'}` +
      ` trustProxy=${TRUST_PROXY ? 'on' : 'OFF'}` +
      ` turn=${TURN_SECRET ? `configured(${TURN_URLS.length} url${TURN_URLS.length === 1 ? '' : 's'})` : 'disabled'}` +
      ` maxConnsTotal=${MAX_CONNS_TOTAL}` +
      ` maxPerIpPerRoom=${MAX_PER_IP_PER_ROOM}` +
      ` filetransferMaxPeers=${APPS.filetransfer.maxPeers}` +
      ` roomTtlMs=${ROOM_TTL_MS}` +
      ` wordRoomTtlMs=${WORD_ROOM_TTL_MS}` +
      ` tokenRoomTtlMs=${TOKEN_ROOM_TTL_MS}` +
      ` ipRlMax=${IP_RL_MAX}/${IP_RL_WINDOW_MS}ms`,
  );
  if (!TRUST_PROXY) {
    console.warn(
      '[config] WARNING: TRUST_PROXY is OFF — behind nginx set TRUST_PROXY=1 and ' +
        '`proxy_set_header X-Real-IP $remote_addr;`, else per-IP caps/rate-limit see only loopback.',
    );
  }
});
