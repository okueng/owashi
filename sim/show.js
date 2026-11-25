// The built-in show: looks for long instrumental metal pieces, written as DMX into the universes.
// It never touches the 3D scene — swap it for Art-Net input and the view won't know the difference.
//
// The looks follow the arc of a piece rather than a pop song: clean intro → melodic lead → build →
// riff → blast → breakdown → wall (climax) → embers (outro). Colour A is the main colour, B the
// secondary one; the calm looks use B, the heavy ones A. Rubato looks (ambient, embers) run on
// seconds, everything with drums on the tempo grid.
//
// Patterns are written along each tube from u = 0 (bottom, or left on the front bars) to u = 1 (top, or right).

import { byId, fixtures } from './dmx.js';

export const PALETTE = {
  Red: { rgb: [255, 6, 0], wheel: 'Red' },
  Amber: { rgb: [255, 70, 0], wheel: 'Orange', amber: 1 },   // amber and uv: how much of the PARs' own amber and UV LEDs
  White: { rgb: [248, 252, 255], wheel: 'White' },
  Ice: { rgb: [140, 195, 255], wheel: 'Light blue' },
  Teal: { rgb: [0, 170, 190], wheel: 'Cyan' },
  Blue: { rgb: [0, 24, 255], wheel: 'Blue' },
  UV: { rgb: [60, 0, 255], wheel: 'Blue', uv: 1 },   // the heads' wheel has no violet: blue is the nearest
  Green: { rgb: [40, 255, 16], wheel: 'Green' },
};

export const BUILD_BARS = 16;
const SHIMMER_BARS = 28;
const COLLAPSE_BARS = 8;

export const show = {
  scene: 'ambient',
  cueT: 0,           // when the current look was triggered (s) — builds count from here
  bpm: 120,
  beat0: 0,          // time (s) of a beat, so taps line the grid up with the music
  colorA: 'Red',
  colorB: 'Blue',
  master: 1,
  beams: 0.5,        // the heads' share of Master: a 150 W beam outshines the diffuse tubes at the same level
  flash: false,      // held: everything white and strobing
  hitT: -10,         // last one-shot hit (s)
  hitV: 1,           // and how hard (a pad's velocity, 0–1)
  beamHitT: -10, beamHitV: 1,   // a hit on the heads only
  tubeHitT: -10, tubeHitV: 1,   // a hit on the tubes and bars only
  choke: false,      // held: everything dark, for the band's stops
  swap: false,       // held: colours A and B trade places
  // Set by the setlist while a song's cues are running; neutral otherwise.
  energy: 1,         // 0–1: how loud the music is now against the loudest moment of this cue (1 = no shaping)
  cueP: 0.5,         // 0–1: progress along the current chapter's timer (0.5 in Manual mode)
  lead: '',          // '', 'left', 'right' or 'trade': whose beam carries the lead guitar (as the audience sees it)
  variant: 0,        // which version of the look (VARIANTS); 0 for the looks that have only one
  from: null,        // the look we're fading out of: { scene, cueT, a, b, variant }
  fromT: 0, fromLen: 0,
  // Set by live.js from the mixer: the drummer's strokes (show time), the band's level, and dead stops.
  drums: { live: false, kick: -10, snare: -10, crash: -10, hit: -10, kickN: 0, snareN: 0, crashN: 0, hitN: 0, lastKickOrSnare: -10 },
  liveEnergy: null,  // 0–1 like `energy`, from the band's level; null when there's no mixer
  cueLandT: 0,
  autoChoke: false,  // the band stopped dead: dark like Choke until the next hit
  bloomT: -10, bloomV: 0,   // a live crash: the tubes swell in their own colour (no white flash)
  swellT: -10, swellV: 0,   // a live guitar jump: the beams lift
  guitarBoost: 0,           // 0–1: sustained lead guitar above its rolling baseline (live.js)
  mark: null,               // next lit cue to pre-position heads for during blackout (Move in Black)
  wheelTest: null,          // null, or { name, dmx } while testing LB150 colour wheel slots at soundcheck
};

const V = ['V1', 'V2', 'V3', 'V4'].map(id => byId[id]);   // the tubes
const H = ['H1', 'H2'].map(id => byId[id]).filter(Boolean);   // the horizontal bars at the stage front, when the rig has them
// The LB150s. B1 and B2 stand at the back corners; B3 and B4, when the rig has them, stand either side of the
// banner. The quiet looks keep to the outer pair, so four beams stay something the heavy looks earn.
const B = ['B1', 'B2', 'B3', 'B4'].map(id => byId[id]).filter(Boolean);
const OUTER = B.slice(0, 2), INNER = B.slice(2);
const isInner = new Set(INNER);
const BARS = [...V, ...H];
const FRONT_BAR_MAX = 0.5;     // they're close to the front row's eyes, so they never go past half
const SIDE = [-1, 1, -1, 1];   // B1 and B3 stage left, B2 and B4 stage right (as the audience sees it)
const SLOW = 200;              // the P/T speed that moves the real heads smoothly and slowly
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

const frac = x => x - Math.floor(x);
// n-th of `len`, going round; n may be negative (a cue can land a moment before its first beat)
const wrap = (n, len) => ((n % len) + len) % len;
const clamp01 = x => Math.min(1, Math.max(0, x));
const mix = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const hash = n => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
// 0–1, wandering about 12 times a second, differently for every n
const twinkle = (t, n) => {
  const x = t * 12 + hash(n) * 8, i = Math.floor(x);
  const a = hash(i * 17 + n * 53), b = hash((i + 1) * 17 + n * 53);
  return a + (b - a) * smooth(0, 1, x - i);
};

// fn(u) → [r, g, b] 0–255 for every zone; level 0–1; strobe 0 (none) to 1 (fastest)
function paint(f, fn, level = 1, strobe = 0) {
  f.level(level); f.strobe(strobe);
  for (let i = 0; i < f.n; i++) { const c = fn((i + 0.5) / f.n); f.setZone(i, c[0], c[1], c[2]); }
}
// The December room: the heads stand at the back of an alcove whose ceiling is 2.6 m, under a soffit at 2.4 m. A beam
// leaning towards the audience hits that ceiling above the band after about 2 m and, seen from the room, comes
// straight at you and looks short. Leaning sideways it draws a long diagonal across the black curtain. So the
// looks' side angle is widened here (pan × SIDEWAYS, up to the ±90° limit) and their lean is kept: the same
// moves, turned to the sides. Set SIDEWAYS to 1 for a stage with height over the audience.
const SIDEWAYS = 1.7;
// The alcove is about 5 m wide, so the outer heads stand only about 0.7 m from its side walls, by the steps and the
// doorway on the right. No beam may land on a side wall below 2.2 m (head height on the steps): leaning outwards,
// its sideways run may be at most half its rise, about 27° from upright. Leaning inwards it's free.
const MAX_OUT_LEAN = 0.5;
const D2R = Math.PI / 180;
function aim(f, pan, tilt) {
  const out = Math.sin(tilt * D2R) * Math.sin(pan * D2R) * SIDE[B.indexOf(f)];   // > 0 when leaning towards its wall
  if (out > 0 && out / Math.cos(tilt * D2R) > MAX_OUT_LEAN) tilt = Math.sign(tilt) * Math.atan(MAX_OUT_LEAN / Math.abs(Math.sin(pan * D2R))) / D2R;
  f.aim(pan, tilt);
}
// `exact` aims a head as given, for shapes that need each head placed (the crossing behind the drums)
function beam(f, { pan, tilt, exact = false, color = 'White', level = 1, prism = false, strobe = 0, speed = 0 }) {
  // the inner pair stands nearer the middle: it leans out less and stays more upright, so the four make a fan
  if (pan !== undefined) exact ? aim(f, pan, tilt) : isInner.has(f) ? aim(f, pan * 0.45 * SIDEWAYS, tilt * 0.8) : aim(f, pan * SIDEWAYS, tilt);
  f.colour(color); f.level(level); f.strobe(strobe); f.prism(prism);
  f.set('P/T speed', speed); f.set('Gobo', 0); f.set('Function', 0);
}
// A head goes black with its dimmer and shutter; pan and tilt stay where they are.
const dark = f => { f.level(0); f.set('Shutter', 0); };
const isBack = k => k === 1 || k === 2;   // V2 and V3 stand at the back, V1 and V4 at the sides
// paint the two front bars as one line, x = 0 (audience's left) to 1 (right)
const line = (fn, level = 1, strobe = 0) => H.forEach((f, k) => paint(f, u => fn((k + u) / 2), level, strobe));

