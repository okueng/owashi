// What the band's mixer hears: the XR18's inputs over USB, read by the bridge (audio-in.swift). Each channel's
// level arrives 20 times a second, and a hit the moment a channel jumps. Each channel gets a role (kick, snare,
// a guitar…) so the show knows what it's listening to. The roles stay in this browser: it's the laptop at the gig.

const ROLE_STORE = 'owashi-sim:input-roles';

export const ROLES = [
  ['', '—'], ['kick', 'Kick'], ['snare', 'Snare'], ['toms', 'Toms'], ['overheads', 'Overheads'],
  ['bass', 'Bass'], ['gtr-left', 'Guitar, left'], ['gtr-right', 'Guitar, right'], ['other', 'Other'],
];

export const inputs = {
  device: null,      // the interface's name, while the bridge is listening to one
  channels: 0,
  names: [],         // channel names, when they're known (a recording's tracks)
  note: '',          // why there's nothing, when there isn't
  levels: [],        // dBFS per channel, -90 is silence
  hitAt: [],         // performance.now() of each channel's last hit
  hitV: [],          // and how hard, 0–1
  roles: [],         // role id per channel
  onChange: () => {},   // the device or the roles changed
  onLevels: () => {},   // new levels arrived (the Inputs sheet)
  levelListeners: new Set(),   // and whoever else wants them (live.js)
  hitListeners: new Set(),     // (channel, strength, role)
};
try { inputs.roles = JSON.parse(localStorage.getItem(ROLE_STORE)) || []; } catch { inputs.roles = []; }

export function setRole(ch, role) {
  inputs.roles[ch] = role;
  try { localStorage.setItem(ROLE_STORE, JSON.stringify(inputs.roles)); } catch { /* kept for this visit only */ }
  inputs.onChange();
}

// A channel without a role gets one from its name, when the name says it ("01 Kick", "OH L", "Gtr Fab"…).
// Which guitar is left or right can't be told from a name: the first guitar is taken as left. Check them.
const GUESS = [[/kick|bd\b|bass ?drum/i, 'kick'], [/snare|sn\b/i, 'snare'], [/tom/i, 'toms'], [/\boh\b|overhead|cymbal|crash|ride/i, 'overheads'],
  [/\bbass\b|\bbs\b|basse/i, 'bass'], [/gu?i?ta?r|gtr/i, 'gtr']];
function guessRoles() {
  let guitars = inputs.roles.filter(r => r?.startsWith('gtr')).length, changed = false;
  inputs.names.forEach((name, i) => {
    if (inputs.roles[i]) return;
    const hit = GUESS.find(([re]) => re.test(name));
    if (!hit) return;
    inputs.roles[i] = hit[1] === 'gtr' ? (guitars++ % 2 ? 'gtr-right' : 'gtr-left') : hit[1];
    changed = true;
  });
  if (changed) try { localStorage.setItem(ROLE_STORE, JSON.stringify(inputs.roles)); } catch { /* for this visit */ }
}

// messages from the bridge
export function onBridgeMessage(m) {
  if (m.type === 'lv' && Array.isArray(m.v)) {
    inputs.levels = m.v;
    inputs.onLevels();
    for (const f of inputs.levelListeners) f();
  } else if (m.type === 'on') {
    inputs.hitAt[m.ch] = performance.now(); inputs.hitV[m.ch] = m.v;
    for (const f of inputs.hitListeners) f(m.ch, m.v, inputs.roles[m.ch] || '');
  } else if (m.type === 'audio' || (m.type === 'hello' && m.audio)) {
    const a = m.type === 'audio' ? m : m.audio;
    inputs.device = a.device; inputs.channels = a.channels || 0; inputs.note = a.note || '';
    inputs.names = a.names || [];
    if (!a.device) inputs.levels = [];
    guessRoles();
    inputs.onChange();
  }
}
