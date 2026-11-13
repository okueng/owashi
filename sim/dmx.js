// The DMX universes, the fixture personalities, and the patch that says which fixture reads which bytes.
// Everything that drives the lights (the built-in show, later Art-Net or a real desk) writes here;
// everything that draws them reads from here.

export const universes = [1, 2, 3].map(() => new Uint8Array(512));   // a fourth comes back with the front floor bars

const zones = n => Array.from({ length: n }, (_, i) => ['R', 'G', 'B', 'W'].map(c => `Z${i + 1} ${c}`)).flat();
const frac = x => x - Math.floor(x);
const hash = n => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);

// a strobe made in software, for fixtures that can't strobe themselves: rate 0 = steady, 1 = fastest
export const rateGate = (rate, t, maxHz = 20) => (rate <= 0 ? 1 : (t * (1 + rate * (maxHz - 1))) % 1 < 0.2 ? 1 : 0);

// LB150 colour wheel. The fixture files only say "Colour 1–11". Slot 1 (value 13) is a red-orange on the
// real heads; the rest of this order is a guess until someone steps through channel 8 (18, 23 … 63).
export const LB150_WHEEL = [
  ['White', [1, 1, 1]], ['Red', [1, 0.14, 0.02]], ['Orange', [1, 0.32, 0]], ['Yellow', [1, 0.78, 0]],
  ['Green', [0.08, 1, 0.12]], ['Cyan', [0, 0.8, 1]], ['Light blue', [0.5, 0.75, 1]], ['Blue', [0.04, 0.12, 1]],
  ['UV', [0.32, 0, 1]], ['Magenta', [1, 0, 0.7]], ['Pink', [1, 0.35, 0.6]], ['CTO', [1, 0.66, 0.38]],
];

export const PROFILES = {
  tube: {
    name: 'COB tube · 2 m · 64 zones RGBW (WS2814, WLED)',
    zones: 64,
    channels: zones(64),          // no dimmer or strobe: the desk mixes them into the colours
  },

  // Betopper LB150 in its 12-channel mode, from Betopper's grandMA2 fixture file.
  lb150: {
    name: 'Betopper LB150 · 12 ch',
    panRange: 540, tiltRange: 270,
    panTime: 2.5, tiltTime: 1.25,   // seconds for the full range, from the spec sheet
    // Where the show may point them, in degrees from straight out of the base. These are narrow, intense
    // beams and their mounting isn't settled, so this is the cautious default: standing on the floor, a head
    // stays at least 45° above the horizontal, whichever way it pans. Widen it only for a known mounting.
    limits: { pan: [-90, 90], tilt: [-45, 45] },
    // Tested on the real heads: at DMX pan centre they lean to the audience's right, so facing the audience
    // (pan 0 here) is 90° round from it. Pan turns the same way as here. Bases must stand the same way round.
    panZero: 90,
    channels: ['Pan', 'Pan fine', 'Tilt', 'Tilt fine', 'P/T speed', 'Dimmer', 'Shutter', 'Colour', 'Gobo', 'Prism', 'Reserved', 'Function'],
    strobeChannel: 'Shutter',
    // shutter: 0–10 closed · 11–99 strobe · 100–109 open · 110–179 pulse · 180–189 open · 190–250 random · 251–255 open
    // Open is sent as 255: the real heads gave no light at 105 in testing, though the cause wasn't isolated.
    encodeStrobe: r => (r > 0 ? 11 + Math.round(r * 88) : 255),
    gate(v, t) {
      if (v <= 10) return 0;
      if (v <= 99) return rateGate((v - 11) / 88, t, 25);
      if (v <= 109 || (v >= 180 && v <= 189) || v >= 251) return 1;
      if (v <= 179) return 1 - frac(t * (1 + ((v - 110) / 69) * 9));   // pulse: snaps on, fades out
      return hash(Math.floor(t * (4 + ((v - 190) / 60) * 16))) > 0.55 ? 1 : 0;
    },
    // colour: 0–10 white · 11–65 colours 1–11 (5 values each) · 66–191 white · 192–225 scroll CW · 226–255 scroll CCW
    encodeColour(name) {
      const i = LB150_WHEEL.findIndex(([n]) => n === name);
      return i <= 0 ? 0 : 13 + (i - 1) * 5;
    },
    decodeColour(v, t) {
      let i = 0;
      if (v >= 11 && v <= 65) i = 1 + Math.floor((v - 11) / 5);
      else if (v >= 192) {
        const dir = v <= 225 ? 1 : -1, speed = v <= 225 ? (v - 192) / 33 : (v - 226) / 29;
        i = ((Math.floor(t * (0.5 + speed * 6) * dir) % 12) + 12) % 12;
      }
      return LB150_WHEEL[Math.min(i, 11)];
    },
    // prism: 0–10 out · 11–155 in · 156–157 stop · 158–205 spin CCW · 206–207 stop · 208–255 spin CW
    encodePrism: mode => (mode === 'spin' ? 215 : mode ? 80 : 0),
    decodePrism(v) {
      if (v <= 10) return { on: false, spin: 0 };
      if (v >= 158 && v <= 205) return { on: true, spin: -(0.1 + (v - 158) / 47) };
      if (v >= 208) return { on: true, spin: 0.1 + (v - 208) / 47 };
      return { on: true, spin: 0 };
    },
    speedFactor: v => 1 - (v / 255) * 0.9,   // assumed: 0 = fastest. 200 is confirmed smooth and slow on the real heads
  },
};