// beam positions the heavy looks jump between. The jumps can be 150° (from the fan to the crossing), so the heads
// only ever make them with the shutter closed: see MOVE_S and its use in Drive and Breakdown. Under the alcove's low
// ceiling they're shapes across the back of the stage: nothing reaches over the audience.
const POSITIONS = [
  k => ({ pan: SIDE[k] * 12, tilt: 8 }),    // straight up, tight fan
  k => ({ pan: SIDE[k] * 55, tilt: 45 }),   // wide fan, the outer pair leaning out as far as MAX_OUT_LEAN allows
  // crossing: the inner pair makes an X behind the drummer, about 1.7 m up, the outer pair leans in over it
  k => (k < 2 ? { pan: -SIDE[k] * 60, tilt: 40, exact: true } : { pan: -SIDE[k] * 90, tilt: 42, exact: true }),
  // all four leaning the same way, parallel: to the left, away from the steps and doorway, within MAX_OUT_LEAN
  () => ({ pan: -70, tilt: 27, exact: true, parallel: true }),
];
// Seconds the heads get, dark and at full speed, to reach a new position: the LB150 pans 540° in 2.5 s, so a 150°
// jump takes 0.7 s, plus time to settle.
const MOVE_S = 1.0;

// where Drive's beams rest, 8 bars each: crossed, fanned out, leaning, straight up
const DRIVE_POSITIONS = [POSITIONS[2], POSITIONS[1], POSITIONS[3], POSITIONS[0]];

