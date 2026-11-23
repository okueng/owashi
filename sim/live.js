// Live: the band, heard through the mixer, drives what a clock can't. There's no click and the drums aren't
// four-on-the-floor, so nothing here guesses a tempo. Romain's actual strokes are the clock instead:
//   · the drum looks (show.js DRUM_LOOKS) step on his kicks, snares and crashes (show.drums);
//   · each cue chooses which accents fire on top (its `react`): crashes, guitar jumps, fills. They're soft:
//     the tubes swell in their own colour, the beams lift. The white slams belong to the cues that punch;
//   · the band's level shapes the looks, like the recording's energy curve does in rehearsal;
//   · when the band stops dead, the rig goes dark with it, and comes back on the next hit.
// The hit detection (bridge/audio-in.swift) was tuned on the stems of a rehearsal (Kepler, 8 Nov 2026). Kick and
// snare are reliable. A "crash" here is a loud hit in an overhead's band above 5 kHz: cymbal accents, not checked by ear.

import { beamSwell, bloom, show } from './show.js';
import { inputs } from './inputs.js';
import { cues, follow, index, playing, position, song } from './setlist.js';

const STOP_STORE = 'owashi-sim:dark-on-stop';
const FLOOR_STORE = 'owashi-sim:stop-floor';
export const live = {
  darkOnStop: true,   // a setting in the Inputs sheet
  stopFloor: -50,     // dBFS: raw band level must fall below this to count as a dead stop (tune for room bleed)
  level: -90,         // the band, all assigned channels together, dBFS, smoothed like a meter
  onStopChange: () => {},
};
try { live.darkOnStop = JSON.parse(localStorage.getItem(STOP_STORE)) ?? true; } catch { /* default */ }
try {
  const savedFloor = Number(localStorage.getItem(FLOOR_STORE));
  if (Number.isFinite(savedFloor) && savedFloor >= -70 && savedFloor <= -25) live.stopFloor = Math.round(savedFloor);
} catch { /* default */ }
function setAutoChoke(on) {
  if (show.autoChoke === on) return;
  show.autoChoke = on;
  live.onStopChange();
}
export function setDarkOnStop(on) {
  live.darkOnStop = on;
  if (!on) setAutoChoke(false);
  try { localStorage.setItem(STOP_STORE, JSON.stringify(on)); } catch { /* for this visit */ }
}
export function setStopFloor(db) {
  live.stopFloor = Math.max(-70, Math.min(-25, Math.round(Number(db) || -50)));
  try { localStorage.setItem(FLOOR_STORE, String(live.stopFloor)); } catch { /* for this visit */ }
}

let now = () => performance.now() / 1000;
export function configure(opts) { ({ now } = opts); }

const LIVE_FOR = 3;        // the drums count as driving while a kick or snare came in this many seconds ago
const SAME_CRASH = 0.06;   // the two overheads hear the same cymbal: one crash, not two
const GUITAR_GAP = 1.5;    // the beams lift for a guitar at most this often
const BLOOM_GAP = 0.8;     // and the tubes swell for a crash or a fill at most this often, so busy drumming doesn't flicker
const D = show.drums;
let lastGuitar = -10, lastBloom = -10;

// While a recording plays the cues, the recording is the band: whatever the mixer hears then (nothing, another
// song, the room) doesn't steer the lights. The drums in the recording do, replayed in step with it (tick).
const onRecording = () => follow.value && playing.value;
const react = () => cues.value[index.value]?.react ?? 'crash';
// looks that already answer crashes themselves
const OWN_CRASH = new Set(['riff', 'breakdown', 'wall']);

inputs.hitListeners.add((ch, v, role, band) => { if (!onRecording()) stroke(v, role, band); });
function stroke(v, role, band) {
  const t = now(), r = react(), dark = show.scene === 'blackout' || show.scene === 'strobe';
  if (band === 'hi') {   // the cymbal band counts in the overheads only; their full-band hits are mostly the snare
    if (role !== 'overheads' || t - D.crash < SAME_CRASH) return;
    D.crash = t; D.crashN++;
    if (r !== 'off' && !dark && !OWN_CRASH.has(show.scene) && t - lastBloom > BLOOM_GAP) { lastBloom = t; bloom(t, 0.5 + 0.5 * v); }
    return;
  }
  if (show.autoChoke && role) setAutoChoke(false);   // the band is back
  if (role === 'kick') { D.kick = t; D.kickN++; D.hit = t; D.hitN++; D.lastKickOrSnare = t; }
  else if (role === 'snare') { D.snare = t; D.snareN++; D.hit = t; D.hitN++; D.lastKickOrSnare = t; }
  else if (role === 'toms' && r === 'all' && !dark && t - lastBloom > BLOOM_GAP) { lastBloom = t; bloom(t, 0.25 + 0.3 * v); }
  else if ((role === 'gtr-left' || role === 'gtr-right') && (r === 'guitar' || r === 'all') && !dark && v >= 0.5 && t - lastGuitar > GUITAR_GAP) {
    lastGuitar = t;
    beamSwell(t, 0.5 + 0.5 * v);
  }
}

