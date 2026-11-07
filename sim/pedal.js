// A MIDI foot pedal (an M-Vave Chocolate, or anything else that speaks MIDI). There are no presets for what a
// switch sends: pressing Learn and then the switch assigns it, so it works however the pedal is set up.
// The assignments stay in this browser.

const STORE = 'owashi-sim:pedal';
const SAME_PRESS_MS = 120;   // one press can arrive twice, over USB and Bluetooth at once

export const actions = [
  { id: 'nextScene', label: 'Next scene' },
  { id: 'prevScene', label: 'Previous scene' },
  { id: 'nextSong', label: 'Next song' },
  { id: 'prevSong', label: 'Previous song' },
];

export const pedal = {
  state: 'off',     // off · unsupported · denied · ready
  inputs: [],       // names of the connected MIDI devices
  map: {},          // action id → switch
  learning: null,   // the action waiting for a press
  onAction: () => {},
  onChange: () => {},
  describe,
};
try { pedal.map = JSON.parse(localStorage.getItem(STORE)) || {}; } catch { /* private window: start empty */ }

// A switch is its message type, channel and number. Only pressing counts: a release (note off, or a control
// change back to 0) is ignored, and so is a program change's lack of one.
function press([status, data1, data2]) {
  const type = status & 0xf0, channel = status & 0x0f;
  if (type === 0xc0) return `pc:${channel}:${data1}`;
  if (type === 0x90 && data2 > 0) return `note:${channel}:${data1}`;
  if (type === 0xb0 && data2 > 0) return `cc:${channel}:${data1}`;
  return null;
}
export function describe(key) {
  const [type, channel, n] = key.split(':');
  return `${{ pc: 'PC', note: 'Note', cc: 'CC' }[type]} ${n} · ch ${+channel + 1}`;
}

function save() {
  try { localStorage.setItem(STORE, JSON.stringify(pedal.map)); } catch { /* it just won't be remembered */ }
}
export function assign(id, key) {
  // one switch does one thing
  if (key) for (const other of Object.keys(pedal.map)) if (pedal.map[other] === key) delete pedal.map[other];
  if (key) pedal.map[id] = key; else delete pedal.map[id];
  save();
  pedal.onChange();
}

let lastKey = '', lastAt = -1e9;
export function handle(data, now = performance.now()) {
  const key = press(data);
  if (!key) return;
  if (key === lastKey && now - lastAt < SAME_PRESS_MS) return;
  lastKey = key; lastAt = now;
  if (pedal.learning) {
    const id = pedal.learning;
    pedal.learning = null;
    assign(id, key);
    return;
  }
  const action = actions.find(a => pedal.map[a.id] === key);
  if (action) pedal.onAction(action.id);
  pedal.onChange();
}

function listen(access) {
  const refresh = () => {
    const inputs = [...access.inputs.values()];
    for (const input of inputs) input.onmidimessage = e => handle(e.data);
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