// The rig has depth, and the looks use it: the back pair and the side pair answer each other. The front bars
// are the only light on the band's faces, so they stay low until a look means to reveal the band, and their
// zones make one line across the stage. No look relies on them: they aren't built yet, and the rest stands alone.
const SCENES = {
  // Clean intro or interlude: a low glow rising behind the band, fainter at the sides, the band in near-darkness.
  // Clean intro or interlude: starts low and moody at the foot of the tubes, then rises up the tubes and
  // gently opens the outer beams along the chapter timer (p = 0 → 1).
  ambient({ t, p, A, B: Bc }) {
    V.forEach((f, k) => {
      const back = isBack(k);
      const h = (back ? 0.22 + 0.5 * p : 0.12 + 0.32 * p) + (back ? 0.14 : 0.08) * Math.sin(t * 0.21 + k * 1.7);
      paint(f, u => {
        const col = back ? mix(A.rgb, Bc.rgb, smooth(0.05, 0.42, u) * 0.72 + 0.28) : Bc.rgb;
        return mul(col, smooth(h, h - 0.45, u) * (0.8 + 0.2 * Math.sin(t * 0.8 + u * 10 + k)));
      }, (back ? 0.45 : 0.28) + (back ? 0.48 : 0.34) * p);
    });
    line(x => mul(Bc.rgb, 0.2 + 0.2 * p + 0.15 * Math.sin(t * 0.3 + x * 6)), 0.15 + 0.15 * p);
    OUTER.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (12 + 8 * p + 4 * Math.sin(t * 0.09 + k)),
      tilt: 16 - 6 * p + 5 * Math.sin(t * 0.11 + k * 2),
      color: Bc.wheel, level: 0.06 + 0.28 * p, speed: SLOW,
    }));
    INNER.forEach(dark);
  },

  // Melodic lead & groove: rich waves of colour climb the back pair, then the side pair half a cycle later,
  // swelling in height and beam presence along the chapter timer.
  sweep({ beat, p, A, B: Bc }) {
    V.forEach((f, k) => {
      const pos = frac(beat / 8 + (isBack(k) ? 0 : 0.5) + (k < 2 ? 0 : 0.06)) * 1.3 - 0.15;
      paint(f, u => mix(mul(Bc.rgb, 0.22 + 0.18 * p), A.rgb, Math.exp(-(((u - pos) / (0.1 + 0.06 * p)) ** 2) / 2)), 0.55 + 0.42 * p);
    });
    const swing = Math.sin(beat * Math.PI / 8), pool = 0.5 + 0.5 * swing;
    line(x => mix(mul(Bc.rgb, 0.15), A.rgb, Math.exp(-(((x - pool) / 0.16) ** 2) / 2)), 0.45 + 0.3 * p);
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * 10 + (28 + 16 * p) * swing,
      tilt: 38 - 10 * p + 10 * Math.sin(beat * Math.PI / 16),
      color: A.wheel, level: 0.34 + 0.48 * p, speed: SLOW,
    }));
  },

  // Build: 16 bars from the moment it's triggered. The back pair fills bottom-up with the side pair chasing it,
  // the front line opens out from the centre, pulses go 1/4 → 1/8 → 1/16, beams lift from over the crowd to
  // straight up, and the last two bars strobe. Then it holds at the peak.
  build({ beat, since, A, B: Bc }) {
    const p = clamp01(since / (BUILD_BARS * 4));
    const rate = p < 0.5 ? 1 : p < 0.75 ? 2 : 4;
    const depth = 0.12 + 0.43 * p;   // the pulses start as a ripple and only bite near the top
    const pulse = 1 - depth + depth * Math.exp(-frac(beat * rate) * 5);
    const strobe = p > 0.875 ? ((p - 0.875) / 0.125) * 0.8 : 0;
    const col = mul(mix(Bc.rgb, A.rgb, p), pulse);
    const level = 0.27 + 0.73 * p;
    V.forEach((f, k) => {
      const top = 0.04 + 0.96 * (isBack(k) ? clamp01(p / 0.85) : clamp01((p - 0.15) / 0.85));   // how far up it's lit
      paint(f, u => mul(col, 1 - smooth(top, top + 0.04, u)), level, strobe);
    });
    line(x => mul(col, 1 - smooth(p, p + 0.06, Math.abs(x - 0.5) * 2)), level, strobe);
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (36 * (1 - p) + 8), tilt: 39 * (1 - p) + 6,
      color: A.wheel, level: (0.15 + 0.85 * p) * pulse, strobe,
    }));
  },

  // Riff: the back pair and the side pair trade beats like kick and snare, and the downbeat of each bar hits
  // everything white. Intensity escalates along the chapter timer.
  riff({ t, beat, p, A, B: Bc }) {
    const D = show.drums;
    const drive = 0.68 + 0.32 * p;
    if (D.live) {   // the drummer is the clock: kicks hit the back pair, snares the sides, a crash turns it all white
      const ek = Math.exp(-(t - D.kick) * 6), es = Math.exp(-(t - D.snare) * 6), ec = Math.exp(-(t - D.crash) * 4);
      const crash = ec > 0.3, any = Math.exp(-(t - D.hit) * 8);
      V.forEach((f, k) => {
        const h = Math.max(isBack(k) ? ek : es, ec);
        paint(f, () => mix(mul(Bc.rgb, 0.06), crash ? WHITE : A.rgb, 0.12 + 0.88 * h), drive);
      });
      line(() => mul(A.rgb, 0.15 + 0.85 * any), drive);
      B.forEach((f, k) => beam(f, {
        pan: SIDE[k] * (24 + 14 * p), tilt: 40 - 10 * p, color: crash ? 'White' : A.wheel,
        level: Math.max(ec, D.snareN % 2 === (k % 2) ? es * (0.65 + 0.35 * p) : 0),
      }));
      return;
    }
    const n = Math.floor(beat), e = Math.exp(-frac(beat) * 6), e8 = Math.exp(-frac(beat * 2) * 8);
    const down = n % 4 === 0, three = n % 4 === 2, bar = Math.floor(n / 4);
    V.forEach((f, k) => {
      const hit = down || (n % 2 === 0) === isBack(k) ? e : 0;
      paint(f, () => mix(mul(Bc.rgb, 0.06), down ? WHITE : A.rgb, 0.12 + 0.88 * hit), drive);
    });
    line(() => mul(A.rgb, 0.15 + 0.85 * e8), drive);
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (24 + 14 * p), tilt: 40 - 10 * p,
      color: down ? 'White' : A.wheel,
      level: down || (three && bar % 2 === (k % 2)) ? e * drive : 0,
    }));
  },

  // Blast beats: white sparks on sixteenths (in 17 cm chunks so they read from the back of the room),
  // a white spark racing back and forth along the front line, beams whipping side to side every beat.
  blast({ beat, A }) {
    const D = show.drums;   // live, every stroke reshuffles the sparks and each snare whips the beams
    const s = D.live ? D.hitN : Math.floor(beat * 4), n = D.live ? D.snareN : Math.floor(beat);
    V.forEach((f, k) => paint(f, u => {
      const r = hash(s * 97 + k * 31 + Math.floor(u * 12));
      return r > 0.8 ? WHITE : r > 0.6 ? A.rgb : BLACK;
    }));
    const step = s % 14, spark = (step < 8 ? step : 14 - step) / 7;
    line(x => (Math.abs(x - spark) < 0.08 ? WHITE : mul(A.rgb, 0.12)));
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * ((n + k) % 2 ? 48 : 8), tilt: 32,
      color: 'White', strobe: 0.75,
    }));
  },

  // Breakdown: half-time slams. Everything hits on every other beat; the front and sides die straight away,
  // while the back pair rings on a moment, leaving the band in silhouette. The beams jump to a new position
  // in the dark, so each hit lands somewhere else.
  breakdown({ t, beat, A }) {
    const D = show.drums;
    let h, ph, e, ring, c;
    if (D.live) {   // a slam on every snare and crash; white when it's a crash
      const slam = Math.max(D.snare, D.crash), dt = t - slam;
      h = D.snareN + D.crashN; ph = Math.min(1, dt / 1.1);
      e = Math.exp(-dt * 6); ring = Math.exp(-dt * 3);
      c = D.crash >= D.snare ? WHITE : A.rgb;
    } else {
      const half = beat / 2; h = Math.floor(half); ph = frac(half);
      e = Math.exp(-ph * 7); ring = Math.exp(-ph * 3.5);
      c = h % 4 === 0 ? WHITE : A.rgb;
    }
    V.forEach((f, k) => paint(f, () => c, isBack(k) ? ring : e));
    line(() => c, e);
    // each slam lands somewhere new: the beams close a quarter of the way in and head for the next position at
    // full speed in the dark (0.75 s at 120 BPM; live, the next snare may still catch them on the way)
    const moved = ph >= 0.25, pos = POSITIONS[wrap(moved ? h + 1 : h, POSITIONS.length)];
    B.forEach((f, k) => {
      beam(f, { ...pos(k), color: h % 4 === 0 ? 'White' : A.wheel, level: moved ? 0 : e, speed: moved ? 0 : SLOW });
      if (moved) dark(f);
    });
  },

  // Wall of sound / climax, and the one place the band is fully revealed: tubes full with a molten upward
  // shimmer and white crowns that surge down on live crashes and push hotter along the chapter timer.
  wall({ t, beat, p, A }) {
    const D = show.drums;   // live, it swells and surges on the crashes rather than every bar
    const crash = D.live ? Math.exp(-(t - D.crash) * 1.4) : Math.exp(-frac(beat / 4) * 2.5);
    const swell = (0.72 + 0.12 * p) + (0.16 + 0.08 * p) * crash;
    V.forEach((f, k) => {
      const crown = (isBack(k) ? 0.72 : 0.82) - 0.14 * p - 0.14 * crash;
      paint(f, u => {
        const wave = 0.84 + 0.16 * Math.sin((u * 2.2 - t * 0.9) * Math.PI * 2 + k * 1.1);
        const edge = 0.08 * twinkle(t * 0.5, Math.floor(u * 24) + k * 80);
        const body = mul(A.rgb, wave);
        return mix(body, WHITE, smooth(crown - edge, crown + 0.1, u));
      }, swell);
    });
    line(() => WHITE, swell);
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (16 + 10 * p + 5 * Math.sin(t * 0.3 + k)),
      tilt: 22 - 8 * p + 8 * Math.sin(t * 0.4 + k),
      color: 'White', level: 0.82 + 0.18 * p, prism: 'spin', speed: SLOW,
    }));
  },

  // Outro: embers drifting at the foot of the tubes, fainter at the sides, and along the front line. Beams out.
  embers({ t, A }) {
    const amber = PALETTE.Amber.rgb;
    V.forEach((f, k) => paint(f, u => {
      const glow = ((0.5 + 0.5 * Math.sin(u * 23 + t * 0.9 + k * 2.1)) * (0.5 + 0.5 * Math.sin(u * 9.7 - t * 0.6 + k))) ** 1.5;
      return mul(mix(amber, A.rgb, 0.5 + 0.5 * Math.sin(u * 13 + k)), glow * (1 - u * 0.85));
    }, isBack(k) ? 0.5 : 0.3));
    line(x => {
      const glow = ((0.5 + 0.5 * Math.sin(x * 31 + t * 0.7)) * (0.5 + 0.5 * Math.sin(x * 13 - t * 0.45))) ** 1.5;
      return mul(mix(amber, A.rgb, 0.5), glow);
    }, 0.25);
    B.forEach(dark);
  },

  strobe() {
    BARS.forEach(f => paint(f, () => WHITE, 1, 0.92));
    B.forEach((f, k) => beam(f, { pan: SIDE[k] * 14, tilt: 10, strobe: 0.92 }));
  },

  blackout() {
    // positions hold where they were, like a real desk; only the light goes
    BARS.forEach(f => paint(f, () => BLACK, 0));
    B.forEach(dark);
  },

  // Slow, heavy chords: starts brooding and low, then swells taller and brighter along the chapter timer.
  slab({ t, beat, p, A, B: Bc, v }) {
    const ph = frac(beat / 8);
    const swell = smooth(0, 0.08, ph) * Math.exp(-ph * 2.5);
    const level = (0.42 + 0.32 * p) + (0.28 + 0.15 * p) * swell;
    V.forEach((f, k) => {
      const back = isBack(k), main = v ? !back : back, c = main ? A.rgb : mix(A.rgb, Bc.rgb, 0.35);
      const body = v === 2 ? (back ? u => 1 - smooth(0.1 + 0.2 * p, 0.3 + 0.25 * p, u) : u => 1 - 0.25 * u)
        : v === 1 ? u => 1 - (0.75 - 0.3 * p) * (1 - u) : u => 1 - (0.75 - 0.3 * p) * u;
      paint(f, u => mul(c, body(u)), main ? level : level * (0.45 + 0.35 * p));
    });
    line(() => A.rgb, 0.3 * level);
    const aim = v === 2 ? [55, 42] : v === 1 ? [12, 8] : [24, 26];
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * aim[0] + (v ? 3 : 6) * Math.sin(t * 0.08 + k), tilt: aim[1] - 6 * p,
      color: A.wheel, level: 0.15 + 0.35 * p + 0.45 * swell, speed: SLOW,
    }));
  },

  // Mid-tempo riffs and grooves: starts grounded & focused (lower tubes, outer beams leading) and escalates
  // along the chapter timer — tubes climb hotter, inner beams join in, and the static prism opens in the last third.
  drive({ t, beat, p, since, A, B: Bc, v }) {
    const D = show.drums;
    const kick = D.live ? Math.exp(-(t - D.kick) * 5) : 0.6 * Math.exp(-frac(beat / 2) * 6);
    const snare = D.live ? Math.exp(-(t - D.snare) * 5) : 0.6 * Math.exp(-frac(beat / 2 + 0.5) * 6);
    const phrase = wrap(Math.floor(Math.max(0, since) / 64), 4);
    const topCap = 0.56 + 0.44 * p;   // tubes climb from lower half to full 2 m height across the chapter
    V.forEach((f, k) => {
      const back = isBack(k), c = back ? A.rgb : mix(A.rgb, Bc.rgb, 0.45), th = back ? kick : snare;
      const lit = mix(c, WHITE, 0.25 + 0.35 * p);
      const flip = v === 1 && !back;
      paint(f, x => {
        const u = flip ? 1 - x : x;   // measured from the end the weight sits at
        const roll = 0.85 + 0.15 * Math.sin((u * 0.9 - beat / 8) * Math.PI * 2 + k * 0.8);
        const body = v === 1 ? 1 - 0.95 * smooth(0.35, 0.65, u)
          : v === 2 ? 0.08 + 0.92 * smooth(-0.2, 0.2, Math.sin((u * 2.5 - beat / 8 - (back ? 0 : 0.5)) * Math.PI * 2))
          : 1 - 0.45 * u;
        const cap = v === 0 ? 1 - smooth(topCap, topCap + 0.14, u) : 1;
        return mix(mul(c, body * roll * cap), lit, (0.35 + 0.3 * p) * th * (1 - smooth(0.15, 0.55, u)));
      }, (back || v === 1 || phrase === 3 ? 0.72 : 0.45) + 0.28 * p);
    });
    const pos = DRIVE_POSITIONS[wrap(Math.floor(beat / 32) + v, DRIVE_POSITIONS.length)];
    const usePrism = p > 0.66 || phrase === 2;
    // a new position every 32 beats: close half a beat before, swing there fast in the dark, open once arrived
    const at32 = frac(beat / 32) * 32, travel = MOVE_S * show.bpm / 60;
    const moving = at32 < travel, open = at32 > 31.5 ? 0 : smooth(travel, travel + 1, at32);
    // the drift is shared (the lean stays parallel) or mirrored (the fan and the crossing stay symmetric)
    const drift = 3 * Math.sin(t * 0.1), lift = 2 * Math.sin(t * 0.13);
    B.forEach((f, k) => {
      const at = pos(k);
      const baseLv = isInner.has(f) ? 0.14 + 0.66 * p : 0.36 + 0.52 * p;
      beam(f, {
        ...at, pan: at.pan + (at.parallel ? 1 : SIDE[k]) * drift, tilt: at.tilt - 5 * p + lift,
        color: A.wheel, level: baseLv * open, prism: usePrism, speed: moving ? 0 : SLOW,
      });
      if (open === 0) dark(f);
    });
  },

  // Fast thrash and double kick: crests climb hotter toward white, beams ramp wider & brighter along the
  // chapter timer, and static prism opens in the final third to drive into the next cue.
  surge({ t, beat, p, since, A, B: Bc, v }) {
    const low = mix(mul(Bc.rgb, 0.35), mul(A.rgb, 0.45), 0.5), high = mix(A.rgb, WHITE, 0.25 + 0.45 * p);
    const along = v === 2 ? u => Math.abs(u - 0.5) * 1.8 : v === 1 ? u => -u * 1.4 : u => u * 1.4;
    const phrase = wrap(Math.floor(Math.max(0, since) / 64), 3);
    V.forEach((f, k) => {
      const off = (isBack(k) ? 0 : 0.5) + (k < 2 ? 0 : 0.13);
      paint(f, u => mix(low, high, (0.5 + 0.5 * Math.sin((along(u) - beat / 4 - off) * Math.PI * 2)) ** 1.6),
        (isBack(k) ? 0.68 : 0.52) + 0.32 * p);
    });
    const aimMode = (v + (phrase === 2 ? 1 : 0)) % 3;
    B.forEach((f, k) => beam(f, {
      ...(aimMode === 2 ? { pan: SIDE[k] * (12 + 10 * p + 8 * Math.sin(t * 0.21 + k)), tilt: 16 - 6 * p + 6 * Math.sin(t * 0.33 + k * Math.PI) }
        : aimMode === 1 ? { pan: -SIDE[k] * (24 + 12 * p + 8 * Math.sin(t * 0.21 + k)), tilt: 36 - 8 * p + 8 * Math.sin(t * 0.33 + k * Math.PI) }
        : { pan: SIDE[k] * (28 + 16 * p + 10 * Math.sin(t * 0.21 + k)), tilt: 30 - 10 * p + 14 * Math.sin(t * 0.33 + k * Math.PI) }),
      color: A.wheel, level: 0.44 + 0.52 * p, prism: p > 0.66 || phrase === 1, speed: SLOW,
    }));
  },

  // The tubes go dark and the band stands in stark silhouette against the two PARs behind the kit, building
  // dramatic weight and overhead beam height along the chapter timer.
  backlight({ t, beat, p, A, B: Bc }) {
    const D = show.drums;
    const kick = D.live ? Math.exp(-(t - D.kick) * 5) : 0.6 * Math.exp(-frac(beat / 2) * 6);
    V.forEach((f, k) => paint(f, u => mul(A.rgb, 1 - smooth(0.02, 0.14 + 0.12 * p, u)), isBack(k) ? 0.15 + 0.15 * p + 0.65 * kick : 0));
    line(() => BLACK, 0);
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (30 + 10 * p + 3 * Math.sin(t * 0.1 + k)), tilt: 38 - 10 * p + 2 * Math.sin(t * 0.13 + k * 2),
      color: Bc.wheel, level: 0.22 + 0.48 * p, speed: SLOW,
    }));
  },

  // The four beams open from straight up into a wide fan and close again every 4 bars, widening and climbing
  // in intensity along the chapter timer.
  fan({ beat, p, A, B: Bc }) {
    V.forEach((f, k) => paint(f, u => mul(Bc.rgb, 1 - smooth(0, 0.22 + 0.2 * p, u)), (isBack(k) ? 0.18 : 0.08) + 0.16 * p));
    line(() => BLACK, 0);
    const open = 0.5 - 0.5 * Math.cos(beat * Math.PI / 8);
    const spread = 24 + 28 * p;
    B.forEach((f, k) => beam(f, { pan: SIDE[k] * (6 + spread * open), tilt: 6 + (26 + 14 * p) * open, color: A.wheel, level: 0.52 + 0.48 * p, speed: SLOW }));
  },

  // Shred solos: tubes glitter hotter and beams lift brighter across the solo's arc.
  glint({ t, p, A, B: Bc }) {
    const dim = mul(mix(Bc.rgb, A.rgb, 0.7), 0.3 + 0.18 * p), lit = mix(A.rgb, WHITE, 0.25 + 0.45 * p);
    V.forEach((f, k) => paint(f, u => mix(dim, lit, twinkle(t * (0.55 + 0.25 * p), Math.floor(u * 32) + k * 100) ** 1.5),
      (isBack(k) ? 0.68 : 0.52) + 0.32 * p));
    B.forEach((f, k) => beam(f, {
      pan: -SIDE[k] * (18 + 10 * p + 4 * Math.sin(t * 0.15 + k)), tilt: 28 - 12 * p + 5 * Math.sin(t * 0.1 + k * 2),
      color: A.wheel, level: 0.52 + 0.48 * p, speed: SLOW,
    }));
  },

  // Tremolo: a fine, fast texture that grows over 28 bars and then holds. Every chunk of tube twinkles on its own,
  // so the overall brightness stays steady and it reads as shimmer, not strobe. It climbs from the back pair
  // to the sides, turns from B to A, and the beams rise and open with it.
  shimmer({ t, since, A, B: Bc }) {
    const p = clamp01(since / (SHIMMER_BARS * 4));
    const texture = (q, n) => {
      const base = mix(Bc.rgb, A.rgb, q);
      return mix(mul(base, 0.18), mix(base, WHITE, 0.5 * q), twinkle(t, n) ** 2);
    };
    V.forEach((f, k) => {
      const q = isBack(k) ? p : clamp01(p * 1.15 - 0.15), top = 0.25 + 0.75 * q;
      paint(f, u => mul(texture(q, Math.floor(u * 32) + k * 100), 1 - smooth(top, top + 0.1, u)), 0.25 + 0.75 * q);
    });
    line(x => texture(p, Math.floor(x * 48) + 1000), 0.1 + 0.5 * p);
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (14 + 20 * p) + 3 * Math.sin(t * 0.2 + k), tilt: 30 - 20 * p,
      color: A.wheel, level: 0.1 + 0.6 * p, speed: SLOW,
    }));
  },

  // The band in black against the back pair, for as long as it's held. Pure white, breathing a little, nothing else on.
  silhouette({ t }) {
    const glow = 0.85 + 0.1 * Math.sin(t * 0.4);
    V.forEach((f, k) => paint(f, () => (isBack(k) ? WHITE : BLACK), isBack(k) ? glow : 0));
    line(() => BLACK, 0);
    B.forEach(dark);
  },

  // The beams lead: the outer pair as two white shafts crossing slowly through the haze, widening and brightening
  // along the chapter timer. When a sustained guitar lead enters, stage-left warms up in A.
  searchlight({ t, p, A, B: Bc }) {
    const gb = show.guitarBoost;
    V.forEach((f, k) => {
      const soloSide = k === 0 && gb > 0.02;
      paint(f, u => {
        const base = mul(Bc.rgb, 1 - smooth(0, 0.18 + 0.18 * p, u));
        return soloSide ? mix(base, A.rgb, gb * 0.7 * (1 - smooth(0.15, 0.62, u))) : base;
      }, (isBack(k) ? 0.08 + 0.14 * p : soloSide ? 0.06 + 0.42 * gb : 0.04 + 0.08 * p));
    });
    line(() => BLACK, 0);
    OUTER.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (8 - (26 + 20 * p) * (0.5 + 0.5 * Math.sin(t * 0.13 + k * 0.7))),
      tilt: 32 - 8 * p + 10 * Math.sin(t * 0.07 + k * 2),
      color: 'White', level: 0.55 + 0.45 * p, speed: SLOW,
    }));
    INNER.forEach((f, idx) => {
      if (idx === 0 && gb > 0.05) {   // B3 (stage left, Cyril): warms up in A during a wailing lead
        beam(f, { pan: -18 + 4 * Math.sin(t * 0.11), tilt: 22 + 4 * Math.sin(t * 0.09), color: A.wheel, level: 0.55 * gb, speed: SLOW });
      } else dark(f);
    });
  },

  // Hypnotic loops: one light circles the rig, widening its glow and lifting the beams along the chapter timer.
  orbit({ t, beat, p, A, B: Bc }) {
    const stops = H.length ? 5 : 4;              // the four tubes, then the front line if there is one
    const lap = frac(beat / 16), at = lap * stops;
    const glowAt = k => { const d = frac((at - k) / stops); return Math.min(1, Math.exp(-d * stops * 1.1) + Math.exp(-(1 - d) * stops * 6)); };
    V.forEach((f, k) => {
      const g = glowAt(k), h = 0.42 + 0.16 * p + 0.14 * Math.sin(t * 0.3 + k * 1.3);
      paint(f, u => {
        const blob = Math.exp(-(((u - h) / (0.18 + 0.1 * p)) ** 2) / 2);
        return mix(mul(Bc.rgb, (0.14 + 0.12 * p) * (1 - smooth(0, 0.4, u))), mix(A.rgb, WHITE, (0.25 + 0.25 * p) * g * blob ** 4), g * blob);
      }, (0.15 + 0.15 * p) + (0.65 + 0.25 * p) * g);
    });
    const cross = clamp01(at - 4), g = glowAt(4);   // across the front, right to left
    line(x => mix(mul(Bc.rgb, 0.1), A.rgb, g * Math.exp(-(((x - (1 - cross)) / 0.1) ** 2) / 2)), 0.4 + 0.2 * p);
    const sway = Math.sin(lap * Math.PI * 2 - Math.PI / 2);   // left at the side-left tube, right at the side-right one
    OUTER.forEach((f, k) => beam(f, {
      pan: SIDE[k] * 10 + (22 + 12 * p) * sway, tilt: 28 - 6 * p + 6 * Math.sin(t * 0.1 + k),
      color: Bc.wheel, level: 0.08 + 0.32 * p, speed: SLOW,
    }));
    INNER.forEach(dark);
  },

  // Build in reverse, over 8 bars: the tubes drain from top to bottom, the sides first, the front line closes to
  // the centre, and the beams sink towards the crowd as they fade. Once drained, the floor glow breathes gently
  // and flickers softly on live snare/rimshots instead of freezing static.
  collapse({ t, since, A, B: Bc }) {
    const p = clamp01(since / (COLLAPSE_BARS * 4));
    const col = mix(A.rgb, Bc.rgb, p);
    const D = show.drums;
    const rim = D.live ? Math.exp(-(t - D.snare) * 7) : 0;
    V.forEach((f, k) => {
      const back = isBack(k), q = back ? clamp01((p - 0.15) / 0.85) : clamp01(p / 0.85);
      const breathe = back ? 0.06 + 0.05 * Math.sin(t * 0.7 + k * 1.4) + 0.18 * rim : 0;
      const top = Math.max(breathe, 1 - 0.96 * q);
      const lv = back ? Math.max(0.22 + 0.09 * Math.sin(t * 0.65 + k) + 0.45 * rim, 1 - 0.7 * q) : 1 - q;
      paint(f, u => {
        const base = mul(col, 1 - smooth(top, top + 0.06, u));
        return back && rim > 0.05 && q > 0.6 ? mix(base, mix(Bc.rgb, WHITE, 0.35), rim * 0.55 * (1 - smooth(0, 0.28, u))) : base;
      }, lv);
    });
    const open = 1 - p;
    line(x => mul(col, 1 - smooth(open, open + 0.06, Math.abs(x - 0.5) * 2)), 0.6 * open);
    B.forEach((f, k) => {
      if (p >= 1) return dark(f);
      beam(f, { pan: SIDE[k] * (8 + 36 * p), tilt: 6 + 32 * p, color: A.wheel, level: 0.9 * open ** 1.5, speed: SLOW });
    });
  },
};

