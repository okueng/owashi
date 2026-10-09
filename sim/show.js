// The built-in show: looks for long instrumental metal pieces, written as DMX into the universes.
// It never touches the 3D scene — swap it for Art-Net input and the view won't know the difference.
//
// The looks follow the arc of a piece rather than a pop song: clean intro → melodic lead → build →
// riff → blast → breakdown → wall (climax) → embers (outro). Colour A is the main colour, B the
// secondary one; the calm looks use B, the heavy ones A. Rubato looks (ambient, embers) run on
// seconds, everything with drums on the tempo grid.
//
// Patterns are written along each bar from u = 0 (bottom / left) to u = 1 (top / right), so the
// same look works on the 64-zone tubes and the 16-pixel floor bars.

import { byId, fixtures } from './dmx.js';

export const PALETTE = {
  Red: { rgb: [255, 6, 0], wheel: 'Red' },
  Amber: { rgb: [255, 70, 0], wheel: 'Orange' },
  White: { rgb: [255, 246, 236], wheel: 'White' },
  Ice: { rgb: [140, 195, 255], wheel: 'Light blue' },
  Teal: { rgb: [0, 170, 190], wheel: 'Cyan' },
  Blue: { rgb: [0, 24, 255], wheel: 'Blue' },
  UV: { rgb: [60, 0, 255], wheel: 'UV' },
  Green: { rgb: [40, 255, 16], wheel: 'Green' },
};

export const BUILD_BARS = 16;

export const show = {
  scene: 'ambient',
  cueT: 0,           // when the current look was triggered (s) — builds count from here
  bpm: 120,
  beat0: 0,          // time (s) of a beat, so taps line the grid up with the music
  colorA: 'Red',
  colorB: 'Blue',
  master: 1,
  flash: false,      // held: everything white and strobing
  hitT: -10,         // last one-shot hit (s)
};

const V = ['V1', 'V2', 'V3', 'V4'].map(id => byId[id]);   // the tubes
const H = ['H1', 'H2'].map(id => byId[id]);               // the floor bars
const B = ['B1', 'B2', 'B3', 'B4'].map(id => byId[id]);   // the LB150s
const BARS = [...V, ...H];
const SIDE = [-1, 1, -1, 1];   // B1/B3 stage left, B2/B4 stage right (as the audience sees it)
const FRONT = [0, 0, 1, 1];    // B1/B2 at the back, B3/B4 at the front corners
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

const frac = x => x - Math.floor(x);
const clamp01 = x => Math.min(1, Math.max(0, x));
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const hash = n => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// fn(u) → [r, g, b] 0–255 for every zone; level 0–1; strobe 0 (none) to 1 (fastest)
function paint(f, fn, level = 1, strobe = 0) {
  f.level(level); f.strobe(strobe);
  for (let i = 0; i < f.n; i++) { const c = fn((i + 0.5) / f.n); f.setZone(i, c[0], c[1], c[2]); }
}
function beam(f, { pan, tilt, color = 'White', level = 1, prism = false, strobe = 0 }) {
  if (pan !== undefined) f.aim(pan, tilt);
  f.colour(color); f.level(level); f.strobe(strobe); f.prism(prism);
  f.set('P/T speed', 0); f.set('Gobo', 0); f.set('Function', 0);
}

// beam positions the heavy looks jump between (always moved while dark)
const POSITIONS = [
  k => ({ pan: SIDE[k] * (FRONT[k] ? 18 : 8), tilt: 8 }),           // straight up, tight fan
  k => ({ pan: SIDE[k] * (FRONT[k] ? 22 : 12), tilt: 68 }),         // down into the crowd
  k => ({ pan: -SIDE[k] * (FRONT[k] ? 35 : 28), tilt: 42 }),        // crossing over the middle
  k => ({ pan: SIDE[k] * (FRONT[k] ? 62 : 50), tilt: 48 }),         // wide out to the walls
];

