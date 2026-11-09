// A MIDI foot pedal (an M-Vave Chocolate) and pad (an M-Vave SMC-PAD), or anything else that speaks MIDI. There are no presets for what a
// switch sends: pressing Learn and then the switch assigns it, so it works however the pedal is set up.
// The assignments stay in this browser.

const STORE = 'owashi-sim:pedal';
const SAME_PRESS_MS = 40;    // one press can arrive twice, over USB and Bluetooth at once; quick drumming can't
const PAD_STORE = 'owashi-sim:pad';
export const PAD_COUNT = 16;
// The M-Vave SMC-PAD Pocket as it comes, read from Midi Suite on 2026-11-08: channel 10, PAD 1 (bottom left) is
// note 36, counting left to right and upwards to PAD 16 (top right), note 51. Pads here run top left first.
export const SMC_PAD_POCKET = Array.from({ length: PAD_COUNT }, (_, i) => `note:9:${36 + (3 - Math.floor(i / 4)) * 4 + (i % 4)}`);

export const actions = [
  { id: 'next', label: 'Next scene, then next song' },
  { id: 'back', label: 'Back' },
  { id: 'blackout', label: 'Blackout' },
  { id: 'tap', label: 'Tap tempo' },
];
// The M-Vave Chocolate in Midi Suite's Custom control mode (set up on 2026-11-08): switches A–D send
// CC 32–35 on channel 1. A is the right foot's next scene, B undoes a mistake, C blacks out, D taps the tempo.
export const CHOCOLATE = { next: 'cc:0:32', back: 'cc:0:33', blackout: 'cc:0:34', tap: 'cc:0:35' };

export const pedal = {
  state: 'off',     // off · unsupported · denied · ready
  inputs: [],       // names of the connected MIDI devices
  map: {},          // action id → switch
  learning: null,   // the action waiting for a press
  pads: [],         // pad number (0 = top left, row by row) → what it sends
  padLearn: null,   // the pad waiting to be pressed, while setting up the pad
  onPad: () => {},  // (pad number, down, velocity 0–1)
  tapPads: new Set(),   // pads where every press counts, even right after a release (Hit, Tap tempo…)
  bridge: null,     // the MIDI devices the bridge sees, while the sim gets its MIDI from there
  onAction: () => {},
  onChange: () => {},
  describe,
};
try {
  const saved = JSON.parse(localStorage.getItem(STORE));
  pedal.map = saved && actions.some(a => saved[a.id]) ? saved : { ...CHOCOLATE };   // older saves had other actions
} catch { pedal.map = { ...CHOCOLATE }; }
try { pedal.pads = JSON.parse(localStorage.getItem(PAD_STORE)) || [...SMC_PAD_POCKET]; } catch { pedal.pads = [...SMC_PAD_POCKET]; }

// A switch or pad is its message type, channel and number. Pressing is a note on, a control change above 0
// or a program change; releasing is a note off or a control change back to 0.
function parse([status, data1, data2]) {
  const type = status & 0xf0, channel = status & 0x0f;
  if (type === 0xc0) return { key: `pc:${channel}:${data1}`, down: true, v: 1 };
  if (type === 0x90) return { key: `note:${channel}:${data1}`, down: data2 > 0, v: data2 / 127 };
  if (type === 0x80) return { key: `note:${channel}:${data1}`, down: false, v: 0 };
  if (type === 0xb0) return { key: `cc:${channel}:${data1}`, down: data2 > 0, v: data2 / 127 };
  return null;
}
export function describe(key) {
  const [type, channel, n] = key.split(':');
  return `${{ pc: 'PC', note: 'Note', cc: 'CC' }[type]} ${n} · ch ${+channel + 1}`;
}

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(pedal.map)); localStorage.setItem(PAD_STORE, JSON.stringify(pedal.pads)); } catch { /* it just won't be remembered */ }
}
export function assign(id, key) {
  // one switch does one thing
  if (key) for (const other of Object.keys(pedal.map)) if (pedal.map[other] === key) delete pedal.map[other];
  if (key) pedal.pads = pedal.pads.map(k => (k === key ? null : k));
  if (key) pedal.map[id] = key; else delete pedal.map[id];
  save();
  pedal.onChange();
}

// Setting up the pad: press its pads in order, top left to bottom right, as the screen shows them.
export function learnPads(on) {
  pedal.padLearn = on ? 0 : null;
  if (on) pedal.learning = null;
  pedal.onChange();
}

