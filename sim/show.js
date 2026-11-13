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
  Amber: { rgb: [255, 70, 0], wheel: 'Orange' },
  White: { rgb: [255, 246, 236], wheel: 'White' },
  Ice: { rgb: [140, 195, 255], wheel: 'Light blue' },
  Teal: { rgb: [0, 170, 190], wheel: 'Cyan' },
  Blue: { rgb: [0, 24, 255], wheel: 'Blue' },
  UV: { rgb: [60, 0, 255], wheel: 'UV' },
  Green: { rgb: [40, 255, 16], wheel: 'Green' },
};

export const BUILD_BARS = 16;
const SHIMMER_BARS = 32;
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
  lead: '',          // '', 'left', 'right' or 'trade': whose beam carries the lead guitar (as the audience sees it)
  from: null,        // the look we're fading out of: { scene, cueT, a, b }
  fromT: 0, fromLen: 0,
  // Set by live.js from the mixer: the drummer's strokes (show time), the band's level, and dead stops.
  drums: { live: false, kick: -10, snare: -10, crash: -10, hit: -10, kickN: 0, snareN: 0, crashN: 0, hitN: 0, lastKickOrSnare: -10 },
  liveEnergy: null,  // 0–1 like `energy`, from the band's level; null when there's no mixer
  cueLandT: 0,
  autoChoke: false,  // the band stopped dead: dark like Choke until the next hit
  bloomT: -10, bloomV: 0,   // a live crash: the tubes swell in their own colour (no white flash)
  swellT: -10, swellV: 0,   // a live guitar jump: the beams lift
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
function beam(f, { pan, tilt, color = 'White', level = 1, prism = false, strobe = 0, speed = 0 }) {
  // the inner pair stands nearer the middle: it leans out less and stays more upright, so the four make a fan
  if (pan !== undefined) isInner.has(f) ? f.aim(pan * 0.45, tilt * 0.8) : f.aim(pan, tilt);
  f.colour(color); f.level(level); f.strobe(strobe); f.prism(prism);
  f.set('P/T speed', speed); f.set('Gobo', 0); f.set('Function', 0);
}
// A head goes black with its dimmer and shutter; pan and tilt stay where they are.
const dark = f => { f.level(0); f.set('Shutter', 0); };
const isBack = k => k === 1 || k === 2;   // V2 and V3 stand at the back, V1 and V4 at the sides
// paint the two front bars as one line, x = 0 (audience's left) to 1 (right)
const line = (fn, level = 1, strobe = 0) => H.forEach((f, k) => paint(f, u => fn((k + u) / 2), level, strobe));

// beam positions the heavy looks jump between (always moved while dark)
const POSITIONS = [
  k => ({ pan: SIDE[k] * 12, tilt: 8 }),    // straight up, tight fan
  k => ({ pan: SIDE[k] * 16, tilt: 45 }),   // out over the crowd, as low as the limit allows
  k => ({ pan: -SIDE[k] * 30, tilt: 38 }),  // crossing over the middle
  k => ({ pan: SIDE[k] * 55, tilt: 42 }),   // wide out to the walls
];

// where Drive's beams rest, 8 bars each: crossed, out to the walls, over the crowd, straight up
const DRIVE_POSITIONS = [POSITIONS[2], POSITIONS[3], POSITIONS[1], POSITIONS[0]];