export const PATCH = [
  // universe 1 — the Art-Net box, whose two DMX ports carry the same universe: B1 then B3 on DMX1, B2 then B4 on DMX2
  // left and right as the audience sees them; tag is the short name on the 3D labels
  { id: 'B1', tag: 'Beam L', label: 'Moving head, back left, outer', profile: 'lb150', universe: 1, address: 1 },
  { id: 'B2', tag: 'Beam R', label: 'Moving head, back right, outer', profile: 'lb150', universe: 1, address: 13 },
  // the second pair, either side of the banner (addresses 25 and 37 still to be set on the real heads)
  { id: 'B3', tag: 'Inner L', label: 'Moving head, back left, inner', profile: 'lb150', universe: 1, address: 25 },
  { id: 'B4', tag: 'Inner R', label: 'Moving head, back right, inner', profile: 'lb150', universe: 1, address: 37 },
  // universes 2–3 — the tubes on WLED, outputs 1–4 of the Dig-Quad: 256 channels each, two per universe
  { id: 'V1', tag: 'Side L', label: 'Tube, side left', profile: 'tube', universe: 2, address: 1 },
  { id: 'V2', tag: 'Back L', label: 'Tube, back left', profile: 'tube', universe: 2, address: 257 },
  { id: 'V3', tag: 'Back R', label: 'Tube, back right', profile: 'tube', universe: 3, address: 1 },
  { id: 'V4', tag: 'Side R', label: 'Tube, side right', profile: 'tube', universe: 3, address: 257 },
  // The two horizontal floor bars at the stage front (H1, H2) were taken out for the December 2026 show: they
  // won't be built in time. To bring them back: universe 4, addresses 1 and 257, and their places in RIG (main.js).
];

export class Fixture {
  constructor(entry) {
    Object.assign(this, entry);
    this.def = PROFILES[entry.profile];
    this.u = universes[entry.universe - 1];
    this.base = entry.address - 1;
    this.index = Object.fromEntries(this.def.channels.map((c, i) => [c, i]));
    this.n = this.def.zones || 0;
    this.zone0 = this.n ? this.base + this.index['Z1 R'] : 0;
    // The tubes have no dimmer, so they get a virtual one: the show paints RGB into `raw`,
    // and commit() writes raw × level × strobe out to DMX — the way a desk drives plain pixels.
    this.virtual = this.n ? { level: 1, strobe: 0, raw: new Float32Array(this.n * 3) } : null;
  }
  ch(name) { return this.base + this.index[name]; }
  get(name) { return this.u[this.ch(name)]; }
  set(name, v) { this.u[this.ch(name)] = clamp255(v); }

