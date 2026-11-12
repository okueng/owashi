#!/usr/bin/env node
// The light sim's bridge, for rehearsals and gigs. Plain Node, no dependencies. On :8770 it
//   · serves the sim itself (http://localhost:8770/sim/), so the laptop needs nothing else, offline;
//   · saves the show — setlist and cues — as JSON files in sim/show/, ready to commit;
//   · relays between the sim (WebSocket) and Art-Net (UDP :6454), which browsers can't speak;
//   · on a Mac, passes the foot pedal and the pad (any MIDI device) to every open sim, so they work in any browser;
//   · on a Mac, listens to the XR18's inputs over USB and passes each channel's level and hits to the sim.
//
//   node sim/bridge/artnet-bridge.mjs          the sim on this computer only
//   node sim/bridge/artnet-bridge.mjs --lan    also phones and laptops on the same network
//   node sim/bridge/artnet-bridge.mjs --rig=other.json    use another routing file instead of rig.json
//   node sim/bridge/artnet-bridge.mjs --port=8771         another port (the sim then needs ?bridge=8771)
//   node sim/bridge/artnet-bridge.mjs --audio='XR18|X18'  which audio interface to listen to (that's the default); --audio=off
//   node sim/bridge/artnet-bridge.mjs --audio-file=song.mp3   a recording through the same analysis, to try it without the band
//   node sim/bridge/artnet-bridge.mjs --audio-file=tracks/    or a folder of tracks, one per channel, as a DAW exports them
//
// "Drive the rig": the sim's universes go out as ArtDmx, routed by rig.json.
// "Mirror a desk": ArtDmx arriving from a desk is passed to the sim, which just draws it.
// It also sends ArtPoll every 10 s and lists the Art-Net boxes and WLED controllers that answer.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';

const portArg = process.argv.find(a => a.startsWith('--port='));
const WS_PORT = portArg ? Number(portArg.slice(7)) : 8770, ARTNET_PORT = 6454;
const LAN = process.argv.includes('--lan');
const rigArg = process.argv.find(a => a.startsWith('--rig='));
const rigFile = rigArg ? rigArg.slice(6) : new URL('./rig.json', import.meta.url);
const argValue = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const AUDIO = argValue('audio') ?? 'XR18|X18', AUDIO_FILE = argValue('audio-file');
const { universes: routes } = JSON.parse(readFileSync(rigFile, 'utf8'));

const ROOT = fileURLToPath(new URL('../../', import.meta.url));   // the repo
const SHOW = join(ROOT, 'sim', 'show');

const ipv4s = Object.values(networkInterfaces()).flat().filter(i => i && (i.family === 'IPv4' || i.family === 4) && !i.internal);
// the directed broadcast address of every IPv4 interface — where "broadcast" routes go
const broadcasts = ipv4s
  .map(i => {
    const ip = i.address.split('.').map(Number), mask = i.netmask.split('.').map(Number);
    return ip.map((b, k) => b | (~mask[k] & 255)).join('.');
  });

// ── Art-Net ─────────────────────────────────────────────────────────────────

const ID = Buffer.from('Art-Net\0', 'latin1');
const nodes = new Map();
const seq = {};
let udp, receiving = true;

function openUdp(port) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.once('error', reject);
    s.bind(port, () => { s.removeListener('error', reject); s.setBroadcast(true); resolve(s); });
  });
}

function header(opcode, size) {
  const p = Buffer.alloc(size);
  ID.copy(p, 0);
  p.writeUInt16LE(opcode, 8);
  p.writeUInt16BE(14, 10);   // protocol version
  return p;
}