// id, label, key, the row it sits in on the desk, and what it's for
export const SCENE_LIST = [
  ['ambient', 'Ambient', '1', 'Calm', 'Clean intro: a low glow behind the band, beams barely there'],
  ['sweep', 'Sweep', '2', 'Calm', 'Melodic lead: colour climbs the tubes, a pool follows the beams'],
  ['silhouette', 'Silhouette', 'e', 'Calm', 'The band in black against the white back tubes, as long as you hold it'],
  ['searchlight', 'Searchlight', 'a', 'Calm', 'The beams lead, crossing slowly; tubes almost off'],
  ['orbit', 'Orbit', 'z', 'Calm', 'Hypnotic loops: one light circles the rig, a lap every 4 bars'],
  ['build', 'Build', '3', 'Rise & fall', 'Rises over 16 bars and peaks in a strobe: start it 16 bars before the hit'],
  ['shimmer', 'Shimmer', 'w', 'Rise & fall', 'Tremolo: a fine, fast texture growing over 28 bars, then holding'],
  ['collapse', 'Collapse', 's', 'Rise & fall', 'Drains from top to bottom over 8 bars, down to a low glow'],
  ['embers', 'Embers', '8', 'Rise & fall', 'Outro: embers drifting at the foot of the tubes, beams out'],
  ['drive', 'Drive', 'x', 'Heavy', 'Riffs and grooves: heavy colour rolling up the tubes, soft thumps on kick and snare'],
  ['surge', 'Surge', 'c', 'Heavy', 'Fast thrash: crests of light rising up the tubes, beams fanned wide, no flashing'],
  ['glint', 'Glint', 'f', 'Heavy', 'Shred solos: tubes glitter in the song colour, beams crossed high'],
  ['slab', 'Slab', 'q', 'Heavy', 'Big slow chords: solid colour swelling every 2 bars, no flicker'],
  ['backlight', 'Backlight', 'k', 'Heavy', 'The band in black against the PARs behind the kit: tubes dark, beams in a still fan'],
  ['fan', 'Fan', 'l', 'Heavy', 'The four beams open into a wide fan and close again every 4 bars; tubes almost off'],
  ['riff', 'Riff', '4', 'Heavy', 'Back and side tubes trade beats, white on every downbeat'],
  ['blast', 'Blast', '5', 'Heavy', 'Blast beats: white sparks on sixteenths, beams whipping every beat'],
  ['breakdown', 'Breakdown', '6', 'Heavy', 'Half-time slams: everything hits, the back tubes ring on'],
  ['wall', 'Wall', '7', 'Heavy', 'The climax and the one full reveal of the band, with the prism'],
  ['strobe', 'Strobe', '9', 'Cut', 'Everything strobing white, fast'],
  ['blackout', 'Blackout', '0', 'Cut', 'Everything dark; the heads hold their position'],
];