  // ── what the show talks in ──
  level(v) { if (this.virtual) this.virtual.level = clamp01(v); else this.set('Dimmer', v * 255); }
  getLevel() { return this.virtual ? this.virtual.level : this.get('Dimmer') / 255; }
  strobe(rate) { if (this.virtual) this.virtual.strobe = rate; else this.set(this.def.strobeChannel, this.def.encodeStrobe(rate)); }

  setZone(i, r, g, b) { const a = i * 3, z = this.virtual.raw; z[a] = r; z[a + 1] = g; z[a + 2] = b; }
  getZone(i, out) {   // 0–255, before the virtual dimmer
    const a = i * 3, z = this.virtual.raw;
    out[0] = z[a]; out[1] = z[a + 1]; out[2] = z[a + 2];
    return out;
  }
  commit(t) {
    if (!this.virtual) return;
    const k = this.virtual.level * rateGate(this.virtual.strobe, t), z = this.virtual.raw;
    for (let i = 0; i < this.n; i++) {
      const r = z[i * 3] * k, g = z[i * 3 + 1] * k, b = z[i * 3 + 2] * k;
      const w = Math.min(r, g, b);   // the part all three share goes to the white LEDs instead
      const a = this.zone0 + i * 4;
      this.u[a] = clamp255(r - w); this.u[a + 1] = clamp255(g - w); this.u[a + 2] = clamp255(b - w); this.u[a + 3] = clamp255(w);
    }
  }

  // moving heads: degrees in, 16-bit pan/tilt out. Tilt 0 points straight up; with tilt on, pan 0 leans towards the audience.
  aim(panDeg, tiltDeg) {
    const { panRange, tiltRange, limits, panZero } = this.def;
    const p = to16((clampTo(panDeg, limits.pan) - panZero + panRange / 2) / panRange);
    const t = to16((clampTo(tiltDeg, limits.tilt) + tiltRange / 2) / tiltRange);
    this.set('Pan', p >> 8); this.set('Pan fine', p & 255);
    this.set('Tilt', t >> 8); this.set('Tilt fine', t & 255);
  }
  angles() {
    const p = (this.get('Pan') * 256 + this.get('Pan fine')) / 65535;
    const t = (this.get('Tilt') * 256 + this.get('Tilt fine')) / 65535;
    return [p * this.def.panRange - this.def.panRange / 2 + this.def.panZero, t * this.def.tiltRange - this.def.tiltRange / 2];
  }
  colour(name) { this.set('Colour', this.def.encodeColour(name)); }
  prism(mode) { this.set('Prism', this.def.encodePrism(mode)); }
}

export const fixtures = PATCH.map(e => new Fixture(e));
export const byId = Object.fromEntries(fixtures.map(f => [f.id, f]));

// Heads start upright, facing the audience and dark: all zeros would send them to one end of their pan and tilt range.
for (const f of fixtures) if (f.def.limits) f.aim(0, 0);

// who owns each channel, per universe, for the DMX monitor
export const channelMaps = universes.map(() => Array.from({ length: 512 }, () => null));
for (const f of fixtures) f.def.channels.forEach((c, i) => { channelMaps[f.universe - 1][f.base + i] = { fixture: f, channel: c }; });

function clamp255(v) { return v <= 0 ? 0 : v >= 255 ? 255 : v | 0; }
function clamp01(v) { return v <= 0 ? 0 : v >= 1 ? 1 : v; }
function clampTo(v, [lo, hi]) { return v <= lo ? lo : v >= hi ? hi : v; }
function to16(x) { return Math.round(Math.min(1, Math.max(0, x)) * 65535); }