// With Note Repeat on, a held pad sends release-press pairs 1 ms apart, over and over. A release waits this long
// for such a press, so a held pad stays held and a look isn't restarted every quarter note.
const REPEAT_GAP_MS = 20;
const releasing = new Map();   // key → the timer that will deliver its release
// A pad on USB and Bluetooth at once sends everything twice, the Bluetooth copy a little later. The first
// connection a pad or switch is heard on owns it; the same key from another one shortly after is a copy.
const COPY_WINDOW_MS = 1000;
const heardOn = new Map();     // key → { from, at }

let lastKey = '', lastAt = -1e9;
export function handle(data, now = performance.now(), from = '') {
  const m = parse(data);
  if (!m) return;
  if (from) {
    const heard = heardOn.get(m.key);
    if (heard && heard.from !== from && now - heard.at < COPY_WINDOW_MS) return;
    heardOn.set(m.key, { from, at: now });
  }
  const pad = pedal.pads.indexOf(m.key);
  // Only pads that are held, or that switch looks, wait out repeats: on a tap pad every press is a tap, even when
  // Bluetooth delivers a release and the next press in the same instant.
  if (pad >= 0 && pedal.padLearn === null && !pedal.learning && !pedal.tapPads.has(pad)) {
    if (!m.down) {   // hold the release back for a moment
      clearTimeout(releasing.get(m.key));
      releasing.set(m.key, setTimeout(() => { releasing.delete(m.key); pedal.onPad(pad, false, 0); }, REPEAT_GAP_MS));
      return;
    }
    if (releasing.has(m.key)) {   // the pad repeating itself: still the same press
      clearTimeout(releasing.get(m.key));
      releasing.delete(m.key);
      return;
    }
  }
  if (m.down) {
    if (m.key === lastKey && now - lastAt < SAME_PRESS_MS) return;
    lastKey = m.key; lastAt = now;
  }
  if (m.down && pedal.padLearn !== null) {
    const i = pedal.padLearn;
    for (const id of Object.keys(pedal.map)) if (pedal.map[id] === m.key) delete pedal.map[id];
    pedal.pads = pedal.pads.map(k => (k === m.key ? null : k));
    pedal.pads[i] = m.key;
    pedal.padLearn = i + 1 < PAD_COUNT ? i + 1 : null;
    save();
    pedal.onChange();
    return;
  }
  if (m.down && pedal.learning) {
    const id = pedal.learning;
    pedal.learning = null;
    assign(id, m.key);
    return;
  }
  if (pad >= 0) return pedal.onPad(pad, m.down, m.v || 1);
  if (!m.down) return;
  const action = actions.find(a => pedal.map[a.id] === m.key);
  if (action) pedal.onAction(action.id);
  pedal.onChange();
}

// ── through the bridge ──
// The bridge reads MIDI on the Mac and passes it to every open sim, so the pedal and pad work in any browser,
// the Claude app's included. While it's there, the browser's own MIDI is ignored, or every press would count twice.
export function connectBridge(url) {
  if (location.protocol === 'https:') return;   // the website can't reach a bridge on this computer
  let ws;
  try { ws = new WebSocket(url); } catch { return; }
  ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'midi' && Array.isArray(m.data)) handle(m.data, performance.now(), m.from || 'bridge');
    else if (m.type === 'midi-sources' || m.midiSources) {
      pedal.bridge = m.names || m.midiSources;
      pedal.onChange();
    }
  };
  ws.onclose = () => {
    if (pedal.bridge) { pedal.bridge = null; pedal.onChange(); }
    setTimeout(() => connectBridge(url), 5000);   // the bridge may start later, or restart
  };
}

function listen(access) {
  const refresh = () => {
    const inputs = [...access.inputs.values()];
    for (const input of inputs) input.onmidimessage = e => { if (!pedal.bridge) handle(e.data, performance.now(), input.id || input.name); };
    pedal.inputs = inputs.map(i => i.name || 'MIDI device');
    pedal.state = 'ready';
    pedal.onChange();
  };
  access.onstatechange = refresh;   // plugged in or paired later, or back after a dropout
  refresh();
}

export async function connect() {
  if (!navigator.requestMIDIAccess) { pedal.state = 'unsupported'; pedal.onChange(); return; }
  try {
    listen(await navigator.requestMIDIAccess());
  } catch {
    pedal.state = 'denied';
    pedal.onChange();
  }
}

// Without asking: only if this browser has already been allowed, so a page load never pops up a prompt.
export async function connectIfAllowed() {
  if (!navigator.requestMIDIAccess) { pedal.state = 'unsupported'; pedal.onChange(); return; }
  try {
    const { state } = await navigator.permissions.query({ name: 'midi' });
    if (state === 'granted') await connect();
  } catch { /* can't tell: wait for the Connect button */ }
}
