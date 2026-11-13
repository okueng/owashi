// Live: the band, heard through the mixer, drives what a clock can't. There's no click and the drums aren't
// four-on-the-floor, so nothing here guesses a tempo. Romain's actual strokes are the clock instead:
//   · the drum looks (Riff, Blast, Breakdown, Wall) step on his kicks, snares and crashes (show.drums);
//   · each cue chooses which accents fire on top (its `react`): crashes, guitar jumps, fills. They're soft:
//     the tubes swell in their own colour, the beams lift. The white slams belong to the cues that punch;
//   · the band's level shapes the looks, like the recording's energy curve does in rehearsal;
//   · when the band stops dead, the rig goes dark with it, and comes back on the next hit.
// The hit detection (bridge/audio-in.swift) was tuned on the stems of a rehearsal (Kepler, 8 Nov 2026). Kick and
// snare are reliable. A "crash" here is a loud hit in an overhead's band above 5 kHz: cymbal accents, not checked by ear.

import { beamSwell, bloom, show } from './show.js';
import { inputs } from './inputs.js';
import { cues, index } from './setlist.js';

const STOP_STORE = 'owashi-sim:dark-on-stop';
export const live = {
  darkOnStop: true,   // a setting in the Inputs sheet
  level: -90,         // the band, all assigned channels together, dBFS, smoothed like a meter
};
try { live.darkOnStop = JSON.parse(localStorage.getItem(STOP_STORE)) ?? true; } catch { /* default */ }
export function setDarkOnStop(on) {
  live.darkOnStop = on;
  if (!on) show.autoChoke = false;
  try { localStorage.setItem(STOP_STORE, JSON.stringify(on)); } catch { /* for this visit */ }
}

let now = () => performance.now() / 1000;
export function configure(opts) { ({ now } = opts); }

const LIVE_FOR = 3;        // the drums count as driving while a kick or snare came in this many seconds ago
const SAME_CRASH = 0.06;   // the two overheads hear the same cymbal: one crash, not two
const GUITAR_GAP = 1.5;    // the beams lift for a guitar at most this often
const BLOOM_GAP = 0.8;     // and the tubes swell for a crash or a fill at most this often, so busy drumming doesn't flicker
const D = show.drums;
let lastGuitar = -10, lastBloom = -10;

const react = () => cues.value[index.value]?.react ?? 'crash';
// looks that already answer crashes themselves
const OWN_CRASH = new Set(['riff', 'breakdown', 'wall']);

inputs.hitListeners.add((ch, v, role, band) => {
  const t = now(), r = react(), dark = show.scene === 'blackout' || show.scene === 'strobe';
  if (band === 'hi') {   // the cymbal band counts in the overheads only; their full-band hits are mostly the snare
    if (role !== 'overheads' || t - D.crash < SAME_CRASH) return;
    D.crash = t; D.crashN++;
    if (r !== 'off' && !dark && !OWN_CRASH.has(show.scene) && t - lastBloom > BLOOM_GAP) { lastBloom = t; bloom(t, 0.5 + 0.5 * v); }
    return;
  }
  if (show.autoChoke && role) show.autoChoke = false;   // the band is back
  if (role === 'kick') { D.kick = t; D.kickN++; D.hit = t; D.hitN++; D.lastKickOrSnare = t; }
  else if (role === 'snare') { D.snare = t; D.snareN++; D.hit = t; D.hitN++; D.lastKickOrSnare = t; }
  else if (role === 'toms' && r === 'all' && !dark && t - lastBloom > BLOOM_GAP) { lastBloom = t; bloom(t, 0.25 + 0.3 * v); }
  else if ((role === 'gtr-left' || role === 'gtr-right') && (r === 'guitar' || r === 'all') && !dark && v >= 0.5 && t - lastGuitar > GUITAR_GAP) {
    lastGuitar = t;
    beamSwell(t, 0.5 + 0.5 * v);
  }
});

// ── level: energy and stops ─────────────────────────────────────────────────

const history = [];        // the band's level over the last second, 20 a second
let peak = -90, peakCue = -1;
inputs.levelListeners.add(() => {
  const t = now();
  let sum = 0, any = false;
  inputs.levels.forEach((db, i) => { if (inputs.roles[i]) { sum += 10 ** (db / 10); any = true; } });
  const raw = any ? 10 * Math.log10(sum + 1e-12) : -90;
  live.level = raw > live.level ? raw : live.level + (raw - live.level) * 0.1;   // up at once, down over about half a second
  history.push(raw); if (history.length > 20) history.shift();
  D.live = any && t - D.lastKickOrSnare < LIVE_FOR;

  // energy: how far the band has dropped below its loudest since this cue started (after the cue has landed)
  if (index.value !== peakCue) { peakCue = index.value; peak = -90; show.cueLandT = t; }
  if (t - show.cueLandT > 1.5) peak = Math.max(peak, live.level);
  show.liveEnergy = any && peak > -60 ? 1 - Math.min(1, Math.max(0, (peak - live.level) / 12)) : null;

  // a dead stop: everything falls 24 dB within half a second, down near the noise
  if (live.darkOnStop && any && !show.autoChoke) {
    const before = Math.max(...history.slice(0, 10));
    if (before > -40 && raw < before - 24 && raw < -50) show.autoChoke = true;
  } else if (show.autoChoke && raw > -40) show.autoChoke = false;
});
