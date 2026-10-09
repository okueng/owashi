// The setlist: each song is a list of cues — a moment in the song, a look, two colours and a tempo.
// Cues play back against the real track (SoundCloud) or a stopwatch, get recorded by pressing look
// keys while the song plays, and are stepped through with GO when you play it live.
// This file holds the logic and the state, as signals; setlist-ui.js draws the panel from them.
// Songs and cues live in sim/show/ (see showstore.js).

import { batch, computed, effect, signal } from '@preact/signals';
import { cue, PALETTE, SCENE_LIST, show } from './show.js';
import { addSong, loadShow, saveSong, showStore } from './showstore.js';

export const LOOKS = SCENE_LIST.map(([id, label]) => ({ id, label }));
export const LOOK_LABEL = Object.fromEntries(LOOKS.map(l => [l.id, l.label]));
export const LOOK_COLOUR = {
  ambient: '#4a6cff', sweep: '#9cc2ff', build: '#e0a21e', riff: '#e0301e', blast: '#ffffff',
  breakdown: '#a51c14', wall: '#f3f2ee', embers: '#ff7a1a', strobe: '#ffffff', blackout: '#555555',
};
export const COLOURS = Object.keys(PALETTE);

export const fmt = s => { s = Math.max(0, s); const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
export const parseTime = txt => {
  const p = String(txt).trim().split(':').map(Number);
  const s = p.length > 1 ? p[0] * 60 + p[1] : p[0];
  return Number.isFinite(s) && s >= 0 ? s : null;
};
const frac = x => x - Math.floor(x);
const byTime = (a, b) => a.t - b.t;
export const clean = c => ({
  t: Math.max(0, +c.t || 0),
  name: String(c.name ?? '').slice(0, 40),
  scene: LOOK_LABEL[c.scene] ? c.scene : 'ambient',
  a: PALETTE[c.a] ? c.a : 'Red',
  b: PALETTE[c.b] ? c.b : 'Blue',
  bpm: Math.min(240, Math.max(40, Math.round(+c.bpm || 120))),
  phase: frac(+c.phase || 0),
});

// ── state ───────────────────────────────────────────────────────────────────

export const songs = signal([]);          // [{ id, title, soundcloud?, cues }]
export const songId = signal(null);
export const song = computed(() => songs.value.find(s => s.id === songId.value) || null);
export const cues = computed(() => song.value?.cues || []);
export const index = signal(-1);          // the cue that's on
export const playing = signal(false);
export const recording = signal(false);
export const follow = signal(true);       // cues fire by themselves as the song plays
export const duration = signal(0);        // 0 until the track tells us
export const wave = signal(null);         // the track's waveform (0–1), false if SoundCloud won't share it
export const playhead = signal(0);        // refreshed every frame while the panel is open
export const status = signal('');         // where the last edit went
export const scNote = signal('');
export const open = signal(remembered('owashi-sim:setlist-open', false));
effect(() => remember('owashi-sim:setlist-open', open.value));

let pos = 0, at = 0, widget = null;       // the track's position, when we heard it, and SoundCloud's player
let followed = -1;                        // the cue the music itself last reached; GO and ← hold until the next one
let now = () => 0, onApplied = () => {};
export function configure(opts) { ({ now, onApplied } = opts); }

function remembered(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function remember(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not remembered, that's all */ } }

// ── songs ───────────────────────────────────────────────────────────────────

export async function loadSongs(keep = songId.value) {
  const list = (await loadShow()).map(s => ({ ...s, cues: s.cues.map(clean).sort(byTime) }));
  songs.value = list;
  const pick = list.find(s => s.id === keep) || list[0];
  if (pick && pick.id !== songId.value) selectSong(pick.id);
}

showStore.onStatus = text => { status.value = text; };
showStore.onChange = (id, data) => {   // someone else edited the show
  if (id === '*' || !songs.value.some(s => s.id === id)) { loadSongs(); return; }
  batch(() => {
    songs.value = songs.value.map(s => (s.id === id ? { ...s, cues: data.cues.map(clean).sort(byTime) } : s));
    if (id === songId.value) index.value = Math.min(index.value, cues.value.length - 1);
    status.value = `Updated from another device · ${data.title}`;
  });
};

export function selectSong(id) {
  const s = songs.value.find(x => x.id === id);
  if (!s) return;
  pause();
  widget = null; pos = 0; followed = -1;
  batch(() => {
    songId.value = id;
    index.value = -1; duration.value = 0; wave.value = null; scNote.value = ''; playhead.value = 0;
    follow.value = !!s.soundcloud;   // a recording can drive the cues; live, you press GO
  });
}

export function newSong(title) {
  const id = title.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `song-${Date.now()}`;
  if (!songs.value.some(s => s.id === id)) {
    const s = { id, title, cues: [clean({ t: 0, name: 'Intro', scene: 'ambient' })] };
    songs.value = [...songs.value, s];
    addSong(s);
  }
  selectSong(id);
}

// Replace the current song's cues (kept in time order), keep `on` lit, and save.
function setCues(next, on = cues.value[index.value]) {
  const sorted = [...next].sort(byTime);
  batch(() => {
    songs.value = songs.value.map(s => (s.id === songId.value ? { ...s, cues: sorted } : s));
    index.value = on ? sorted.indexOf(on) : -1;
  });
  saveSong(song.value);
}

export function updateCue(i, patch) {
  const old = cues.value[i];
  if (!old) return;
  const fresh = clean({ ...old, ...patch }), on = cues.value[index.value];
  setCues(cues.value.map(c => (c === old ? fresh : c)), on === old ? fresh : on);
}
export function deleteCue(i) {
  const list = cues.value, gone = list[i], on = list[index.value];
  const rest = list.filter(c => c !== gone);
  setCues(rest.length ? rest : [clean({ t: 0, name: 'Intro', scene: 'ambient' })], on === gone ? list[i - 1] : on);
}
export function cycleColour(i, slot, dir) {
  const k = COLOURS.indexOf(cues.value[i][slot]);
  updateCue(i, { [slot]: COLOURS[(k + dir + COLOURS.length) % COLOURS.length] });
}

// ── the track: SoundCloud's player, or a stopwatch when there's no recording ──

export const scPlayerUrl = url => `https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}`
  + '&auto_play=false&visual=false&show_artwork=false&hide_related=true&show_comments=false'
  + '&show_user=false&show_reposts=false&show_teaser=false&color=%23e0301e';

function loadScApi() {
  if (window.SC?.Widget) return Promise.resolve(window.SC);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://w.soundcloud.com/player/api.js';
    s.onload = () => resolve(window.SC);
    s.onerror = reject;
    document.head.append(s);
  });
}

// Hooks a mounted SoundCloud player up to the setlist; returns the function that unhooks it.
export function connectSoundCloud(frame) {
  let alive = true, poll = 0;
  loadScApi().then(SC => {
    if (!alive) return;
    const w = SC.Widget(frame), E = SC.Widget.Events;
    w.bind(E.READY, () => {
      if (!alive) return;
      widget = w;
      w.getCurrentSound(sound => {
        if (!alive || !sound) return;
        duration.value = sound.duration / 1000;
        const url = sound.waveform_url?.replace(/\.png(\?.*)?$/, '.json');
        if (!url) { wave.value = false; return; }
        fetch(url).then(r => r.json()).then(d => {
          const top = d.height || Math.max(...d.samples);
          if (alive) wave.value = d.samples.map(v => v / top);
        }).catch(() => { if (alive) wave.value = false; });
      });
    });
    // The player's events aren't fully reliable (no PAUSE when already paused, a stray PLAY on a seek),
    // so after each one, and every second while we think it's playing, ask it what it's really doing.
    const check = () => w.isPaused(paused => { if (alive) playing.value = !paused; });
    w.bind(E.PLAY_PROGRESS, e => { if (alive) { pos = e.currentPosition / 1000; at = performance.now(); } });
    w.bind(E.PLAY, () => { if (alive) { at = performance.now(); check(); } });
    w.bind(E.PAUSE, check);
    w.bind(E.SEEK, check);
    w.bind(E.FINISH, () => { if (alive) { pos = duration.value; playing.value = false; } });
    poll = setInterval(() => { if (alive && playing.value) check(); }, 1000);
  }).catch(() => { if (alive) scNote.value = "Couldn't reach SoundCloud — the stopwatch runs instead."; });
  return () => { alive = false; widget = null; clearInterval(poll); };
}

export function position() {
  const p = playing.value ? pos + (performance.now() - at) / 1000 : pos;
  return duration.value ? Math.min(p, duration.value) : p;
}
export function play() {
  if (widget) widget.play();
  else { at = performance.now(); playing.value = true; }
}
export function pause() {
  pos = position();
  playing.value = false;   // pausing twice is harmless, and the player won't tell us if it already was
  widget?.pause();
}
export const playPause = () => (playing.value ? pause() : play());
export function seek(sec) {
  pos = Math.max(0, duration.value ? Math.min(sec, duration.value) : sec);
  at = performance.now();
  widget?.seekTo(pos * 1000);
  playhead.value = pos;
  const i = activeIndexAt(pos);
  followed = i;
  if (i >= 0) apply(i, pos);
}

// ── cues ────────────────────────────────────────────────────────────────────

function activeIndexAt(p) {
  let i = -1;
  cues.value.forEach((c, k) => { if (c.t <= p + 0.02) i = k; });
  return i;
}
// lock the tempo grid (and a build's countdown) to where we are in the song
function align(c, p) {
  const t = now(), into = p - c.t;
  show.beat0 = t - into + (c.phase * 60) / c.bpm;
  if (show.scene === c.scene) show.cueT = t - into;
}
function apply(i, p = null) {
  const c = cues.value[i];
  if (!c) return;
  index.value = i;
  show.colorA = c.a; show.colorB = c.b; show.bpm = c.bpm;
  cue(c.scene, now());
  align(c, p ?? c.t);
  onApplied();
}
export function jumpTo(i) { seek(cues.value[i].t); }
export function go() { if (index.value + 1 < cues.value.length) apply(index.value + 1); }
export function back() { if (index.value > 0) apply(index.value - 1); }

function upsertAt(p, scene) {
  const list = cues.value, near = list.find(c => Math.abs(c.t - p) < 1);
  const base = near || {
    t: Math.round(p * 10) / 10, phase: 0,
    name: p < 1 ? 'Intro' : `${LOOK_LABEL[scene]} ${list.filter(x => x.scene === scene).length + 1}`,
  };
  const fresh = clean({ ...base, scene, a: show.colorA, b: show.colorB, bpm: show.bpm });
  setCues(near ? list.map(c => (c === near ? fresh : c)) : [...list, fresh], fresh);
}
export const addCueHere = () => upsertAt(position(), show.scene);
export const toggleRecord = () => { recording.value = !recording.value; };
// looks pressed while recording become cues at the playhead
export function recordLook(scene) { if (recording.value && song.value) upsertAt(position(), scene); }
// taps while recording set the current cue's tempo, and its downbeat to the last tap
export function onTap() {
  if (!recording.value || index.value < 0) return;
  const c = cues.value[index.value];
  updateCue(index.value, { bpm: show.bpm, phase: frac(((position() - c.t) * show.bpm) / 60) });
}

// A first draft from the waveform: quiet stretches → Ambient (Embers at the very end), middle → Sweep,
// loud → Riff, the loudest loud stretch → Wall, and a Build into every loud part. Then fix it by ear.
export function draft() {
  const w = wave.value, D = duration.value;
  if (!w || !D) return;
  if (cues.value.length > 1 && !confirm(`Replace the ${cues.value.length} cues with a draft from the waveform?`)) return;
  const N = Math.floor(D), level = new Float32Array(N);
  for (let s = 0; s < N; s++) {
    const a = Math.floor((s / D) * w.length), b = Math.max(a + 1, Math.floor(((s + 1) / D) * w.length));
    let m = 0;
    for (let k = a; k < b; k++) m += w[k];
    level[s] = m / (b - a);
  }
  const smooth = level.map((_, s) => {
    let m = 0, n = 0;
    for (let k = Math.max(0, s - 4); k <= Math.min(N - 1, s + 4); k++) { m += level[k]; n++; }
    return m / n;
  });
  const sorted = [...smooth].sort((a, b) => a - b);
  const lo = sorted[Math.floor(N * 0.33)], hi = sorted[Math.floor(N * 0.66)];
  let segs = [];
  for (let s = 0; s < N; s++) {
    const L = smooth[s] < lo ? 0 : smooth[s] < hi ? 1 : 2;
    if (segs.length && segs[segs.length - 1].L === L) segs[segs.length - 1].end = s + 1;
    else segs.push({ t: s, end: s + 1, L });
  }
  // fold anything shorter than 20 s into its neighbour, then join neighbours that ended up equal
  for (let i = 0; i < segs.length && segs.length > 1;) {
    if (segs[i].end - segs[i].t >= 20) { i++; continue; }
    const j = i > 0 ? i - 1 : i + 1;
    segs[j].t = Math.min(segs[j].t, segs[i].t); segs[j].end = Math.max(segs[j].end, segs[i].end);
    segs.splice(i, 1);
    i = 0;
  }
  segs = segs.reduce((out, s) => {
    if (out.length && out[out.length - 1].L === s.L) out[out.length - 1].end = s.end; else out.push({ ...s });
    return out;
  }, []);
  const mean = s => { let m = 0; for (let k = s.t; k < s.end; k++) m += smooth[k]; return m / (s.end - s.t); };
  const loud = segs.filter(s => s.L === 2);
  const peak = loud.length > 1 ? loud.reduce((a, b) => (mean(b) > mean(a) ? b : a)) : null;

  const out = [], count = {};
  const add = (t, scene, a, b) => {
    count[scene] = (count[scene] || 0) + 1;
    out.push(clean({ t: Math.round(t * 2) / 2, name: t === 0 ? 'Intro' : `${LOOK_LABEL[scene]} ${count[scene]}`, scene, a, b, bpm: show.bpm }));
  };
  segs.forEach((s, i) => {
    const last = i === segs.length - 1, next = segs[i + 1];
    if (s.L === 2) add(s.t, s === peak ? 'wall' : 'riff', 'Red', s === peak ? 'Blue' : 'UV');
    else if (last && i > 0) add(s.t, 'embers', 'Amber', 'Red');
    else add(s.t, s.L === 0 ? 'ambient' : 'sweep', s.L === 0 ? 'Red' : 'Ice', 'Blue');
    if (next?.L === 2 && s.L < 2) {   // build into the loud part
      if (s.end - s.t >= 30) add(s.end - 20, 'build', 'Red', 'Blue');
      else {   // too short to share: the whole stretch builds
        const c = out[out.length - 1];
        count.build = (count.build || 0) + 1;
        Object.assign(c, { scene: 'build', a: 'Red', b: 'Blue', name: c.t === 0 ? 'Intro' : `Build ${count.build}` });
      }
    }
  });
  out[0].name = 'Intro';
  setCues(out, null);
}

export function exportSong() {
  const { id, title, soundcloud } = song.value;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ id, title, soundcloud, cues: cues.value }, null, 2)], { type: 'application/json' }));
  a.download = `${id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.cues)) throw new Error('no cues in this file');
    if (cues.value.length > 1 && !confirm(`Replace the cues of “${song.value.title}” with the ${data.cues.length} in ${file.name}?`)) return;
    setCues(data.cues.map(clean), null);
  } catch (err) { alert(`Couldn't read ${file.name}: ${err.message}`); }
}

// ── once a frame, before the show runs ──────────────────────────────────────

export function tick() {
  if (!song.value) return;
  const p = position();
  if (follow.value && playing.value) {
    const i = activeIndexAt(p);
    if (i !== followed) {   // the music reached a new cue
      followed = i;
      if (i >= 0) apply(i, p);
    } else if (i >= 0 && i === index.value) {
      align(cues.value[i], p);   // keep the beat locked to the music
    }
  }
  if (open.value && Math.abs(p - playhead.value) >= 0.05) playhead.value = p;
}