// The looks that come in more than one version, and what each is called. A cue picks one; picked by hand, a look
// is always its first.
export const VARIANTS = {
  drive: ['Low on the back', 'Split', 'Bands'],
  surge: ['Rising', 'Falling', 'From the middle'],
  slab: ['Low', 'Crown', 'Gate'],
};

// The looks that step on the drummer's own kicks and snares when the mixer hears them (and on a clock when not).
export const DRUM_LOOKS = new Set(['riff', 'blast', 'breakdown', 'wall', 'drive', 'backlight']);

// Switch to a look, cutting, or fading in from the one that's on over `fade` seconds.
export function cue(id, t, fade = 0, variant = 0) {
  show.from = fade > 0 ? { scene: show.scene, cueT: show.cueT, a: lastA, b: lastB, variant: show.variant, p: show.cueP } : null;
  show.fromT = t; show.fromLen = fade;
  washFrom = fade > 0 ? { level: wash.level, rgb: [...wash.rgb], amber: wash.amber, uv: wash.uv } : null;
  show.scene = id;
  show.variant = VARIANTS[id]?.[variant] ? variant : 0;
  show.cueT = t;
}

export function hit(t, v = 1) { show.hitT = t; show.hitV = v; }
export function beamHit(t, v = 1) { show.beamHitT = t; show.beamHitV = v; }
export function tubeHit(t, v = 1) { show.tubeHitT = t; show.tubeHitV = v; }
// the soft accents the band sets off live: they lift what's already there instead of flashing white
export function bloom(t, v = 1) { show.bloomT = t; show.bloomV = v; }
export function beamSwell(t, v = 1) { show.swellT = t; show.swellV = v; }