// The rig has depth, and the looks use it: the back pair and the side pair answer each other. The front bars
// are the only light on the band's faces, so they stay low until a look means to reveal the band, and their
// zones make one line across the stage. No look relies on them: they aren't built yet, and the rest stands alone.
const SCENES = {
  // Clean intro or interlude: a low glow rising behind the band, fainter at the sides, the band in near-darkness.
  // The beams stand almost still, just visible.
  ambient({ t, B: Bc }) {
    V.forEach((f, k) => {
      const back = isBack(k);
      const h = (back ? 0.45 : 0.25) + (back ? 0.18 : 0.1) * Math.sin(t * 0.21 + k * 1.7);
      paint(f, u => mul(Bc.rgb, smooth(h, h - 0.45, u) * (0.8 + 0.2 * Math.sin(t * 0.8 + u * 10 + k))), back ? 0.7 : 0.45);
    });
    line(x => mul(Bc.rgb, 0.25 + 0.15 * Math.sin(t * 0.3 + x * 6)), 0.2);
    OUTER.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (14 + 4 * Math.sin(t * 0.09 + k)),
      tilt: 12 + 5 * Math.sin(t * 0.11 + k * 2),
      color: Bc.wheel, level: 0.15, speed: SLOW,
    }));
    INNER.forEach(dark);
  },

  // Melodic lead: soft blobs of colour climb the back pair, then the side pair half a cycle later, so the
  // eye travels front to back. A pool of colour follows the beams along the front line as they sweep together.
  sweep({ beat, A, B: Bc }) {
    V.forEach((f, k) => {
      const pos = frac(beat / 8 + (isBack(k) ? 0 : 0.5) + (k < 2 ? 0 : 0.06)) * 1.3 - 0.15;
      paint(f, u => mix(mul(Bc.rgb, 0.25), A.rgb, Math.exp(-(((u - pos) / 0.06) ** 2) / 2)), 0.7);
    });
    const swing = Math.sin(beat * Math.PI / 8), pool = 0.5 + 0.5 * swing;
    line(x => mix(mul(Bc.rgb, 0.12), A.rgb, Math.exp(-(((x - pool) / 0.14) ** 2) / 2)), 0.6);
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * 10 + 38 * swing,
      tilt: 34 + 10 * Math.sin(beat * Math.PI / 16),
      color: 'White', level: 0.75, speed: SLOW,
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
  // everything white. The front line chugs on eighths. The beams stay out of the way until they count: both
  // on the downbeat, one on beat 3, changing side every bar.
  riff({ t, beat, A, B: Bc }) {
    const D = show.drums;
    if (D.live) {   // the drummer is the clock: kicks hit the back pair, snares the sides, a crash turns it all white
      const ek = Math.exp(-(t - D.kick) * 6), es = Math.exp(-(t - D.snare) * 6), ec = Math.exp(-(t - D.crash) * 4);
      const crash = ec > 0.3, any = Math.exp(-(t - D.hit) * 8);
      V.forEach((f, k) => {
        const h = Math.max(isBack(k) ? ek : es, ec);
        paint(f, () => mix(mul(Bc.rgb, 0.06), crash ? WHITE : A.rgb, 0.12 + 0.88 * h));
      });
      line(() => mul(A.rgb, 0.15 + 0.85 * any));
      B.forEach((f, k) => beam(f, {
        pan: SIDE[k] * 30, tilt: 38, color: crash ? 'White' : A.wheel,
        level: Math.max(ec, D.snareN % 2 === k ? es * 0.8 : 0),   // one beam per snare, changing side each time
      }));
      return;
    }
    const n = Math.floor(beat), e = Math.exp(-frac(beat) * 6), e8 = Math.exp(-frac(beat * 2) * 8);
    const down = n % 4 === 0, three = n % 4 === 2, bar = Math.floor(n / 4);
    V.forEach((f, k) => {
      const hit = down || (n % 2 === 0) === isBack(k) ? e : 0;
      paint(f, () => mix(mul(Bc.rgb, 0.06), down ? WHITE : A.rgb, 0.12 + 0.88 * hit));
    });
    line(() => mul(A.rgb, 0.15 + 0.85 * e8));
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * 30, tilt: 38,
      color: down ? 'White' : A.wheel,
      level: down || (three && bar % 2 === k) ? e : 0,
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
    const pos = POSITIONS[(ph < 0.4 ? h : h + 1) % POSITIONS.length];
    B.forEach((f, k) => beam(f, { ...pos(k), color: h % 4 === 0 ? 'White' : A.wheel, level: e }));
  },

  // Wall of sound / climax, and the one place the band is fully revealed: tubes full, white crowns reaching
  // lower on the back pair, all swelling every bar with the white front line. The beams fan up through
  // the haze with the 6-facet prism turning slowly, which no other look uses.
  wall({ t, beat, A }) {
    const D = show.drums;   // live, it swells on the crashes rather than every bar
    const swell = 0.78 + 0.22 * (D.live ? Math.exp(-(t - D.crash) * 1.1) : Math.exp(-frac(beat / 4) * 2.5));
    V.forEach((f, k) => {
      const crown = isBack(k) ? 0.68 : 0.78;
      paint(f, u => mix(A.rgb, WHITE, smooth(crown, crown + 0.08, u)), swell);
    });
    line(() => WHITE, swell);
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (20 + 5 * Math.sin(t * 0.3 + k)),
      tilt: 18 + 8 * Math.sin(t * 0.4 + k),
      color: 'White', prism: 'spin', speed: SLOW,
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

  // Slow, heavy chords: solid colour that swells every two bars and never flickers. The weight sits low on the
  // back pair, the sides stay darker and lean towards B, and the beams hang out over the crowd, breathing with it.
  slab({ t, beat, A, B: Bc }) {
    const ph = frac(beat / 8);
    const swell = smooth(0, 0.08, ph) * Math.exp(-ph * 2.5);
    const level = 0.55 + 0.45 * swell;
    V.forEach((f, k) => {
      const back = isBack(k), c = back ? A.rgb : mix(A.rgb, Bc.rgb, 0.35);
      paint(f, u => mul(c, 1 - 0.65 * u), back ? level : level * 0.6);
    });
    line(() => A.rgb, 0.3 * level);
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * 24 + 6 * Math.sin(t * 0.08 + k), tilt: 26,
      color: A.wheel, level: 0.2 + 0.5 * swell, speed: SLOW,
    }));
  },

  // Mid-tempo riffs and grooves, without the flashing: solid colour that sits low and heavy on the back pair and
  // rolls slowly up the tubes like heat. The beams hold a position in colour and glide to a new one every 8 bars.
  // Each kick is a soft thump at the foot of the back pair, each snare at the sides (live, the drummer's own).
  drive({ t, beat, A, B: Bc }) {
    const D = show.drums;
    const kick = D.live ? Math.exp(-(t - D.kick) * 5) : 0.6 * Math.exp(-frac(beat / 2) * 6);
    const snare = D.live ? Math.exp(-(t - D.snare) * 5) : 0.6 * Math.exp(-frac(beat / 2 + 0.5) * 6);
    V.forEach((f, k) => {
      const back = isBack(k), c = back ? A.rgb : mix(A.rgb, Bc.rgb, 0.45), th = back ? kick : snare;
      const lit = mix(c, WHITE, 0.3);
      paint(f, u => {
        const roll = 0.85 + 0.15 * Math.sin((u * 0.9 - beat / 8) * Math.PI * 2 + k * 0.8);
        return mix(mul(c, (1 - 0.45 * u) * roll), lit, 0.45 * th * (1 - smooth(0.15, 0.5, u)));
      }, back ? 1 : 0.75);
    });
    const pos = DRIVE_POSITIONS[Math.floor(beat / 32) % DRIVE_POSITIONS.length];
    B.forEach((f, k) => {
      const at = pos(k);
      beam(f, { pan: at.pan + 3 * Math.sin(t * 0.1 + k), tilt: at.tilt + 2 * Math.sin(t * 0.13 + k * 2), color: A.wheel, level: 0.55, speed: SLOW });
    });
  },

  // Fast thrash and double kick, as speed rather than flashing: crests of light rise up the tubes one after
  // another, about one a bar, the back pair half a step ahead of the sides. Nothing switches off between them.
  // The beams fan wide and tilt slowly against each other. It runs free, so it needs no beat to lock to.
  surge({ t, beat, A, B: Bc }) {
    const low = mix(mul(Bc.rgb, 0.45), mul(A.rgb, 0.45), 0.5), high = mix(A.rgb, WHITE, 0.4);
    V.forEach((f, k) => {
      const off = (isBack(k) ? 0 : 0.5) + (k < 2 ? 0 : 0.13);
      paint(f, u => mix(low, high, (0.5 + 0.5 * Math.sin((u * 1.4 - beat / 4 - off) * Math.PI * 2)) ** 1.6), isBack(k) ? 1 : 0.85);
    });
    B.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (36 + 10 * Math.sin(t * 0.21 + k)), tilt: 26 + 14 * Math.sin(t * 0.33 + k * Math.PI),
      color: A.wheel, level: 0.7, speed: SLOW,
    }));
  },

  // Shred solos: the tubes glitter, every chunk on its own, so the brightness holds steady, while the beams
  // cross high above the band and barely move. Tubes and beams keep the song's colour (A), so a solo in one
  // song doesn't look like a solo in the next. With a lead set, the soloist's side stays up.
  glint({ t, A, B: Bc }) {
    const dim = mul(mix(Bc.rgb, A.rgb, 0.7), 0.4), lit = mix(A.rgb, WHITE, 0.3);
    V.forEach((f, k) => paint(f, u => mix(dim, lit, twinkle(t * 0.6, Math.floor(u * 32) + k * 100) ** 1.5), isBack(k) ? 1 : 0.85));
    B.forEach((f, k) => beam(f, {
      pan: -SIDE[k] * (22 + 4 * Math.sin(t * 0.15 + k)), tilt: 22 + 5 * Math.sin(t * 0.1 + k * 2),
      color: A.wheel, level: 0.9, speed: SLOW,
    }));
  },

  // Tremolo: a fine, fast texture that grows over 32 bars and then holds. Every chunk of tube twinkles on its own,
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

  // The beams lead: the outer pair as two white shafts crossing slowly through the haze, out of step so they never
  // look mirrored. The inner pair stays dark.
  // The tubes are down to a faint glow at their feet, the front line is off. Runs on seconds, like Ambient.
  searchlight({ t, B: Bc }) {
    V.forEach((f, k) => paint(f, u => mul(Bc.rgb, 1 - smooth(0, 0.25, u)), isBack(k) ? 0.12 : 0.06));
    line(() => BLACK, 0);
    OUTER.forEach((f, k) => beam(f, {
      pan: SIDE[k] * (8 - 38 * (0.5 + 0.5 * Math.sin(t * 0.13 + k * 0.7))),
      tilt: 28 + 10 * Math.sin(t * 0.07 + k * 2),
      color: 'White', speed: SLOW,
    }));
    INNER.forEach(dark);
  },

  // Hypnotic loops: one light circles the rig, a lap every 4 bars, like a planet round its star. It goes side-left →
  // back-left → back-right → side-right, then back across the front line, with a fading trail behind it. The rest
  // keeps a faint glow of B at its feet, and the beams sway gently towards wherever the light is.
  orbit({ t, beat, A, B: Bc }) {
    const stops = H.length ? 5 : 4;              // the four tubes, then the front line if there is one
    const lap = frac(beat / 16), at = lap * stops;
    const glowAt = k => { const d = frac((at - k) / stops); return Math.min(1, Math.exp(-d * stops * 1.1) + Math.exp(-(1 - d) * stops * 6)); };
    V.forEach((f, k) => {
      const g = glowAt(k), h = 0.5 + 0.15 * Math.sin(t * 0.3 + k * 1.3);
      // the light is a tall soft blob with a white-hot core; the trail behind it is just the blob fading
      paint(f, u => {
        const blob = Math.exp(-(((u - h) / 0.22) ** 2) / 2);
        return mix(mul(Bc.rgb, 0.18 * (1 - smooth(0, 0.4, u))), mix(A.rgb, WHITE, 0.35 * g * blob ** 4), g * blob);
      }, 0.2 + 0.8 * g);
    });
    const cross = clamp01(at - 4), g = glowAt(4);   // across the front, right to left
    line(x => mix(mul(Bc.rgb, 0.1), A.rgb, g * Math.exp(-(((x - (1 - cross)) / 0.1) ** 2) / 2)), 0.5);
    const sway = Math.sin(lap * Math.PI * 2 - Math.PI / 2);   // left at the side-left tube, right at the side-right one
    OUTER.forEach((f, k) => beam(f, {
      pan: SIDE[k] * 10 + 28 * sway, tilt: 26 + 6 * Math.sin(t * 0.1 + k),
      color: Bc.wheel, level: 0.12, speed: SLOW,
    }));
    INNER.forEach(dark);
  },

  // Build in reverse, over 8 bars: the tubes drain from top to bottom, the sides first, the front line closes to
  // the centre, and the beams sink towards the crowd as they fade. It ends on a low glow at the foot of the back pair.
  collapse({ since, A, B: Bc }) {
    const p = clamp01(since / (COLLAPSE_BARS * 4));
    const col = mix(A.rgb, Bc.rgb, p);
    V.forEach((f, k) => {
      const back = isBack(k), q = back ? clamp01((p - 0.15) / 0.85) : clamp01(p / 0.85);
      const top = 1 - 0.96 * q;
      paint(f, u => mul(col, 1 - smooth(top, top + 0.04, u)), back ? 1 - 0.7 * q : 1 - q);
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
  ['shimmer', 'Shimmer', 'w', 'Rise & fall', 'Tremolo: a fine, fast texture growing over 32 bars, then holding'],
  ['collapse', 'Collapse', 's', 'Rise & fall', 'Drains from top to bottom over 8 bars, down to a low glow'],
  ['embers', 'Embers', '8', 'Rise & fall', 'Outro: embers drifting at the foot of the tubes, beams out'],
  ['drive', 'Drive', 'x', 'Heavy', 'Riffs and grooves: heavy colour rolling up the tubes, soft thumps on kick and snare'],
  ['surge', 'Surge', 'c', 'Heavy', 'Fast thrash: crests of light rising up the tubes, beams fanned wide, no flashing'],
  ['glint', 'Glint', 'f', 'Heavy', 'Shred solos: tubes glitter in the song colour, beams crossed high'],
  ['slab', 'Slab', 'q', 'Heavy', 'Big slow chords: solid colour swelling every 2 bars, no flicker'],
  ['riff', 'Riff', '4', 'Heavy', 'Back and side tubes trade beats, white on every downbeat'],
  ['blast', 'Blast', '5', 'Heavy', 'Blast beats: white sparks on sixteenths, beams whipping every beat'],
  ['breakdown', 'Breakdown', '6', 'Heavy', 'Half-time slams: everything hits, the back tubes ring on'],
  ['wall', 'Wall', '7', 'Heavy', 'The climax and the one full reveal of the band, with the prism'],
  ['strobe', 'Strobe', '9', 'Cut', 'Everything strobing white, fast'],
  ['blackout', 'Blackout', '0', 'Cut', 'Everything dark; the heads hold their position'],
];

// Switch to a look, cutting, or fading in from the one that's on over `fade` seconds.
export function cue(id, t, fade = 0) {
  show.from = fade > 0 ? { scene: show.scene, cueT: show.cueT, a: lastA, b: lastB } : null;
  show.fromT = t; show.fromLen = fade;
  show.scene = id;
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
// colour (with its dimmer folded in) and head brightness. The heads already aim and colour for the new look.
const before = new Map([...BARS, ...B].map(f => [f, new Float32Array(BARS.includes(f) ? f.n * 3 : 1)]));
function keep() {
  for (const f of BARS) {
    const m = before.get(f), lv = f.getLevel();
    for (let i = 0; i < f.n; i++) { f.getZone(i, px); m[i * 3] = px[0] * lv; m[i * 3 + 1] = px[1] * lv; m[i * 3 + 2] = px[2] * lv; }
  }
  for (const f of B) before.get(f)[0] = f.get('Shutter') <= 10 ? 0 : f.getLevel();
}
function blend(k) {
  for (const f of BARS) {
    const m = before.get(f), lv = f.getLevel();
    for (let i = 0; i < f.n; i++) {
      f.getZone(i, px);
      f.setZone(i, m[i * 3] + (px[0] * lv - m[i * 3]) * k, m[i * 3 + 1] + (px[1] * lv - m[i * 3 + 1]) * k, m[i * 3 + 2] + (px[2] * lv - m[i * 3 + 2]) * k);
    }
    f.level(1);
  }
  for (const f of B) {
    const now = f.get('Shutter') <= 10 ? 0 : f.getLevel(), v = before.get(f)[0] + (now - before.get(f)[0]) * k;
    if (v > 0.02 && now === 0) f.strobe(0);   // a head the new look darkened stays open while it fades
    f.level(v);
  }
}

// Energy shaping: the looks that hold steady for a whole section breathe with the recording instead, dimming and
// lighting less of the tubes when the music drops below the loudest moment of the cue. Looks with an arc of their
// own (Build, Shimmer, Collapse) and the cuts and holds are left alone.
const SHAPED = new Set(['ambient', 'sweep', 'searchlight', 'orbit', 'embers', 'riff', 'slab', 'blast', 'breakdown', 'wall', 'drive', 'surge', 'glint']);
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
  const [a, b] = show.swap ? [show.colorB, show.colorA] : [show.colorA, show.colorB];
  const fading = show.from && t - show.fromT < show.fromLen;
  if (fading) {
    const o = show.from;
    SCENES[o.scene]({ t, beat, since: (t - o.cueT) * show.bpm / 60, A: PALETTE[o.a], B: PALETTE[o.b] });
    keep();
  } else show.from = null;
  SCENES[show.scene]({ t, beat, since, A: PALETTE[a], B: PALETTE[b] });
  if (fading) blend(smooth(0, 1, (t - show.fromT) / show.fromLen));
  lastA = a; lastB = b;
  if (show.energy < 0.999 && SHAPED.has(show.scene)) shape(show.energy);
  if (show.lead && SHAPED.has(show.scene)) leadBeams(show.lead === 'trade' ? (Math.floor(beat / 8) % 2 ? 'right' : 'left') : show.lead);

  // soft accents: the tubes swell in their own colour for about a second, the beams lift. Nothing turns white.
  const bl = Math.exp(-(t - show.bloomT) * 2.2) * show.bloomV;
  if (bl > 0.02) {
    const g = 1 + 0.9 * bl;
    for (const f of V) {
      for (let i = 0; i < f.n; i++) { f.getZone(i, px); f.setZone(i, Math.min(255, px[0] * g), Math.min(255, px[1] * g), Math.min(255, px[2] * g)); }
      f.level(Math.min(1, f.getLevel() + 0.3 * bl));
    }
  }
  const sw = Math.max(0.5 * bl, Math.exp(-(t - show.swellT) * 1.6) * show.swellV);
  if (sw > 0.02) for (const f of B) if (f.get('Shutter') > 10) f.level(Math.min(1, f.getLevel() + 0.45 * sw));

  // one-shot accents on top of any look: a white slam that dies in half a second, as hard as it was hit
  const slam = (at, v) => Math.exp(-(t - at) * 6) * v;
  const h = slam(show.hitT, show.hitV);
  const ht = Math.max(h, slam(show.tubeHitT, show.tubeHitV)), hb = Math.max(h, slam(show.beamHitT, show.beamHitV));
  if (ht > 0.02) {
    for (const f of BARS) {
      for (let i = 0; i < f.n; i++) f.setZone(i, ...mix(f.getZone(i, px), WHITE, ht));
      f.level(Math.max(f.getLevel(), ht));
    }
  }
  if (hb > 0.02) {
    for (const f of B) {
      f.level(Math.max(f.getLevel(), hb));
      if (f.get('Shutter') <= 10) f.strobe(0);   // a dark head has to open up for the hit
      if (hb > 0.3) f.colour('White');
    }
  }

  if (show.flash) {
    BARS.forEach(f => paint(f, () => WHITE, 1, 0.88));
    B.forEach(f => { f.colour('White'); f.level(1); f.strobe(0.88); });
  }
  if (show.choke || show.autoChoke) {   // heads keep their position, like Blackout
    BARS.forEach(f => f.level(0));
    B.forEach(dark);
  }
  for (const f of H) f.level(f.getLevel() * FRONT_BAR_MAX);
  for (const f of B) f.level(f.getLevel() * show.beams);
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