const SCENES = {
  // Clean intro or interlude: a low glow rising from the floor, beams standing still and dim.
  ambient({ t, B: Bc }) {
    V.forEach((f, k) => {
      const h = 0.4 + 0.18 * Math.sin(t * 0.21 + k * 1.7);
      paint(f, u => mul(Bc.rgb, smooth(h, h - 0.45, u) * (0.8 + 0.2 * Math.sin(t * 0.8 + u * 10 + k))), 0.7);
    });
    H.forEach(f => paint(f, () => mul(Bc.rgb, 0.5), 0.12));
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * ((FRONT[k] ? 22 : 10) + 4 * Math.sin(t * 0.09 + k)),
      tilt: 12 + 5 * Math.sin(t * 0.11 + k * 2),
      color: Bc.wheel, level: 0.2,
    }));
  },

  // Melodic lead: a soft blob of colour climbing each tube, beams sweeping the room together like searchlights.
  sweep({ beat, A, B: Bc }) {
    V.forEach((f, k) => {
      const pos = frac(beat / 8 + k / 4) * 1.3 - 0.15;
      paint(f, u => mix(mul(Bc.rgb, 0.25), A.rgb, Math.exp(-(((u - pos) / 0.06) ** 2) / 2)), 0.7);
    });
    H.forEach(f => paint(f, () => mul(Bc.rgb, 0.4), 0.3));
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (FRONT[k] ? 14 : 6) + 38 * Math.sin(beat * Math.PI / 8),
      tilt: 52 + 10 * Math.sin(beat * Math.PI / 16),
      color: 'White', level: 0.75,
    }));
  },

  // Build: 16 bars from the moment it's triggered. Tubes fill bottom-up, pulses go 1/4 → 1/8 → 1/16,
  // beams lift from the crowd to straight up, and the last two bars strobe. Then it holds at the peak.
  build({ beat, since, A, B: Bc }) {
    const p = clamp01(since / (BUILD_BARS * 4));
    const rate = p < 0.5 ? 1 : p < 0.75 ? 2 : 4;
    const pulse = 0.45 + 0.55 * Math.exp(-frac(beat * rate) * 5);
    const strobe = p > 0.875 ? ((p - 0.875) / 0.125) * 0.8 : 0;
    const top = 0.04 + 0.96 * p;                     // how far up the tubes are lit
    const col = mul(mix(Bc.rgb, A.rgb, p), pulse);
    V.forEach(f => paint(f, u => mul(col, 1 - smooth(top, top + 0.04, u)), 0.27 + 0.73 * p, strobe));
    H.forEach(f => paint(f, () => col, 0.27 + 0.73 * p, strobe));
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * ((FRONT[k] ? 45 : 30) * (1 - p) + 8), tilt: 72 * (1 - p) + 6,
      color: A.wheel, level: (0.15 + 0.85 * p) * pulse, strobe,
    }));
  },

  // Riff: everything punches on the beat in colour A, the downbeat of each bar hits white.
  // Beams hold a fan and trade front/back on alternate beats; the floor bars chug on eighths.
  riff({ beat, A, B: Bc }) {
    const n = Math.floor(beat), e = Math.exp(-frac(beat) * 6), e8 = Math.exp(-frac(beat * 2) * 8);
    const down = n % 4 === 0;
    V.forEach(f => paint(f, () => mix(mul(Bc.rgb, 0.06), down ? WHITE : A.rgb, 0.12 + 0.88 * e)));
    H.forEach(f => paint(f, () => mul(A.rgb, 0.15 + 0.85 * e8)));
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (FRONT[k] ? 38 : 24), tilt: FRONT[k] ? 30 : 40,
      color: down ? 'White' : A.wheel,
      level: down || n % 2 === FRONT[k] ? e : 0,
    }));
  },

  // Blast beats: white sparks on sixteenths (in 17 cm chunks so they read from the back of the room),
  // floor bars ping-pong, beams whip side to side every beat.
  blast({ beat, A }) {
    const s = Math.floor(beat * 4), n = Math.floor(beat);
    V.forEach((f, k) => paint(f, u => {
      const r = hash(s * 97 + k * 31 + Math.floor(u * 12));
      return r > 0.8 ? WHITE : r > 0.6 ? A.rgb : BLACK;
    }));
    H.forEach((f, k) => paint(f, () => (Math.floor(beat * 2) % 2 === k ? WHITE : mul(A.rgb, 0.2))));
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * ((n + FRONT[k]) % 2 ? 48 : 8), tilt: 32,
      color: 'White', strobe: 0.75,
    }));
  },

  // Breakdown: half-time slams. Everything hits on every other beat and dies straight away;
  // the beams jump to a new position in the dark, so each hit lands somewhere else.
  breakdown({ beat, A }) {
    const half = beat / 2, h = Math.floor(half), ph = frac(half);
    const e = Math.exp(-ph * 7);
    const c = h % 4 === 0 ? WHITE : A.rgb;
    BARS.forEach(f => paint(f, () => c, e));
    const pos = POSITIONS[(ph < 0.4 ? h : h + 1) % POSITIONS.length];
    B.forEach((f, k) => beam(f, {
      ...pos(k), color: h % 4 === 0 ? 'White' : A.wheel,
      level: e, prism: h % 2 === 1,
    }));
  },

  // Wall of sound / climax: tubes full with white crowns swelling every bar, white floor line,
  // and a cathedral of beams fanned up through the haze, the 6-facet prism turning slowly.
  wall({ t, beat, A }) {
    const swell = 0.78 + 0.22 * Math.exp(-frac(beat / 4) * 2.5);
    V.forEach(f => paint(f, u => mix(A.rgb, WHITE, smooth(0.78, 0.86, u)), swell));
    H.forEach(f => paint(f, () => WHITE, 0.55));   // close to the audience now — don't blind them
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * ((FRONT[k] ? 30 : 12) + 5 * Math.sin(t * 0.3 + k)),
      tilt: 18 + 8 * Math.sin(t * 0.4 + k),
      color: 'White', prism: 'spin',
    }));
  },

  // Outro: embers drifting at the foot of the tubes, beams out.
  embers({ t, A }) {
    const amber = PALETTE.Amber.rgb;
    V.forEach((f, k) => paint(f, u => {
      const glow = ((0.5 + 0.5 * Math.sin(u * 23 + t * 0.9 + k * 2.1)) * (0.5 + 0.5 * Math.sin(u * 9.7 - t * 0.6 + k))) ** 1.5;
      return mul(mix(amber, A.rgb, 0.5 + 0.5 * Math.sin(u * 13 + k)), glow * (1 - u * 0.85));
    }, 0.5));
    H.forEach(f => paint(f, () => mul(PALETTE.Red.rgb, 0.6), 0.1));
    B.forEach(f => f.level(0));
  },

  strobe() {
    BARS.forEach(f => paint(f, () => WHITE, 1, 0.92));
    B.forEach((f, k) => beam(f, { pan: SIDE[k] * (FRONT[k] ? 20 : 12), tilt: 10, strobe: 0.92 }));
  },

  blackout() {
    // positions hold where they were, like a real desk; only the light goes
    BARS.forEach(f => paint(f, () => BLACK, 0));
    B.forEach(f => f.level(0));
  },
};