// 0–1 through a look that takes a set number of bars, for the UI; 0 for the rest
const TIMED = { build: BUILD_BARS, shimmer: SHIMMER_BARS, collapse: COLLAPSE_BARS };
export const lookProgress = t => (TIMED[show.scene] ? clamp01(((t - show.cueT) * show.bpm / 60) / (TIMED[show.scene] * 4)) : 0);

const px = [0, 0, 0];
let lastA = 'Red', lastB = 'Blue';   // the colours on screen, for a fade to start from

// A fade runs the old look first and keeps what it painted, then the new look, then mixes the two: tube
// colour (with its dimmer folded in) and head brightness, pan/tilt, colour wheel and prism.
// Mechanical heads hold their old colour/position while dimming to dark, pre-position while still dark,
// and swap colour at the fade midpoint instead of spinning the wheel at full brightness at k = 0.
const beforeBars = new Map(BARS.map(f => [f, new Float32Array(f.n * 3)]));
const beforeHeads = new Map(B.map(f => [f, { lv: 0, pan: 0, tilt: 0, col: 0, prism: 0 }]));
function keep() {
  for (const f of BARS) {
    const m = beforeBars.get(f), lv = f.getLevel();
    for (let i = 0; i < f.n; i++) { f.getZone(i, px); m[i * 3] = px[0] * lv; m[i * 3 + 1] = px[1] * lv; m[i * 3 + 2] = px[2] * lv; }
  }
  for (const f of B) {
    const h = beforeHeads.get(f);
    const [pan, tilt] = f.angles();
    h.lv = f.get('Shutter') <= 10 ? 0 : f.getLevel();
    h.pan = pan; h.tilt = tilt;
    h.col = f.get('Colour'); h.prism = f.get('Prism');
  }
}
function blend(k) {
  for (const f of BARS) {
    const m = beforeBars.get(f), lv = f.getLevel();
    for (let i = 0; i < f.n; i++) {
      f.getZone(i, px);
      f.setZone(i, m[i * 3] + (px[0] * lv - m[i * 3]) * k, m[i * 3 + 1] + (px[1] * lv - m[i * 3 + 1]) * k, m[i * 3 + 2] + (px[2] * lv - m[i * 3 + 2]) * k);
    }
    f.level(1);
  }
  for (const f of B) {
    const h = beforeHeads.get(f);
    const now = f.get('Shutter') <= 10 ? 0 : f.getLevel(), v = h.lv + (now - h.lv) * k;
    if (v > 0.02 && now === 0) {   // dimming out: hold old aim, colour and prism all the way down
      f.aim(h.pan, h.tilt);
      f.set('Colour', h.col);
      f.set('Prism', h.prism);
      f.strobe(0);
    } else if (h.lv > 0.02 && now > 0) {   // lit on both sides
      const [np, nt] = f.angles();
      if (Math.abs(np - h.pan) > 45 || Math.abs(nt - h.tilt) > 30) {
        // a big move doesn't sweep across the stage lit: out on the old aim, across in the dark (MOVE_S, as much of
        // it as the fade allows), in on the new
        const darkK = Math.min(0.8, Math.max(0.4, MOVE_S / Math.max(show.fromLen, 0.01))), k0 = (1 - darkK) / 2, k1 = k0 + darkK;
        const gone = k >= k0;
        if (!gone) { f.aim(h.pan, h.tilt); f.set('Colour', h.col); f.set('Prism', h.prism); }
        f.set('P/T speed', gone ? 0 : SLOW);
        f.level(h.lv * (1 - smooth(0, k0, k)) + now * smooth(k1, 1, k));
        if (gone && k < k1) dark(f);
        continue;
      }
      // a small one glides, and the mechanical wheel swaps at the midpoint
      aim(f, h.pan + (np - h.pan) * k, h.tilt + (nt - h.tilt) * k);
      f.set('P/T speed', SLOW);
      if (k < 0.5) { f.set('Colour', h.col); f.set('Prism', h.prism); }
    }
    f.level(v);
  }
}