// ── a recording: its own drums, replayed ─────────────────────────────────────
// The kicks, snares and crashes of a song's recording are found ahead of time (bridge/drums-from-mix.mjs, kept in
// show/drums/). While the recording plays the cues, each is passed on as it goes by, as if the mixer had heard it,
// so the drum looks and the crash accents move as they will with the band. Guitars and fills can't be told apart
// in a mix: those accents only happen live.
let lastP = -1, wasOnRecording = false;
export function tick() {
  if (!onRecording()) {
    if (wasOnRecording) { wasOnRecording = false; D.live = false; }   // the mixer, if there is one, says so again
    lastP = -1;
    return;
  }
  wasOnRecording = true;
  const d = song.value?.drums, p = position();
  if (d && lastP >= 0 && p > lastP && p - lastP < 0.5) {   // not across a jump in the song
    for (const s of d.kick) if (s > lastP && s <= p) stroke(1, 'kick', '');
    for (const s of d.snare) if (s > lastP && s <= p) stroke(1, 'snare', '');
    for (const [s, v] of d.crash) if (s > lastP && s <= p) stroke(v, 'overheads', 'hi');
  }
  lastP = p;
  D.live = !!d && now() - D.lastKickOrSnare < LIVE_FOR;
}

// ── level: energy and stops ─────────────────────────────────────────────────

const history = [];        // the band's level over the last second, 20 a second
let peak = -90, peakCue = -1, gtrBase = -90, gtrFast = -90;
inputs.levelListeners.add(() => {
  const t = now();
  let sum = 0, any = false, gtrSum = 0, anyGtr = false;
  inputs.levels.forEach((db, i) => {
    const role = inputs.roles[i];
    if (!role) return;
    const p = 10 ** (db / 10);
    sum += p; any = true;
    if (role === 'gtr-left' || role === 'gtr-right') { gtrSum += p; anyGtr = true; }
  });
  const raw = any ? 10 * Math.log10(sum + 1e-12) : -90;
  live.level = raw > live.level ? raw : live.level + (raw - live.level) * 0.1;   // up at once, down over about half a second
  history.push(raw); if (history.length > 20) history.shift();
  if (onRecording()) { setAutoChoke(false); show.liveEnergy = null; show.guitarBoost = 0; return; }   // the drums then come from tick()
  D.live = any && t - D.lastKickOrSnare < LIVE_FOR;

  // Sustained lead guitar boost: distorted solos stay loud without sharp +6 dB transients, so compare guitar level
  // against a slow rolling baseline (~6 s) during 'guitar' / 'all' cues.
  const r = react();
  if (anyGtr && (r === 'guitar' || r === 'all')) {
    const gtrRaw = 10 * Math.log10(gtrSum + 1e-12);
    gtrFast = gtrFast <= -89 ? gtrRaw : gtrFast + (gtrRaw - gtrFast) * 0.25;
    if (gtrRaw > live.stopFloor + 8) {
      gtrBase = gtrBase <= -89 ? gtrRaw : gtrBase + (gtrRaw - gtrBase) * 0.008;
    }
    const over = gtrBase > -75 ? Math.max(0, Math.min(1, (gtrFast - gtrBase - 2.5) / 6)) : 0;
    show.guitarBoost += (over - show.guitarBoost) * 0.15;
  } else {
    show.guitarBoost *= 0.85;
    if (show.guitarBoost < 0.01) show.guitarBoost = 0;
  }

  // energy: how far the band has dropped below its loudest since this cue started (after the cue has landed)
  if (index.value !== peakCue) { peakCue = index.value; peak = -90; gtrBase = -90; show.cueLandT = t; }
  if (t - show.cueLandT > 1.5) peak = Math.max(peak, live.level);
  show.liveEnergy = any && peak > -60 ? 1 - Math.min(1, Math.max(0, (peak - live.level) / 12)) : null;

  // a dead stop: everything falls 24 dB within half a second, down below the room's floor
  const floor = live.stopFloor;
  if (live.darkOnStop && any && !show.autoChoke) {
    const before = Math.max(...history.slice(0, 10));
    if (before > floor + 10 && raw < before - 24 && raw < floor) setAutoChoke(true);
  } else if (show.autoChoke && raw > floor + 10) setAutoChoke(false);
});