function sendUniverse(sim, data) {
  const r = routes.find(r => r.sim === sim);
  if (!r) return;
  const p = header(0x5000, 18 + 512);   // ArtDmx
  p[12] = seq[sim] = ((seq[sim] || 0) % 255) + 1;
  p.writeUInt16LE(r.artnet & 0x7fff, 14);   // SubUni, then Net
  p.writeUInt16BE(512, 16);
  data.copy(p, 18, 0, 512);
  if (r.to === 'broadcast') for (const b of broadcasts) udp.send(p, ARTNET_PORT, b);
  else { const [host, port] = r.to.split(':'); udp.send(p, Number(port) || ARTNET_PORT, host); }   // "ip" or "ip:port"
}

function poll() {
  const p = header(0x2000, 14);   // ArtPoll
  for (const b of broadcasts) udp.send(p, ARTNET_PORT, b);
}

function onArtNet(msg) {
  if (msg.length < 12 || !msg.subarray(0, 8).equals(ID)) return;
  const op = msg.readUInt16LE(8);

  if (op === 0x5000 && msg.length >= 18) {   // ArtDmx from a desk
    const r = routes.find(r => r.artnet === (msg.readUInt16LE(14) & 0x7fff));
    if (!r) return;
    const out = Buffer.alloc(2 + 512);
    out[0] = 2; out[1] = r.sim;
    msg.copy(out, 2, 18, 18 + Math.min(512, msg.readUInt16BE(16)));
    for (const c of clients) if (c.mode === 'mirror') writeFrame(c, 2, out);
  }

  if (op === 0x2100 && msg.length >= 207) {   // ArtPollReply
    const ip = [...msg.subarray(10, 14)].join('.');
    const text = (a, b) => msg.toString('latin1', a, b).replace(/\0[\s\S]*$/, '').trim();
    const net = msg[18] & 0x7f, sub = msg[19] & 0x0f, ports = Math.min(4, msg.readUInt16BE(172));
    const universes = [];
    for (let i = 0; i < ports; i++) if (msg[174 + i] & 0x80) universes.push((net << 8) | (sub << 4) | (msg[190 + i] & 0x0f));
    const known = nodes.has(ip);
    nodes.set(ip, { ip, name: text(26, 44), long: text(44, 108), universes });
    if (!known) {
      console.log(`  found  ${ip.padEnd(15)} ${text(26, 44) || '(no name)'}  · outputs Art-Net universe ${universes.join(', ') || '—'}`);
      for (const c of clients) sendJson(c, { type: 'nodes', nodes: [...nodes.values()] });
    }
  }
}

// ── MIDI: the pedal and the pad ─────────────────────────────────────────────
// Browsers that won't give a page MIDI (the Claude app's browser, Safari) get it from here instead.
// midi-in.swift reads macOS's MIDI; it's built once with swiftc and kept in ~/Library/Caches.

// A Swift helper next to this file, built once with swiftc into ~/Library/Caches (rebuilt when its source changes).
// Resolves to the binary, or to null with the reason logged.
async function buildHelper(name, tag, what) {
  const src = fileURLToPath(new URL(`./${name}.swift`, import.meta.url));
  const code = await readFile(src);
  const bin = join(homedir(), 'Library', 'Caches', 'owashi-sim', `${name}-${createHash('sha1').update(code).digest('hex').slice(0, 10)}`);
  if (existsSync(bin)) return bin;
  await mkdir(join(bin, '..'), { recursive: true });
  console.log(`  ${tag} building the ${what} (once, takes a moment)…`);
  const built = await new Promise(res => {
    const p = spawn('swiftc', ['-O', '-o', bin, src], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => res(e.message));
    p.on('close', c => res(c === 0 ? '' : err.trim().split('\n').pop()));
  });
  if (built) { console.warn(`  ${tag} can't build the ${what} (${built}). Fix: xcode-select --install`); return null; }
  return bin;
}

