// The setlist panel, drawn with Preact. Everything it shows comes from the signals in setlist.js,
// so it redraws by itself whenever a cue fires, a bandmate edits, or the song moves on.

import { h, render } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { computed, useSignalEffect } from '@preact/signals';
import htm from 'htm';
import * as S from './setlist.js';
import { PALETTE } from './show.js';

const html = htm.bind(h);

const clock = computed(() => (S.duration.value ? `${S.fmt(S.playhead.value)} / ${S.fmt(S.duration.value)}` : S.fmt(S.playhead.value)));
const span = () => S.duration.value || Math.max(300, (S.cues.value.at(-1)?.t || 0) + 60, S.playhead.value + 30);

function Header() {
  const add = () => {
    const title = prompt('Song title (no recording — you step through it with GO):')?.trim();
    if (title) S.newSong(title);
  };
  return html`<header>
    <span>Setlist</span>
    <select class="song" aria-label="Song" value=${S.songId.value} onChange=${e => S.selectSong(e.currentTarget.value)}>
      ${S.songs.value.map(s => html`<option key=${s.id} value=${s.id}>${s.title}</option>`)}
    </select>
    <button class="song-add" title="Add a song without a recording" onClick=${add}>+ Song</button>
  </header>`;
}

function SoundCloud({ url, title }) {
  const frame = useRef();
  useEffect(() => S.connectSoundCloud(frame.current), []);
  return html`<div class="sc" data-note=${S.scNote.value || undefined}>
    <iframe ref=${frame} title=${`${title} (SoundCloud)`} allow="autoplay" height="20" src=${S.scPlayerUrl(url)}></iframe>
  </div>`;
}

function Transport() {
  return html`<div class="transport">
    <button class="play" aria-pressed=${S.playing.value} onClick=${S.playPause}>${S.playing.value ? 'Pause' : 'Play'}<kbd>P</kbd></button>
    <span class="clock">${clock}</span>
    <button class="rec" aria-pressed=${S.recording.value} title="Look keys and taps become cues at the playhead" onClick=${S.toggleRecord}>Record<kbd>R</kbd></button>
    <label class="check">
      <input type="checkbox" class="follow" checked=${S.follow.value} onChange=${e => { S.follow.value = e.currentTarget.checked; }} /> Follow cues
    </label>
  </div>`;
}

function Timeline() {
  const canvas = useRef();
  useSignalEffect(() => {
    if (!S.open.value || !canvas.current) return;
    draw(canvas.current, S.playhead.value, S.cues.value, S.index.value, S.wave.value, span());
  });
  const seekTo = e => {
    const r = e.currentTarget.getBoundingClientRect();
    S.seek(((e.clientX - r.left) / r.width) * span());
  };
  return html`<canvas class="timeline" ref=${canvas} aria-label="Song timeline: click to jump" onPointerDown=${seekTo}></canvas>`;
}

// waveform, each cue's stretch tinted by its look, the cue lines, and the playhead
function draw(tl, p, cues, on, wave, D) {
  const dpr = Math.min(2, devicePixelRatio), W = Math.round(tl.clientWidth * dpr), H = Math.round(tl.clientHeight * dpr);
  if (!W || !H) return;
  if (tl.width !== W || tl.height !== H) { tl.width = W; tl.height = H; }
  const x = s => (s / D) * W, g = tl.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(243,242,238,.05)';
  g.fillRect(0, 0, W, H);
  cues.forEach((c, i) => {
    g.fillStyle = S.LOOK_COLOUR[c.scene] + (i === on ? '40' : '1c');
    g.fillRect(x(c.t), 0, x(cues[i + 1]?.t ?? D) - x(c.t), H);
  });
  if (wave) {
    g.fillStyle = 'rgba(243,242,238,.55)';
    for (let px = 0; px < W; px += 2) {
      const v = wave[Math.floor((px / W) * wave.length)] || 0;
      g.fillRect(px, H / 2 - (v * H * 0.9) / 2, 1.5, v * H * 0.9);
    }
  }
  cues.forEach(c => { g.fillStyle = S.LOOK_COLOUR[c.scene]; g.fillRect(x(c.t), 0, Math.max(1.5, dpr), H); });
  g.fillStyle = '#fff';
  g.fillRect(x(p) - dpr, 0, 2 * dpr, H);
}