// Energy shaping: the looks that hold steady for a whole section breathe with the recording instead, dimming and
// lighting less of the tubes when the music drops below the loudest moment of the cue. Looks with an arc of their
// own (Build, Shimmer, Collapse) and the cuts and holds are left alone.
const SHAPED = new Set(['ambient', 'sweep', 'searchlight', 'orbit', 'embers', 'riff', 'slab', 'blast', 'breakdown', 'wall', 'drive', 'surge', 'glint', 'backlight', 'fan']);
function shape(e) {
  const top = 0.55 + 0.45 * e;   // how far up the tubes stay lit
  for (const f of V) {
    for (let i = 0; i < f.n; i++) {
      const cut = 1 - smooth(top, top + 0.15, (i + 0.5) / f.n);
      if (cut < 1) { f.getZone(i, px); f.setZone(i, px[0] * cut, px[1] * cut, px[2] * cut); }
    }
  }
  for (const f of BARS) f.level(f.getLevel() * (0.6 + 0.4 * e));
  for (const f of B) f.level(f.getLevel() * (0.7 + 0.3 * e));
}

// The two wash PARs sit on the floor behind the kit and shine through it towards the room: colour in the haze,
// a rim on the players, and the white of a punch. Heavy looks wash in an A/B blend (with real Amber/UV LEDs)
// for two-tone depth against the colour-A tubes, plus a subtle kick-drum rim pulse behind the kit.
const P = ['P1', 'P2'].map(id => byId[id]).filter(Boolean);
const WASH_MAX = 0.6;   // they face the audience, so only a punch and Backlight, where they are the look, go past this
const WASH = {
  backlight: [1.4, 'A'], fan: [0.18, 'B'],
  ambient: [0.15, 'B'], sweep: [0.3, 'B'], silhouette: [0, 'B'], searchlight: [0.06, 'B'], orbit: [0.12, 'B'], embers: [0.22, 'A'],
  build: [0.5, 'AB'], shimmer: [0.45, 'AB'], collapse: [0.2, 'AB'], drive: [0.55, 'AB'], surge: [0.65, 'AB'], glint: [0.4, 'B'],
  slab: [0.7, 'AB'], riff: [0.6, 'A'], blast: [0.7, 'A'], breakdown: [0.6, 'A'], wall: [1, 'A'], strobe: [0, 'A'], blackout: [0, 'A'],
};
const KICK_WASH = new Set(['drive', 'backlight', 'slab', 'riff', 'breakdown']);
const wash = { level: 0, rgb: [0, 0, 0], amber: 0, uv: 0, t: 0 };
let washFrom = null;
function washTargetColor(which, a, b) {
  const Ca = PALETTE[a], Cb = PALETTE[b];
  if (which === 'A') return { rgb: Ca.rgb, amber: Ca.amber || 0, uv: Ca.uv || 0 };
  if (which === 'B') return { rgb: Cb.rgb, amber: Cb.amber || 0, uv: Cb.uv || 0 };
  // 'AB': mostly B for depth against colour-A tubes, pulling in real Amber/UV LEDs from both colours
  return {
    rgb: mix(Cb.rgb, Ca.rgb, 0.35),
    amber: Math.max((Cb.amber || 0) * 0.75, (Ca.amber || 0) * 0.55),
    uv: Math.max((Cb.uv || 0) * 0.85, (Ca.uv || 0) * 0.5),
  };
}
function washPars(t, a, b, fadeK) {
  const [lv, which] = WASH[show.scene] || [0, 'A'];
  const C = washTargetColor(which, a, b);
  const prog = SHAPED.has(show.scene) ? (0.68 + 0.38 * clamp01(show.cueP)) : 1;
  const target = Math.min(1, lv * WASH_MAX * prog) * (SHAPED.has(show.scene) ? 0.6 + 0.4 * show.energy : 1);
  if (fadeK !== null && washFrom) {
    // Follow the cue's real fade curve (so 5-bar fadeouts don't die in 1 second)
    wash.level = washFrom.level + (target - washFrom.level) * fadeK;
    for (let i = 0; i < 3; i++) wash.rgb[i] = washFrom.rgb[i] + (C.rgb[i] - washFrom.rgb[i]) * fadeK;
    wash.amber = washFrom.amber + (C.amber - washFrom.amber) * fadeK;
    wash.uv = washFrom.uv + (C.uv - washFrom.uv) * fadeK;
  } else if (show.scene === 'blackout') {
    // Hard blackout cut: go dark immediately with the tubes and beams
    washFrom = null;
    wash.level = 0;
  } else {
    washFrom = null;
    const k = 1 - Math.exp(-Math.min(0.2, Math.max(0, t - wash.t)) / 0.35);
    wash.level += (target - wash.level) * k;
    for (let i = 0; i < 3; i++) wash.rgb[i] += (C.rgb[i] - wash.rgb[i]) * k;
    wash.amber += (C.amber - wash.amber) * k;
    wash.uv += (C.uv - wash.uv) * k;
  }
  wash.t = t;
  const D = show.drums;
  const kickPulse = D.live && KICK_WASH.has(show.scene) && wash.level > 0.02
    ? 0.22 * Math.exp(-(t - D.kick) * 6) : 0;
  P.forEach((f, idx) => {
    const breathe = wash.level > 0.05 ? 1 + 0.06 * Math.sin(t * 0.55 + idx * Math.PI) : 1;
    f.emit(wash.rgb[0], wash.rgb[1], wash.rgb[2], wash.amber * 255, wash.uv * 255);
    f.level(Math.min(show.scene === 'backlight' ? 1 : WASH_MAX + 0.18, wash.level * breathe + kickPulse));
    f.strobe(0);
  });
}

// Lead: the beams on the soloist's side stay up, the others drop back. 'trade' swaps sides every 2 bars,
// for two guitars answering each other.
function leadBeams(side) {
  B.forEach((f, k) => {
    if ((SIDE[k] < 0) === (side === 'left')) {
      if (f.get('Shutter') <= 10) f.strobe(0);
      f.level(Math.max(f.getLevel(), 0.6));
    } else f.level(f.getLevel() * 0.3);
  });
}