let midiSources = [];
async function startMidi() {
  if (process.platform !== 'darwin') return;
  const bin = await buildHelper('midi-in', 'midi  ', 'MIDI reader');
  if (!bin) { console.warn('  midi   pedal and pad then need Chrome'); return; }
  const run = () => {
    const p = spawn(bin, [], { stdio: ['ignore', 'pipe', 'inherit'] });
    let rest = '';
    p.stdout.on('data', chunk => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        const [from, hex] = line.split('\t');
        if (from === 'sources') {
          midiSources = hex ? hex.split('|') : [];
          console.log(`  midi   ${midiSources.length ? midiSources.join(', ') : 'no MIDI devices'}`);
          announce({ type: 'midi-sources', names: midiSources });
        } else if (hex) {
          announce({ type: 'midi', from, data: hex.split(' ').map(h => parseInt(h, 16)) });
        }
      }
    });
    p.on('close', () => { console.warn('  midi   the MIDI reader stopped; starting it again'); setTimeout(run, 2000); });
  };
  run();
}

// ── audio: the XR18's inputs over USB ───────────────────────────────────────
// audio-in.swift listens to the interface (or plays a file through the same analysis) and prints each channel's
// level 20 times a second, and a line the moment a channel is hit. The sim decides what the lights do with them.

let audio = { device: null, channels: 0, rate: 0, note: '', names: [] }, audioNames = [];
async function startAudio() {
  if (process.platform !== 'darwin' || AUDIO === 'off') return;
  const bin = await buildHelper('audio-in', 'audio ', 'audio listener');
  if (!bin) return;
  const args = AUDIO_FILE ? ['--file', AUDIO_FILE] : ['--device', AUDIO];
  const run = () => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let rest = '';
    p.stdout.on('data', chunk => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) {
        const [kind, a, b, c] = line.split('\t');
        if (kind === 'lv') announce({ type: 'lv', v: a.split(',').map(Number) });
        else if (kind === 'on') announce({ type: 'on', ch: Number(a), v: Number(b) });
        else if (kind === 'names') audioNames = a.split('|');   // a recording's tracks, by file name
        else if (kind === 'open') {
          audio = { device: a, channels: Number(b), rate: Number(c), note: '', names: audioNames };
          console.log(`  audio  listening to ${a}: ${b} channels at ${c} Hz`);
          announce({ type: 'audio', ...audio });
        } else if (kind === 'none') {
          audio = { device: null, channels: 0, rate: 0, note: a, names: [] };
          console.log(`  audio  ${a}`);
          announce({ type: 'audio', ...audio });
        }
      }
    });
    p.on('close', () => {
      if (AUDIO_FILE) return;   // a file plays once
      console.warn('  audio  the audio listener stopped; starting it again');
      setTimeout(run, 2000);
    });
  };
  run();
}

// ── WebSocket (just enough of RFC 6455 for one page) ────────────────────────

const clients = new Set();

// Only one sim may send to the lights at a time. A driver that has gone quiet (a crashed tab, a laptop
// that dropped off the network) doesn't count, or it could hold the rig hostage until TCP gives up.
const DRIVER_QUIET_MS = 3000;
let driver = null;

function setClientMode(c, mode) {
  if (mode === c.mode) return;
  if (mode === 'send') {
    const quiet = driver && Date.now() - driver.lastFrame > DRIVER_QUIET_MS;
    if (driver && driver !== c && !quiet) {
      const addr = driver.socket.remoteAddress?.replace(/^::ffff:/, '');
      const where = addr === '127.0.0.1' || addr === '::1' ? 'on this computer' : `from ${addr}`;
      sendJson(c, { type: 'refused', reason: `Another sim is already driving the rig (${where}). Press Off there first.` });
      console.log('  sim    refused: another sim is driving the rig');
      return;
    }
    if (driver && driver !== c) {
      driver.mode = 'off';
      sendJson(driver, { type: 'refused', reason: 'This sim went quiet, so another one took over the rig.' });
    }
    driver = c;
    c.lastFrame = Date.now();
  } else if (driver === c) {
    driver = null;
  }
  c.mode = mode;
  console.log(`  sim    ${{ off: 'stopped', send: 'is driving the rig', mirror: 'is mirroring incoming Art-Net' }[mode]}`);
}