// in the order a piece usually travels through them
export const SCENE_LIST = [
  ['ambient', 'Ambient', '1'], ['sweep', 'Sweep', '2'], ['build', 'Build', '3'], ['riff', 'Riff', '4'],
  ['blast', 'Blast', '5'], ['breakdown', 'Breakdown', '6'], ['wall', 'Wall', '7'], ['embers', 'Embers', '8'],
  ['strobe', 'Strobe', '9'], ['blackout', 'Blackout', '0'],
];

export function cue(id, t) {
  show.scene = id;
  show.cueT = t;
}

export function hit(t) { show.hitT = t; }

// 0–1 through the build, for the UI
export const buildProgress = t => clamp01(((t - show.cueT) * show.bpm / 60) / (BUILD_BARS * 4));

const px = [0, 0, 0];
export function updateShow(t) {
  const beat = (t - show.beat0) * show.bpm / 60;
  const since = (t - show.cueT) * show.bpm / 60;
  SCENES[show.scene]({ t, beat, since, A: PALETTE[show.colorA], B: PALETTE[show.colorB] });

  // one-shot accent on top of any look: a white slam that dies in half a second
  const h = Math.exp(-(t - show.hitT) * 6);
  if (h > 0.02) {
    for (const f of BARS) {
      for (let i = 0; i < f.n; i++) f.setZone(i, ...mix(f.getZone(i, px), WHITE, h));
      f.level(Math.max(f.getLevel(), h));
    }
    for (const f of B) {
      f.level(Math.max(f.getLevel(), h));
      if (h > 0.3) f.colour('White');
    }
  }

  if (show.flash) {
    BARS.forEach(f => paint(f, () => WHITE, 1, 0.88));
    B.forEach(f => { f.colour('White'); f.level(1); f.strobe(0.88); });
  }
  if (show.master < 1) for (const f of fixtures) f.level(f.getLevel() * show.master);
  for (const f of fixtures) f.commit(t);
  return beat;
}

const taps = [];
export function tap(t) {
  if (taps.length && t - taps[taps.length - 1] > 2) taps.length = 0;
  taps.push(t);
  if (taps.length > 5) taps.shift();
  if (taps.length >= 2) {
    const span = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    show.bpm = Math.round(Math.min(240, Math.max(40, 60 / span)));
  }
  show.beat0 = t;
}
