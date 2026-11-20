#!/usr/bin/env node
// Finds the kick, snare and crash strokes in a song's recording, so the sim can replay them while that recording
// plays: the drum looks and the accents then move as they will with the band, not on a clock. Needs ffmpeg.
//
//   node sim/bridge/drums-from-mix.mjs fm                    the song's own recording (its "audio")
//   node sim/bridge/drums-from-mix.mjs kepler-1-b mix.mp3    another file, for a song that plays from SoundCloud
//
// It writes sim/show/drums/<id>.json: { source, kick: [s, …], snare: [s, …], crash: [[s, strength 0–1], …] }.
//
// Live, each drum has its own mic (audio-in.swift). A mix has them all at once, so here each is looked for in
// the band where it stands out: the kick below 100 Hz, the snare from 200 to 800 Hz, cymbals above 5 kHz. A stroke
// is that band jumping well above its recent average, within 6 dB of the loudest it has been lately.
//
// Checked on the stems of a rehearsal (Kepler, 8 Nov 2026), summed to a mix, against what the live detector hears
// in the separate tracks: it finds about 87% of the kicks, 84% of the snares and 74% of the crashes, and about
// 94%, 83% and 80% of what it finds is real. Close enough to see how a look moves; not a transcription.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 44100, HOP = 256;
const SHOW = fileURLToPath(new URL('../show/', import.meta.url));
//             band (Hz)       jump (dB)  gap (s)  how fast the "loudest lately" mark falls (dB a second)
const KINDS = {
  kick: { band: [45, 100], jump: 7.5, gap: 0.07, fall: 0.5 },
  snare: { band: [200, 800], jump: 8, gap: 0.07, fall: 0.3 },
  crash: { band: [5000, 16000], jump: 9.5, gap: 0.12, fall: 0.5 },
};
const GATE = 6;

function biquad(x, type, f) {
  const w = 2 * Math.PI * f / RATE, al = Math.sin(w) / Math.SQRT2, c = Math.cos(w), a0 = 1 + al;
  const [b0, b1] = type === 'hp' ? [(1 + c) / 2 / a0, -(1 + c) / a0] : [(1 - c) / 2 / a0, (1 - c) / a0];
  const a1 = -2 * c / a0, a2 = (1 - al) / a0, y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i], o = b0 * (s + x2) + b1 * x1 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = s; y2 = y1; y1 = o; y[i] = o;
  }
  return y;
}
const band = (x, lo, hi) => biquad(biquad(biquad(biquad(x, 'hp', lo), 'hp', lo), 'lp', hi), 'lp', hi);

// the strokes in one band: [seconds, how far it jumped in dB]
function strokes(x, { band: [lo, hi], jump, gap, fall }) {
  const y = band(x, lo, hi), n = Math.floor(y.length / HOP), dt = HOP / RATE;
  const down = Math.exp(-dt / 0.02), follow = 1 - Math.exp(-dt / 0.3);   // a fast envelope and a slow average, as live
  const db = new Float32Array(n), up = new Float32Array(n);
  let fast = 0, slow = 0;
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * HOP; i < (f + 1) * HOP; i++) e += y[i] * y[i];
    const rms = Math.sqrt(e / HOP);
    fast = Math.max(rms, fast * down);
    db[f] = 20 * Math.log10(Math.max(fast, 1e-6));
    up[f] = db[f] - 20 * Math.log10(Math.max(slow, 1e-6));
    slow += (rms - slow) * follow;
  }
  const out = [], apart = Math.round(gap / dt);
  let top = -120;
  for (let f = 1; f < n - 1; f++) {
    const hit = up[f] >= jump && up[f] >= up[f - 1] && up[f] >= up[f + 1] && db[f] > top - GATE;
    top = Math.max(db[f], top - fall * dt);
    if (!hit) continue;
    const last = out.at(-1);
    if (last && f - last[0] < apart) { if (up[f] > last[1]) out[out.length - 1] = [f, up[f]]; continue; }   // the stronger of two too close
    out.push([f, up[f]]);
  }
  return out.map(([f, v]) => [Math.round(f * dt * 1000) / 1000, v]);
}

const [id, given] = process.argv.slice(2);
if (!id) { console.error('usage: node sim/bridge/drums-from-mix.mjs <song id> [recording]'); process.exit(1); }
const song = JSON.parse(readFileSync(join(SHOW, 'songs', `${id}.json`), 'utf8'));
const file = given || (song.audio && join(SHOW, song.audio));
if (!file) { console.error(`${id} has no recording of its own: give one`); process.exit(1); }
const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 2 ** 31 - 1 });
if (r.error || r.status !== 0) { console.error(`ffmpeg couldn't read ${file}: ${r.error?.message || r.stderr}`); process.exit(1); }
const x = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength >> 2);

const found = Object.fromEntries(Object.entries(KINDS).map(([k, o]) => [k, strokes(x, o)]));
const out = {
  source: `${basename(file)}: kick below 100 Hz, snare 200–800 Hz, cymbals above 5 kHz (drums-from-mix.mjs)`,
  kick: found.kick.map(e => e[0]),
  snare: found.snare.map(e => e[0]),
  crash: found.crash.map(([t, v]) => [t, Math.round(Math.min(1, 0.3 + (v - KINDS.crash.jump) / 18) * 100) / 100]),   // strength as live
};
mkdirSync(join(SHOW, 'drums'), { recursive: true });
writeFileSync(join(SHOW, 'drums', `${id}.json`), JSON.stringify(out).replace(/"(kick|snare|crash)"/g, '\n"$1"') + '\n');
console.log(`${song.title}: ${(x.length / RATE / 60).toFixed(1)} min · ${out.kick.length} kicks, ${out.snare.length} snares, ${out.crash.length} crashes → sim/show/drums/${id}.json`);
