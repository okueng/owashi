// Where the show lives: JSON files in sim/show/ — setlist.json, and songs/<id>.json with each song's cues.
// Opened from the bridge (http://localhost:8770/sim/), edits are written straight into those files, ready
// to commit, and every other device on the network picks them up. Opened anywhere else — the website —
// the files are read-only and edits stay in this browser.

const LOCAL_CUES = id => `owashi-sim:cues:${id}`;
const LOCAL_SONGS = 'owashi-sim:songs';
const local = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* not remembered, that's all */ } },
};

export const showStore = {
  canSave: false,        // true when the bridge is serving us and will write the files
  onChange: () => {},    // (songId | '*', song?) — another device changed the show
  onStatus: () => {},    // (text) — where the last edit went
};

const CLIENT = Math.random().toString(36).slice(2);   // tags our saves, so we don't reload our own edits
const timers = {};

async function fetchJson(url, fallback) {
  try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? await r.json() : fallback; } catch { return fallback; }
}

export async function loadShow() {
  let list = [];
  try {
    const r = await fetch('./show/setlist.json', { cache: 'no-cache' });
    showStore.canSave = r.headers.get('x-owashi-bridge') === '1';   // served by the bridge: it can save
    if (r.ok) list = (await r.json()).songs || [];
  } catch { /* no setlist yet */ }
  if (!showStore.canSave) {
    for (const s of local.get(LOCAL_SONGS) || []) if (!list.some(x => x.id === s.id)) list.push(s);
  }
  const songs = await Promise.all(list.map(async entry => {
    const file = await fetchJson(`./show/songs/${entry.id}.json`, null);
    const mine = showStore.canSave ? null : local.get(LOCAL_CUES(entry.id));
    return { ...entry, ...(file || {}), cues: mine || file?.cues || [{ t: 0, name: 'Intro', scene: 'ambient' }] };
  }));
  showStore.onStatus(showStore.canSave
    ? 'Edits save to sim/show/ on this computer'
    : 'Edits stay in this browser — open the sim from the bridge to save them for the band');
  if (showStore.canSave) listen();
  return songs;
}

export function saveSong(song) {
  const { id, title, soundcloud, cues } = song;
  clearTimeout(timers[id]);
  timers[id] = setTimeout(async () => {
    if (!showStore.canSave) {
      local.set(LOCAL_CUES(id), cues);
      showStore.onStatus('Saved in this browser only');
      return;
    }
    try {
      const r = await fetch(`/api/show/songs/${id}`, {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-sim-client': CLIENT },
        body: JSON.stringify({ title, ...(soundcloud ? { soundcloud } : {}), cues }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      showStore.onStatus(`Saved to sim/show/songs/${id}.json`);
    } catch (err) {
      local.set(LOCAL_CUES(id), cues);
      showStore.onStatus(`Couldn't save to the bridge (${err.message}) — kept in this browser`);
    }
  }, 400);
}

export function addSong(song) {
  if (!showStore.canSave) local.set(LOCAL_SONGS, [...(local.get(LOCAL_SONGS) || []), { id: song.id, title: song.title }]);
  saveSong(song);   // through the bridge, a new song's file also adds it to the setlist
}

// The bridge tells every open sim when the show changes; reload what someone else edited.
function listen() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.onmessage = async e => {
    if (typeof e.data !== 'string') return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type !== 'show' || m.by === CLIENT) return;
    if (m.setlist) { showStore.onChange('*'); return; }
    const song = await fetchJson(`./show/songs/${m.song}.json`, null);
    if (song) showStore.onChange(m.song, song);
  };
  ws.onclose = () => setTimeout(listen, 3000);
}