function writeFrame(c, opcode, payload) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) head = Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  c.socket.write(Buffer.concat([head, payload]));
}
const sendJson = (c, obj) => writeFrame(c, 1, Buffer.from(JSON.stringify(obj)));

function readFrames(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const opcode = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    const maskAt = off;
    if (masked) off += 4;
    if (b.length < off + len) return;
    const data = Buffer.from(b.subarray(off, off + len));
    if (masked) for (let i = 0; i < len; i++) data[i] ^= b[maskAt + (i & 3)];
    c.buf = b.subarray(off + len);
    onFrame(c, opcode, data);
  }
}

function onFrame(c, opcode, data) {
  if (opcode === 8) { writeFrame(c, 8, Buffer.alloc(0)); c.socket.end(); return; }
  if (opcode === 9) { writeFrame(c, 10, data); return; }
  if (opcode === 1) {
    let m;
    try { m = JSON.parse(data.toString('utf8')); } catch { return; }
    if (m.type === 'mode' && ['off', 'send', 'mirror'].includes(m.mode)) setClientMode(c, m.mode);
    if (m.type === 'poll') poll();
    return;
  }
  // binary: [1, then per universe: sim number + 512 bytes]
  if (opcode === 2 && c === driver && data[0] === 1) {
    c.lastFrame = Date.now();
    for (let o = 1; o + 513 <= data.length; o += 513) sendUniverse(data[o], data.subarray(o + 1, o + 513));
  }
}

// ── the sim's files, and the show's ─────────────────────────────────────────

// Only pages from this computer or the band's own network may drive the lights or change the show —
// not any website that happens to be open in the same browser.
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]', ...ipv4s.map(i => i.address)]);
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;
  try { const u = new URL(o); return u.host === req.headers.host || LOCAL.has(u.hostname); } catch { return false; }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary', '.woff2': 'font/woff2',
};

async function serveFile(req, res, path) {
  if (path === '/' || path === '/sim') { res.writeHead(302, { location: '/sim/' }); res.end(); return; }
  let file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT) || path.split('/').some(p => p.startsWith('.'))) { res.writeHead(403); res.end(); return; }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-owashi-bridge': '1',   // tells the sim it can save the show here
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found\n');
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const readJson = async (file, fallback) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + '\n');
const announce = msg => { for (const c of clients) sendJson(c, msg); };
const SONG_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;

// PUT /api/show/songs/<id>  { title, soundcloud?, cues, hits?, energy? }  → sim/show/songs/<id>.json (and the setlist, if it's new)
// PUT /api/show/setlist     { songs: [{ id, title, soundcloud? }] } → sim/show/setlist.json
async function handleApi(req, res, path) {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  if (path === '/api/ping') return send(200, { ok: true, saves: true });
  if (!originOk(req)) return send(403, { error: 'not from this computer or its network' });
  if (req.method !== 'PUT') return send(405, { error: 'use PUT' });
  const by = String(req.headers['x-sim-client'] || '').slice(0, 40);   // which open sim saved it
  let body;
  try { body = JSON.parse(await readBody(req, 256 * 1024)); } catch { return send(400, { error: 'expected a JSON body under 256 KB' }); }

  const song = path.match(/^\/api\/show\/songs\/([^/]+)$/);
  if (song) {
    const id = song[1];
    if (!SONG_ID.test(id) || !Array.isArray(body.cues)) return send(400, { error: 'expected { title, cues: [...] } for a lowercase-dashed song id' });
    const entry = { id, title: String(body.title || id).slice(0, 80), ...(body.soundcloud ? { soundcloud: String(body.soundcloud) } : {}) };
    await mkdir(join(SHOW, 'songs'), { recursive: true });
    // hits (accents) and energy (the recording's loudness curve) come from the analysis; keep them through edits
    const extras = {
      ...(Array.isArray(body.hits) ? { hits: body.hits } : {}),
      ...(body.energy && Array.isArray(body.energy.values) ? { energy: body.energy } : {}),
    };
    await writeJson(join(SHOW, 'songs', `${id}.json`), { ...entry, cues: body.cues, ...extras });
    const list = await readJson(join(SHOW, 'setlist.json'), { songs: [] });
    if (!list.songs.some(s => s.id === id)) { list.songs.push(entry); await writeJson(join(SHOW, 'setlist.json'), list); }
    console.log(`  saved  sim/show/songs/${id}.json · ${body.cues.length} cues`);
    announce({ type: 'show', song: id, by });
    return send(200, { ok: true });
  }
  if (path === '/api/show/setlist') {
    if (!Array.isArray(body.songs) || !body.songs.every(s => SONG_ID.test(s?.id))) return send(400, { error: 'expected { songs: [{ id, title }] }' });
    await mkdir(SHOW, { recursive: true });
    await writeJson(join(SHOW, 'setlist.json'), { songs: body.songs.map(s => ({ id: s.id, title: String(s.title || s.id).slice(0, 80), ...(s.soundcloud ? { soundcloud: String(s.soundcloud) } : {}) })) });
    console.log(`  saved  sim/show/setlist.json · ${body.songs.length} songs`);
    announce({ type: 'show', setlist: true, by });
    return send(200, { ok: true });
  }
  return send(404, { error: 'unknown endpoint' });
}