export function updateShow(t) {
  const beat = (t - show.beat0) * show.bpm / 60;
  const since = (t - show.cueT) * show.bpm / 60;
  // Soundcheck helper: hold all 4 heads upright on one colour wheel slot, everything else dark.
  if (show.wheelTest) {
    BARS.forEach(f => paint(f, () => BLACK, 0));
    P.forEach(f => { f.level(0); f.strobe(0); });
    B.forEach((f, k) => {
      f.aim(SIDE[k] * 14, 18);
      f.set('Colour', show.wheelTest.dmx);
      f.level(0.65); f.strobe(0); f.prism(false);
      f.set('P/T speed', SLOW); f.set('Gobo', 0); f.set('Function', 0);
    });
    for (const f of B) f.level(f.getLevel() * show.beams);
    if (show.master < 1) for (const f of fixtures) f.level(f.getLevel() * show.master);
    for (const f of fixtures) f.commit(t);
    return beat;
  }
  const [a, b] = show.swap ? [show.colorB, show.colorA] : [show.colorA, show.colorB];
  const fading = show.from && t - show.fromT < show.fromLen;
  const fadeK = fading ? smooth(0, 1, (t - show.fromT) / show.fromLen) : null;
  const p = clamp01(show.cueP);
  if (fading) {
    const o = show.from;
    SCENES[o.scene]({ t, beat, p: o.p ?? 1, since: (t - o.cueT) * show.bpm / 60, A: PALETTE[o.a], B: PALETTE[o.b], v: o.variant });
    keep();
  } else show.from = null;
  SCENES[show.scene]({ t, beat, p, since, A: PALETTE[a], B: PALETTE[b], v: show.variant });
  if (fading) blend(fadeK);
  lastA = a; lastB = b;
  // Move in Black ("Mark"): while dark on a blackout cue (and after any blackout punch has died), silently
  // pre-position the closed heads' pan/tilt, colour wheel and prism for the upcoming cue at quiet SLOW speed.
  const slam = (at, v) => Math.exp(-(t - at) * 6) * v;
  const h = slam(show.hitT, show.hitV);
  const ht = Math.max(h, slam(show.tubeHitT, show.tubeHitV)), hb = Math.max(h, slam(show.beamHitT, show.beamHitV));
  if (show.scene === 'blackout' && !fading && !show.flash && hb <= 0.02 && show.mark && SCENES[show.mark.scene]) {
    const m = show.mark;
    SCENES[m.scene]({ t, beat: 0, p: 0, since: 0, A: PALETTE[m.a] || PALETTE.Red, B: PALETTE[m.b] || PALETTE.Blue, v: m.variant || 0 });
    BARS.forEach(f => paint(f, () => BLACK, 0));
    B.forEach(f => { f.set('P/T speed', SLOW); dark(f); });
  }
  if (show.energy < 0.999 && SHAPED.has(show.scene)) shape(show.energy);
  if (show.lead && SHAPED.has(show.scene)) leadBeams(show.lead === 'trade' ? (Math.floor(beat / 8) % 2 ? 'right' : 'left') : show.lead);
  if (P.length) washPars(t, a, b, fadeK);

  // Sustained lead guitar boost (Cyril, stage left): lifts his side's beams & tube organically during distorted solos
  const gb = show.guitarBoost;
  if (gb > 0.02 && show.scene !== 'blackout' && show.scene !== 'strobe') {
    B.forEach((f, k) => {
      if (SIDE[k] < 0 && f.get('Shutter') > 10) f.level(Math.min(1, f.getLevel() + 0.28 * gb));
    });
    if (V[0]) V[0].level(Math.min(1, V[0].getLevel() + 0.18 * gb));
  }

  // soft accents: the tubes swell in their own colour for about a second, the beams lift. Nothing turns white.
  const bl = Math.exp(-(t - show.bloomT) * 2.2) * show.bloomV;
  if (bl > 0.02) {
    const g = 1 + 0.9 * bl;
    for (const f of V) {
      for (let i = 0; i < f.n; i++) { f.getZone(i, px); f.setZone(i, Math.min(255, px[0] * g), Math.min(255, px[1] * g), Math.min(255, px[2] * g)); }
      f.level(Math.min(1, f.getLevel() + 0.3 * bl));
    }
    for (const f of P) f.level(Math.max(f.getLevel(), Math.min(WASH_MAX, f.getLevel() + 0.15 * bl)));
  }
  const sw = Math.max(0.5 * bl, Math.exp(-(t - show.swellT) * 1.6) * show.swellV);
  if (sw > 0.02) for (const f of B) if (f.get('Shutter') > 10) f.level(Math.min(1, f.getLevel() + 0.45 * sw));

  // one-shot accents on top of any look: a white slam on LEDs (tubes + PARs) that dies in half a second.
  // Moving heads punch to full dimmer in the cue's own wheel colour so the mechanical wheel doesn't flash rainbows;
  // only blackout/strobe punches switch the wheel to White.
  if (ht > 0.02) {
    for (const f of BARS) {
      for (let i = 0; i < f.n; i++) f.setZone(i, ...mix(f.getZone(i, px), WHITE, ht));
      f.level(Math.max(f.getLevel(), ht));
    }
    for (const f of P) {   // the PARs go white with the slam
      const c = mix(wash.rgb, WHITE, ht);
      f.emit(c[0], c[1], c[2], wash.amber * 255 * (1 - ht), wash.uv * 255 * (1 - ht));
      f.level(Math.max(f.getLevel(), ht));
    }
  }
  if (hb > 0.02) {
    const forceWhite = show.scene === 'blackout' || show.scene === 'strobe';
    for (const f of B) {
      f.level(Math.max(f.getLevel(), hb));
      if (f.get('Shutter') <= 10) f.strobe(0);   // a dark head has to open up for the hit
      if (forceWhite) f.colour('White');
    }
  }

  if (show.flash) {
    BARS.forEach(f => paint(f, () => WHITE, 1, 0.88));
    B.forEach(f => { f.colour('White'); f.level(1); f.strobe(0.88); });
    P.forEach(f => { f.emit(255, 255, 255); f.level(1); f.strobe(0.88); });
  }
  if (show.choke || show.autoChoke) {   // heads keep their position, like Blackout
    BARS.forEach(f => f.level(0));
    B.forEach(dark);
    P.forEach(f => f.level(0));
  }
  noLitSwings(t);
  for (const f of H) f.level(f.getLevel() * FRONT_BAR_MAX);
  for (const f of B) f.level(f.getLevel() * show.beams);
  if (show.master < 1) for (const f of fixtures) f.level(f.getLevel() * show.master);
  for (const f of fixtures) f.commit(t);
  return beat;
}

// A head never swings across the stage lit. The show follows where each head physically is (at the speed it was
// last sent, like the sim draws it), and keeps it closed, moving at full speed, while it's more than 3° from
// where it's meant to be: after a cut to another look, a punch, anything that jumps the aim. Glides keep up and
// pass. Blast whips its beams on every beat on purpose, out to the sides within MAX_OUT_LEAN, so it's left alone.
const SWING_DEG = 3;
const travel = new Map(B.map(f => [f, { pan: 0, tilt: 0, speed: 0, t: null }]));
function noLitSwings(t) {
  for (const f of B) {
    const g = travel.get(f), [pan, tilt] = f.angles(), d = f.def;
    const dt = g.t === null ? 0 : Math.min(0.5, Math.max(0, t - g.t)), k = d.speedFactor(g.speed);
    if (g.t === null) { g.pan = pan; g.tilt = tilt; }
    const step = (x, to, rate) => x + Math.max(-rate * dt, Math.min(rate * dt, to - x));
    g.pan = step(g.pan, pan, (d.panRange / d.panTime) * k);
    g.tilt = step(g.tilt, tilt, (d.tiltRange / d.tiltTime) * k);
    g.t = t;
    if (Math.max(Math.abs(pan - g.pan), Math.abs(tilt - g.tilt)) > SWING_DEG && !(show.scene === 'blast' && !show.from)) {
      dark(f); f.set('P/T speed', 0);
    }
    g.speed = f.get('P/T speed');
  }
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
