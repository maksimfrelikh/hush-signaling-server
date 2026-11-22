import dgram from 'node:dgram';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';

const [host, portArg] = process.argv.slice(2);
const port = Number(portArg || 3478);
const username = process.env.TURN_USERNAME || '';
const password = process.env.TURN_CREDENTIAL || '';
if (!host || !username || !password) {
  console.error('usage: TURN_USERNAME=… TURN_CREDENTIAL=… node relay-probe.mjs <host> [port]');
  process.exit(2);
}

const COOKIE = [0x21, 0x12, 0xa4, 0x42];
const MESSAGES = 4;
const ALLOCATE = 0x0003, REFRESH = 0x0004, CREATE_PERMISSION = 0x0008, SEND = 0x0016, DATA = 0x0017;
const A_USERNAME = 0x0006, A_INTEGRITY = 0x0008, A_ERROR = 0x0009, A_LIFETIME = 0x000d, A_PEER = 0x0012,
  A_DATA = 0x0013, A_REALM = 0x0014, A_NONCE = 0x0015, A_RELAYED = 0x0016, A_TRANSPORT = 0x0019;

function attr(type, value) {
  const head = Buffer.alloc(4);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(value.length, 2);
  return Buffer.concat([head, value, Buffer.alloc((4 - (value.length % 4)) % 4)]);
}
function build(type, attrs, key) {
  const tid = randomBytes(12);
  let body = Buffer.concat(attrs);
  const head = Buffer.alloc(20);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(body.length + (key ? 24 : 0), 2);
  Buffer.from(COOKIE).copy(head, 4);
  tid.copy(head, 8);
  if (key) body = Buffer.concat([body, attr(A_INTEGRITY, createHmac('sha1', key).update(Buffer.concat([head, body])).digest())]);
  return { tid, buf: Buffer.concat([head, body]) };
}
function parse(buf) {
  const attrs = new Map();
  const end = 20 + buf.readUInt16BE(2);
  for (let pos = 20; pos + 4 <= end; ) {
    const type = buf.readUInt16BE(pos);
    const len = buf.readUInt16BE(pos + 2);
    attrs.set(type, buf.subarray(pos + 4, pos + 4 + len));
    pos += 4 + len + ((4 - (len % 4)) % 4);
  }
  return { type: buf.readUInt16BE(0), tid: buf.subarray(8, 20), attrs };
}
function xorAddress(ip, p) {
  const v = Buffer.alloc(8);
  v[1] = 1;
  v.writeUInt16BE(p ^ 0x2112, 2);
  ip.split('.').forEach((octet, i) => (v[4 + i] = Number(octet) ^ COOKIE[i]));
  return v;
}
function readAddress(v) {
  return { ip: [...v.subarray(4, 8)].map((b, i) => b ^ COOKIE[i]).join('.'), port: v.readUInt16BE(2) ^ 0x2112 };
}
function errorOf(msg) {
  const e = msg.attrs.get(A_ERROR);
  return e ? { code: (e[2] & 7) * 100 + e[3], reason: e.subarray(4).toString() } : { code: 0, reason: 'no ERROR-CODE' };
}

class Client {
  constructor(address) {
    this.address = address;
    this.sock = dgram.createSocket('udp4');
    this.waiting = new Map();
    this.received = 0;
    this.sock.on('message', (buf) => {
      if (buf.length < 20) return;
      const msg = parse(buf);
      if (msg.type === DATA) return void this.received++;
      const done = this.waiting.get(msg.tid.toString('hex'));
      if (done) done(msg);
    });
  }
  request(type, attrs, key) {
    const { tid, buf } = build(type, attrs, key);
    return new Promise((resolve, reject) => {
      const id = tid.toString('hex');
      let tries = 0;
      const send = () => {
        if (tries++ === 4) {
          this.waiting.delete(id);
          return reject(new Error(`no answer from ${this.address}:${port}`));
        }
        this.sock.send(buf, port, this.address);
        timer = setTimeout(send, 1000);
      };
      let timer;
      this.waiting.set(id, (msg) => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(msg);
      });
      send();
    });
  }
  auth() {
    return [attr(A_USERNAME, Buffer.from(username)), attr(A_REALM, this.realm), attr(A_NONCE, this.nonce)];
  }
  async allocate() {
    const transport = attr(A_TRANSPORT, Buffer.from([17, 0, 0, 0]));
    const challenge = await this.request(ALLOCATE, [transport]);
    this.realm = challenge.attrs.get(A_REALM);
    this.nonce = challenge.attrs.get(A_NONCE);
    if (!this.realm || !this.nonce) throw new Error('the server did not ask for credentials — is this a TURN relay?');
    this.key = createHash('md5').update(Buffer.concat([Buffer.from(`${username}:`), this.realm, Buffer.from(`:${password}`)])).digest();
    const answer = await this.request(ALLOCATE, [...this.auth(), transport], this.key);
    if (answer.type !== 0x0103) {
      const e = errorOf(answer);
      throw new Error(`allocation refused: ${e.code} ${e.reason}`);
    }
    this.relay = readAddress(answer.attrs.get(A_RELAYED));
  }
  async permit(ip) {
    const answer = await this.request(CREATE_PERMISSION, [attr(A_PEER, xorAddress(ip, 0)), ...this.auth()], this.key);
    if (answer.type !== 0x0108) {
      const e = errorOf(answer);
      throw new Error(`permission for ${ip} refused: ${e.code} ${e.reason}`);
    }
  }
  sendTo(peer, payload) {
    const { buf } = build(SEND, [attr(A_PEER, xorAddress(peer.ip, peer.port)), attr(A_DATA, payload)]);
    this.sock.send(buf, port, this.address);
  }
  async release() {
    if (this.key && this.relay) {
      const zero = Buffer.alloc(4);
      await this.request(REFRESH, [attr(A_LIFETIME, zero), ...this.auth()], this.key).catch(() => {});
    }
    this.sock.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let a, b;
let code = 1;
try {
  const { address } = await lookup(host, { family: 4 });
  a = new Client(address);
  b = new Client(address);
  await a.allocate();
  await b.allocate();
  await a.permit(b.relay.ip);
  await b.permit(a.relay.ip);
  for (let i = 0; i < MESSAGES; i++) {
    a.sendTo(b.relay, Buffer.from(`relay-probe ${i}`));
    await sleep(100);
  }
  for (let i = 0; i < 20 && b.received < MESSAGES; i++) await sleep(100);
  console.log(`relayed ${b.received} of ${MESSAGES} messages`);
  code = b.received > 0 ? 0 : 1;
} catch (err) {
  console.log(err.message);
} finally {
  await a?.release();
  await b?.release();
}
process.exit(code);