const server = createServer((req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://bridge').pathname); } catch { res.writeHead(400); res.end(); return; }
  const done = path.startsWith('/api/') ? handleApi(req, res, path) : serveFile(req, res, path);
  done.catch(err => { console.warn(`  http   ${err.message}`); if (!res.headersSent) { res.writeHead(500); res.end(); } });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || !originOk(req)) { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  const c = { socket, mode: 'off', buf: Buffer.alloc(0) };
  clients.add(c);
  console.log(`  sim    connected from ${socket.remoteAddress}`);
  sendJson(c, { type: 'hello', routes, receiving, nodes: [...nodes.values()], midiSources, audio });
  socket.on('data', chunk => { c.buf = Buffer.concat([c.buf, chunk]); readFrames(c); });
  const drop = () => {
    if (driver === c) driver = null;
    if (clients.delete(c)) console.log(c.mode === 'send' ? '  sim    disconnected — the rig holds its last look' : '  sim    disconnected');
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

// ── go ──────────────────────────────────────────────────────────────────────

try {
  udp = await openUdp(ARTNET_PORT);
} catch (err) {
  // something else on this computer owns 6454 (a desk with Art-Net input on?): we can still send
  receiving = false;
  udp = await openUdp(0);
  console.warn(`  note   port ${ARTNET_PORT} is busy (${err.code}); sending works, mirroring a desk won't`);
}
udp.on('message', onArtNet);
udp.on('error', err => console.warn(`  udp    ${err.message}`));

server.listen(WS_PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`\nŌwashi light sim · bridge`);
  console.log(`  sim    http://localhost:${WS_PORT}/sim/${LAN ? '' : '   (add --lan for phones and other laptops)'}`);
  if (LAN) for (const i of ipv4s) console.log(`  phones http://${i.address}:${WS_PORT}/sim/`);
  console.log(`  show   saving to sim/show/`);
  console.log(`  net    broadcasting on ${broadcasts.join(', ') || 'no network interface found'}`);
  for (const r of routes) console.log(`  route  sim U${r.sim} → Art-Net universe ${r.artnet} → ${r.to}${r.note ? `   (${r.note})` : ''}`);
  console.log('  looking for Art-Net boxes and WLED…\n');
  poll();
  setInterval(poll, 10_000);
  startMidi().catch(err => console.warn(`  midi   ${err.message}`));
  startAudio().catch(err => console.warn(`  audio  ${err.message}`));
});
server.on('error', err => { console.error(`  can't listen on :${WS_PORT} — ${err.message}`); process.exit(1); });