function CueRow({ c, i, on }) {
  const jump = e => { if (!e.target.closest('input, select, button')) S.jumpTo(i); };
  const setTime = e => {
    const s = S.parseTime(e.currentTarget.value);
    if (s === null) e.currentTarget.value = S.fmt(c.t); else S.updateCue(i, { t: s });
  };
  return html`<li class=${on ? 'cue on' : 'cue'} style=${`--look:${S.LOOK_COLOUR[c.scene]}`} onClick=${jump}>
    <div class="l1">
      <input class="t" value=${S.fmt(c.t)} aria-label="Cue time" size="6" onChange=${setTime} />
      <input class="n" value=${c.name} aria-label="Cue name" onChange=${e => S.updateCue(i, { name: e.currentTarget.value.trim() })} />
      <button class="x" aria-label="Delete cue" onClick=${() => S.deleteCue(i)}>×</button>
    </div>
    <div class="l2">
      <select class="look" aria-label="Look" value=${c.scene} onChange=${e => S.updateCue(i, { scene: e.currentTarget.value })}>
        ${S.LOOKS.map(l => html`<option key=${l.id} value=${l.id}>${l.label}</option>`)}
      </select>
      ${['a', 'b'].map(slot => html`<button key=${slot} class="sw" style=${`--c:rgb(${PALETTE[c[slot]].rgb})`}
        title=${`Colour ${slot.toUpperCase()}: ${c[slot]} (click to change, shift-click to go back)`}
        onClick=${e => S.cycleColour(i, slot, e.shiftKey ? -1 : 1)}></button>`)}
      <input class="bpm" type="number" min="40" max="240" value=${c.bpm} aria-label="Tempo" onChange=${e => S.updateCue(i, { bpm: e.currentTarget.value })} /><span>bpm</span>
    </div>
  </li>`;
}

function CueList() {
  const list = useRef(), on = S.index.value;
  useEffect(() => { list.current?.querySelector('.cue.on')?.scrollIntoView({ block: 'nearest' }); }, [on]);
  return html`<ol class="cues" ref=${list}>
    ${S.cues.value.map((c, i) => html`<${CueRow} key=${i} c=${c} i=${i} on=${i === on} />`)}
  </ol>`;
}

function GoRow() {
  const next = S.cues.value[S.index.value + 1];
  return html`<div class="go-row">
    <button class="back" title="Previous cue (←)" disabled=${S.index.value <= 0} onClick=${S.back}>◀</button>
    <button class="go" title="Next cue (→)" disabled=${!next} onClick=${S.go}>
      ${next ? `GO ▸ ${next.name} · ${S.fmt(next.t)}` : 'GO — end of the song'}
    </button>
  </div>`;
}

function Footer() {
  const w = S.wave.value;
  const draftNote = w ? 'Rough cues from the loud and quiet parts — then fix them by ear'
    : w === false ? "SoundCloud didn't share this track's waveform"
    : S.song.value?.soundcloud ? "Waiting for the track's waveform" : 'Needs a recording';
  const pick = e => { const f = e.currentTarget.files[0]; e.currentTarget.value = ''; if (f) S.importFile(f); };
  return html`<footer>
    <div class="actions">
      <button class="cue-add" title="Add a cue at the playhead with the current look" onClick=${S.addCueHere}>+ Cue here</button>
      <button class="draft" disabled=${!w || !S.duration.value} title=${draftNote} onClick=${S.draft}>Draft from waveform</button>
      <button class="export" onClick=${S.exportSong}>Export</button>
      <label class="import">Import<input type="file" accept=".json,application/json" hidden onChange=${pick} /></label>
    </div>
    <small class="save-status">${S.status}</small>
  </footer>`;
}

function Setlist() {
  const s = S.song.value;
  return html`<section class="setlist" hidden=${!S.open.value} aria-label="Setlist">
    <${Header} />
    ${s?.soundcloud ? html`<${SoundCloud} key=${s.id} url=${s.soundcloud} title=${s.title} />` : null}
    <${Transport} />
    <${Timeline} />
    <${CueList} />
    <${GoRow} />
    <${Footer} />
  </section>`;
}

export function mountSetlist(root) { render(html`<${Setlist} />`, root); }
