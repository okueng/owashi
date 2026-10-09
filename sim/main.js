import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { byId, channelMaps, PATCH, PROFILES, universes } from './dmx.js';
import { buildProgress, cue, hit, PALETTE, SCENE_LIST, show, tap, updateShow } from './show.js';
import { BeamHead, CobTube, LedBar } from './fixtures.js';
import { artnet, pump, setMode } from './artnet.js';
import { effect } from '@preact/signals';
import * as setlist from './setlist.js';
import { mountSetlist } from './setlist-ui.js';

// ── layout (metres; x = stage left→right as the audience sees it, z = towards the audience) ──
// A first guess — tweak freely once we have the real stage plot.

const DECK = { w: 6, d: 4, h: 0.5, front: 1.5 };      // a small club stage: deck runs from z = -2.5 to z = +1.5
const S = DECK.h;
const KIT_Z = -1.0;                                    // drums on the deck with everyone else, no riser

const RIG = {
  V1: { pos: [-2.4, S, -2.3] }, V2: { pos: [-0.8, S, -2.3] }, V3: { pos: [0.8, S, -2.3] }, V4: { pos: [2.4, S, -2.3] },
  H1: { pos: [-1.02, S + 0.04, KIT_Z + 0.8], horizontal: true },   // on the floor, along the front of the kit
  H2: { pos: [1.02, S + 0.04, KIT_Z + 0.8], horizontal: true },
  B1: { pos: [-1.6, S, -2.25] }, B2: { pos: [1.6, S, -2.25] },     // on the floor at the back, between the tubes
  B3: { pos: [-2.75, S, 1.25] }, B4: { pos: [2.75, S, 1.25] },     // front corners
};

// Left to right as in the rehearsal room: Fab, Cyril, Romain (back), Olivier.
// full = height in metres of the full-body picture in players/<id>.png (Fab's about 20 cm shorter than the
// others; Romain's is seated); h and holds are for the fallback
// cut-outs from the band photo (assets/band-2026-720.jpg + the ghost masks), with a low-poly instrument.
const BAND = [
  { id: 'fab', full: 1.6, h: 1.05, pos: [-2.2, S, 0.45], holds: { model: 'guitarB', at: [0.08, 0.5, 0.18], rotZ: -78 } },
  { id: 'cyril', full: 1.8, h: 1.78, pos: [-0.95, S, 0.35], holds: { model: 'guitarA', at: [0.02, 0.98, 0.16], rotZ: -62 } },
  { id: 'romain', full: 1.3, h: 1.36, pos: [0, S, KIT_Z - 0.42] },   // on the throne, behind the kit
  { id: 'olivier', full: 1.8, h: 1.82, pos: [1.6, S, 0.35], holds: { model: 'bass', at: [0.02, 1.0, 0.16], rotZ: -62 } },
];

// models: how to stand each one up and how big it really is
const MODELS = {
  guitarA: { file: 'guitar-a.glb', length: 1.0, rot: [0, 0, 0], center: true },
  guitarB: { file: 'guitar-b.glb', length: 1.0, rot: [0, -90, 0], center: true },
  bass: { file: 'bass.glb', length: 1.15, rot: [0, 0, 0], center: true },
  drums: { file: 'drums.glb', width: 1.7, rot: [0, 180, 0] },   // ships facing upstage
  guitarAmp: { file: 'guitar-amp.glb', height: 0.62, rot: [0, 0, 0] },
  bassAmp: { file: 'bass-amp.glb', height: 0.95, rot: [90, 0, 0] },   // ships lying on its back
};
const PROPS = [
  { model: 'drums', pos: [0, S, KIT_Z] },
  { model: 'guitarAmp', pos: [-2.45, S, -1.35], rotY: 10 },
  { model: 'guitarAmp', pos: [-1.3, S, -1.85], rotY: 5 },
  { model: 'bassAmp', pos: [2.0, S, -1.45], rotY: -15 },
];

const VIEWS = {
  FOH: { pos: [0, 1.9, 9], look: [0, 1.5, -0.5] },
  Pit: { pos: [-1.4, 1.1, 3.6], look: [0.2, 1.8, -1] },
  Side: { pos: [6.2, 2.3, 2.0], look: [0, 1.4, -0.6] },
  Balcony: { pos: [0, 4.8, 12.5], look: [0, 1.1, -1] },
};

// ── renderer ────────────────────────────────────────────────────────────────

const canvas = document.querySelector('canvas.stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
RectAreaLightUniformsLib.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);
scene.fog = new THREE.FogExp2(0x000000, 0.035);

const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 80);
camera.position.set(...VIEWS.FOH.pos);
const controls = new OrbitControls(camera, canvas);
controls.target.set(...VIEWS.FOH.look);
controls.enableDamping = true;
controls.maxDistance = 18;
controls.maxPolarAngle = Math.PI * 0.53;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.8, 0.45, 0.9);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// Widen the lens on tall screens, and lift the stage clear of the control panel.
const panel = document.querySelector('.panel');
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = Math.min(72, 42 * Math.max(1, 1.3 / camera.aspect));
  const covered = document.body.classList.contains('hide-ui') ? 0 : panel.getBoundingClientRect().height + 16;
  document.documentElement.style.setProperty('--panel-h', `${covered}px`);
  const drawer = document.querySelector('.setlist');   // and slide it left of the setlist when that's open
  const side = drawer && !drawer.hidden && covered && w > 900 ? (drawer.getBoundingClientRect().width + 16) / 2 : 0;
  camera.setViewOffset(w, h, side, Math.min(covered, h * 0.5) / 2, w, h);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
new ResizeObserver(resize).observe(panel);
resize();
const toggleUi = () => { document.body.classList.toggle('hide-ui'); resize(); };

// ── room & deck ─────────────────────────────────────────────────────────────

const ROOM = { w: 12, h: 6, back: DECK.front - DECK.d - 0.05, front: 16 };
const room = new THREE.Mesh(
  new THREE.BoxGeometry(ROOM.w, ROOM.h, ROOM.front - ROOM.back),
  new THREE.MeshStandardMaterial({ color: 0x111113, roughness: 0.95, side: THREE.BackSide }),
);
room.position.set(0, ROOM.h / 2, (ROOM.front + ROOM.back) / 2);
scene.add(room);

const deckMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.32, metalness: 0.15 });
const deck = new THREE.Mesh(new THREE.BoxGeometry(DECK.w, DECK.h, DECK.d), deckMat);
deck.position.set(0, DECK.h / 2, DECK.front - DECK.d / 2);
scene.add(deck);

// The ŌWASHI banner on the back wall: black cloth with the logo printed in white, so it takes the
// colour of whatever light hits it. logoY is the centre of the logo above the deck.
const BANNER = { w: 5.8, h: 3.0, logoW: 3.6, logoY: 2.35 };
const bannerCanvas = document.createElement('canvas');
bannerCanvas.width = 2048; bannerCanvas.height = Math.round(2048 * BANNER.h / BANNER.w);
const bannerTex = new THREE.CanvasTexture(bannerCanvas);
bannerTex.colorSpace = THREE.SRGBColorSpace;
bannerTex.anisotropy = 8;
const banner = new THREE.Mesh(new THREE.PlaneGeometry(BANNER.w, BANNER.h), new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.95 }));
banner.position.set(0, S + BANNER.h / 2, ROOM.back + 0.02);
scene.add(banner);

async function paintBanner() {
  const c = bannerCanvas, x = c.getContext('2d'), W = c.width, H = c.height;
  const rnd = n => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
  x.fillStyle = '#0d0d0e';
  x.fillRect(0, 0, W, H);
  for (let i = 0; i < 40; i++) {   // soft vertical folds in the cloth
    const fx = rnd(i) * W, fw = (0.02 + rnd(i + 9) * 0.05) * W;
    const g = x.createLinearGradient(fx - fw, 0, fx + fw, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${0.03 + rnd(i + 3) * 0.05})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g;
    x.fillRect(fx - fw, 0, fw * 2, H);
  }
  const logo = await loadImage('../assets/logo.svg');   // white on transparent, viewBox 7115 × 1856
  const lw = W * BANNER.logoW / BANNER.w, lh = lw * 1856 / 7115;
  x.globalAlpha = 0.86;   // printed ink, not paper white
  x.drawImage(logo, (W - lw) / 2, H * (1 - BANNER.logoY / BANNER.h) - lh / 2, lw, lh);
  x.globalAlpha = 1;
  bannerTex.needsUpdate = true;
}
paintBanner();

// house light: a little ambient so the room isn't a void, plus a front fill the slider controls
scene.add(new THREE.HemisphereLight(0x8899aa, 0x000000, 0.06));
const fill = new THREE.SpotLight(0xffe2c0, 0, 0, 0.42, 0.8, 2);
fill.position.set(0, 5.4, 9.5);
fill.target.position.set(0, 1.2, -0.5);
scene.add(fill, fill.target);

// ── fixtures ────────────────────────────────────────────────────────────────

const bars = [], heads = [];
for (const [id, place] of Object.entries(RIG)) {
  const f = byId[id];
  const [x, y, z] = place.pos;
  if (f.profile === 'tube') {
    const tube = new CobTube(f);
    tube.group.position.set(x, y + 0.02 + 0.03 + 1, z);   // foot, end cap, half the tube
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, 0.02, 24), new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.6 }));
    foot.position.set(x, y + 0.01, z);
    scene.add(tube.group, foot);
    bars.push(tube);
  } else if (f.profile === 'pixelBar') {
    const bar = new LedBar(f, { horizontal: place.horizontal });
    bar.group.position.set(x, y, z);
    scene.add(bar.group);
    bars.push(bar);
  } else {
    const head = new BeamHead(f);
    head.group.position.set(...place.pos);
    scene.add(head.group);
    heads.push(head);
  }
}

// ── models & band ───────────────────────────────────────────────────────────

const loader = new GLTFLoader();
const box = new THREE.Box3(), v = new THREE.Vector3();

// Returns a group whose origin is the model's bottom-centre (or its middle, for things people hold).
function fit(gltfScene, spec) {
  const wrap = new THREE.Group();
  const m = gltfScene;
  m.rotation.set(...spec.rot.map(THREE.MathUtils.degToRad));
  wrap.add(m);
  wrap.updateMatrixWorld(true);
  box.setFromObject(m).getSize(v);
  const s = spec.height ? spec.height / v.y : spec.width ? spec.width / v.x : spec.length / Math.max(v.x, v.y, v.z);
  m.scale.multiplyScalar(s);
  wrap.updateMatrixWorld(true);
  box.setFromObject(m);
  const c = box.getCenter(new THREE.Vector3());
  m.position.sub(new THREE.Vector3(c.x, spec.center ? c.y : box.min.y, c.z));
  m.traverse(o => { if (o.isMesh) { o.material.side = THREE.FrontSide; } });
  return wrap;
}

async function loadModels() {
  const entries = await Promise.all(Object.entries(MODELS).map(async ([key, spec]) => {
    const gltf = await loader.loadAsync(`./models/${spec.file}`);
    return [key, fit(gltf.scene, spec)];
  }));
  return Object.fromEntries(entries);
}

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

// Each member is a card standing on the stage: their full-body picture from players/<id>.png
// (green screen or transparent) when we have one, otherwise cut out of the band photo with their ghost mask.
async function loadBand() {
  const photo = await loadImage('../assets/band-2026-720.jpg');
  return Promise.all(BAND.map(async member => {
    const player = await loadImage(`./players/${member.id}.png`).catch(() => null);
    const cut = player ? keyOut(player) : cutFromPhoto(photo, await loadImage(`../assets/ghost-${member.id}.png`));

    const tex = new THREE.CanvasTexture(cut);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const height = player ? member.full : member.h, width = height * (cut.width / cut.height);
    const geo = new THREE.PlaneGeometry(width, height);
    geo.translate(0, height / 2, 0);
    const card = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 0.85, side: THREE.DoubleSide }));
    const holder = new THREE.Group();
    holder.position.set(...member.pos);
    holder.add(card);
    scene.add(holder);
    const px = cut.getContext('2d').getImageData(0, 0, cut.width, cut.height).data;
    const alpha = new Uint8Array(cut.width * cut.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = px[i * 4 + 3];
    return { ...member, holder, card, full: !!player, alpha: { data: alpha, w: cut.width, h: cut.height } };
  }));
}

function cutFromPhoto(photo, mask) {
  const W = photo.naturalWidth, H = photo.naturalHeight;
  const work = document.createElement('canvas'); work.width = W; work.height = H;
  const ctx = work.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(mask, 0, 0, W, H);
  const [x0, y0, cw, ch] = alphaBox(ctx.getImageData(0, 0, W, H));
  const cut = document.createElement('canvas'); cut.width = cw; cut.height = ch;
  const cx = cut.getContext('2d');
  cx.drawImage(photo, x0, y0, cw, ch, 0, 0, cw, ch);
  cx.globalCompositeOperation = 'destination-in';
  cx.drawImage(mask, (x0 / W) * mask.width, (y0 / H) * mask.height, (cw / W) * mask.width, (ch / H) * mask.height, 0, 0, cw, ch);
  return cut;
}

// Green screen → alpha (with the green spill pulled off the edges), cropped to the person.
function keyOut(img) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  const id = x.getImageData(0, 0, w, h), d = id.data;
  let transparent = false;
  for (let i = 3; i < d.length; i += 4 * 97) if (d[i] < 250) { transparent = true; break; }
  if (!transparent) {
    for (let i = 0; i < d.length; i += 4) {
      const spill = d[i + 1] - Math.max(d[i], d[i + 2]);
      if (spill <= 0) continue;
      const k = Math.min(1, Math.max(0, (spill - 25) / 65));
      d[i + 3] = 255 * (1 - k * k * (3 - 2 * k));
      d[i + 1] = Math.max(d[i], d[i + 2]);
    }
  }
  // drop the faint glow some generated cut-outs carry, so mipmaps don't smear a light fringe round the edges
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] < 100) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; }
  x.putImageData(id, 0, 0);
  const [x0, y0, cw, ch] = alphaBox(id);
  const cut = document.createElement('canvas'); cut.width = cw; cut.height = ch;
  cut.getContext('2d').drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
  return cut;
}

function alphaBox({ data, width: W, height: H }) {
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (data[(y * W + x) * 4 + 3] > 100) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

// where the players were dragged to last time (kept in this browser only)
const LAYOUT_KEY = 'owashi-sim:layout';
const HOME = Object.fromEntries(BAND.map(m => [m.id, [...m.pos]]));
try {
  const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {};
  for (const m of BAND) if (Array.isArray(saved[m.id])) m.pos = [saved[m.id][0], S, saved[m.id][1]];
} catch { /* private window or blocked storage: start from the default layout */ }

const [models, band] = await Promise.all([loadModels(), loadBand()]);

for (const p of PROPS) {
  const m = models[p.model].clone();
  m.position.set(...p.pos);
  m.rotation.y = THREE.MathUtils.degToRad(p.rotY || 0);
  scene.add(m);
}
for (const m of band) {
  if (m.full || !m.holds) continue;   // full-body pictures bring their own instrument
  const inst = models[m.holds.model].clone();
  inst.position.set(...m.holds.at);
  inst.rotation.z = THREE.MathUtils.degToRad(m.holds.rotZ);
  m.holder.add(inst);   // so it follows them when they're moved
}
document.querySelector('.loading').classList.add('done');
window.sim = { scene, camera, controls, renderer, composer, models, band, show, universes };   // handy from the console

// ── UI ──────────────────────────────────────────────────────────────────────

const $ = s => document.querySelector(s);
const ui = { haze: 0.8, fill: 0.45 };

function button(label, key, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (key) { const k = document.createElement('kbd'); k.textContent = key; b.append(k); }
  b.addEventListener('click', onClick);
  return b;
}

const clock = new THREE.Clock();

const sceneButtons = SCENE_LIST.map(([id, label, key]) => {
  const b = button(label, key, () => setScene(id));
  b.dataset.scene = id;
  $('.scenes').append(b);
  return b;
});
function setScene(id) {
  cue(id, clock.elapsedTime);
  sceneButtons.forEach(b => b.setAttribute('aria-pressed', b.dataset.scene === id));
  setlist.recordLook(id);
}
setScene(show.scene);

const swatchButtons = [];
for (const slot of ['A', 'B']) {
  const lab = document.createElement('b'); lab.textContent = slot; $('.swatches').append(lab);
  for (const [name, { rgb }] of Object.entries(PALETTE)) {
    const b = document.createElement('button');
    b.className = 'swatch'; b.title = `${slot}: ${name}`; b.setAttribute('aria-label', `Colour ${slot}: ${name}`);
    b.style.setProperty('--c', `rgb(${rgb.join(',')})`);
    b.dataset.slot = slot; b.dataset.name = name;
    b.addEventListener('click', () => { show['color' + slot] = name; syncSwatches(); });
    $('.swatches').append(b);
    swatchButtons.push(b);
  }
}
function syncSwatches() { swatchButtons.forEach(b => b.setAttribute('aria-pressed', show['color' + b.dataset.slot] === b.dataset.name)); }
syncSwatches();

$('.tap').addEventListener('click', () => { tap(clock.elapsedTime); $('.bpm').textContent = show.bpm; setlist.onTap(); });

setlist.configure({
  now: () => clock.elapsedTime,
  onApplied() {   // a cue changed the look: bring the buttons along
    sceneButtons.forEach(b => b.setAttribute('aria-pressed', b.dataset.scene === show.scene));
    syncSwatches();
    $('.bpm').textContent = show.bpm;
  },
});
mountSetlist(document.getElementById('setlist-root'));
setlist.loadSongs();
const toggleSetlist = () => { setlist.open.value = !setlist.open.value; };
$('.setlist-toggle').addEventListener('click', toggleSetlist);
effect(() => {   // opening or closing the setlist: update its button, and move the stage over once it's drawn
  $('.setlist-toggle').setAttribute('aria-pressed', setlist.open.value);
  setTimeout(resize);
});
window.sim.setlist = setlist;
const flashBtn = $('.flash');
const setFlash = on => { show.flash = on; flashBtn.setAttribute('aria-pressed', on); };
flashBtn.addEventListener('pointerdown', () => setFlash(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) flashBtn.addEventListener(ev, () => setFlash(false));
$('.hit').addEventListener('pointerdown', () => hit(clock.elapsedTime));

$('.master').addEventListener('input', e => { show.master = +e.target.value; });
$('.haze').addEventListener('input', e => { ui.haze = +e.target.value; });
$('.fill').addEventListener('input', e => { ui.fill = +e.target.value; });

let flight = null;
const viewButtons = Object.keys(VIEWS).map(name => {
  const b = button(name, null, () => flyTo(name));
  b.dataset.view = name;
  $('.views').append(b);
  return b;
});
function flyTo(name) {
  const to = VIEWS[name];
  flight = { t: 0, fromPos: camera.position.clone(), fromLook: controls.target.clone(), toPos: new THREE.Vector3(...to.pos), toLook: new THREE.Vector3(...to.look) };
  viewButtons.forEach(b => b.setAttribute('aria-pressed', b.dataset.view === name));
}
viewButtons[0].setAttribute('aria-pressed', true);
controls.addEventListener('start', () => { flight = null; viewButtons.forEach(b => b.setAttribute('aria-pressed', false)); });

const dmxPanel = $('.dmx');
const toggleDmx = () => { dmxPanel.hidden = !dmxPanel.hidden; $('.dmx-toggle').setAttribute('aria-pressed', !dmxPanel.hidden); };
$('.dmx-toggle').addEventListener('click', toggleDmx);
$('.hide').addEventListener('click', toggleUi);
$('.credits-open').addEventListener('click', () => $('dialog.credits').showModal());

addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea, dialog') || e.metaKey || e.ctrlKey) return;
  if (e.repeat) { if (e.code === 'Space') e.preventDefault(); return; }
  const s = SCENE_LIST.find(([, , key]) => key === e.key);
  if (s) setScene(s[0]);
  else if (e.code === 'Space') { e.preventDefault(); setFlash(true); }
  else if (e.key === 'Enter') { e.preventDefault(); hit(clock.elapsedTime); }
  else if (e.key === 't' || e.key === 'T') $('.tap').click();
  else if (e.key === 'd' || e.key === 'D') toggleDmx();
  else if (e.key === 'l' || e.key === 'L') toggleSetlist();
  else if (e.key === 'p' || e.key === 'P') setlist.playPause();
  else if (e.key === 'r' || e.key === 'R') setlist.toggleRecord();
  else if (e.key === 'ArrowRight' || e.key === 'g' || e.key === 'G') { e.preventDefault(); setlist.go(); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); setlist.back(); }
  else if (e.key === 'h' || e.key === 'H') toggleUi();
  else if (e.key === 'v' || e.key === 'V') {
    const names = Object.keys(VIEWS), cur = viewButtons.findIndex(b => b.getAttribute('aria-pressed') === 'true');
    flyTo(names[(cur + 1) % names.length]);
  }
});
addEventListener('keyup', e => { if (e.code === 'Space') { e.preventDefault(); setFlash(false); } });

// ── placing the players ─────────────────────────────────────────────────────
// Drag a guitar player (or the ring at their feet) to move them around the deck.

const movers = band.filter(m => ['fab', 'cyril', 'olivier'].includes(m.id));
for (const m of movers) {
  m.ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.34, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }));
  m.pad = new THREE.Mesh(new THREE.CircleGeometry(0.34, 32).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));   // invisible, just a bigger target
  m.ring.position.y = m.pad.position.y = 0.006;
  m.holder.add(m.ring, m.pad);
}

const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2(), onFloor = new THREE.Vector3();
const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -S);
const placeTag = $('.place');
let drag = null, hovered = null, placeTimer = 0;

function aimRay(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
}
function playerUnder(e) {
  if (document.body.classList.contains('hide-ui')) return null;
  aimRay(e);
  for (const hit of raycaster.intersectObjects(movers.flatMap(m => [m.pad, m.card]), false)) {
    const m = movers.find(p => p.pad === hit.object || p.card === hit.object);
    if (hit.object === m.pad) return m;
    const { data, w, h } = m.alpha;   // only the person counts, not the empty corners of their picture
    const x = Math.min(w - 1, Math.floor(hit.uv.x * w)), y = Math.min(h - 1, Math.floor((1 - hit.uv.y) * h));
    if (data[y * w + x] > 100) return m;
  }
  return null;
}
function setHover(m) {
  if (m === hovered) return;
  if (hovered) hovered.ring.material.opacity = 0.3;
  hovered = m;
  if (m) m.ring.material.opacity = 0.9;
  canvas.style.cursor = m ? 'grab' : '';
}
function showPlace(m) {
  const { x, z } = m.holder.position;
  const side = Math.abs(x) < 0.05 ? 'centre' : `${Math.abs(x).toFixed(1)} m ${x < 0 ? 'left' : 'right'} of centre`;
  placeTag.textContent = `${m.id[0].toUpperCase() + m.id.slice(1)} · ${side} · ${(DECK.front - z).toFixed(1)} m from the front edge`;
  placeTag.classList.add('on');
  clearTimeout(placeTimer);
}
function saveLayout() {
  const layout = Object.fromEntries(band.map(m => [m.id, [+m.holder.position.x.toFixed(2), +m.holder.position.z.toFixed(2)]]));
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* fine, it just won't be remembered */ }
}

// capture phase: runs before OrbitControls' own listener, so switching it off here keeps the camera still
canvas.addEventListener('pointerdown', e => {
  const m = playerUnder(e);
  if (!m || !raycaster.ray.intersectPlane(floor, onFloor)) return;
  controls.enabled = false;
  canvas.setPointerCapture(e.pointerId);
  drag = { m, id: e.pointerId, dx: m.holder.position.x - onFloor.x, dz: m.holder.position.z - onFloor.z };
  setHover(m);
  canvas.style.cursor = 'grabbing';
  showPlace(m);
}, { capture: true });

canvas.addEventListener('pointermove', e => {
  if (drag && e.pointerId === drag.id) {
    aimRay(e);
    if (!raycaster.ray.intersectPlane(floor, onFloor)) return;
    const p = drag.m.holder.position;
    p.x = Math.min(DECK.w / 2 - 0.3, Math.max(-DECK.w / 2 + 0.3, onFloor.x + drag.dx));
    p.z = Math.min(DECK.front - 0.2, Math.max(DECK.front - DECK.d + 0.35, onFloor.z + drag.dz));
    showPlace(drag.m);
  } else if (e.pointerType === 'mouse' && e.buttons === 0) {
    setHover(playerUnder(e));
  }
});

const endDrag = e => {
  if (!drag || e.pointerId !== drag.id) return;
  drag = null;
  controls.enabled = true;
  canvas.style.cursor = hovered ? 'grab' : '';
  if (e.pointerType !== 'mouse') setHover(null);
  saveLayout();
  placeTimer = setTimeout(() => placeTag.classList.remove('on'), 1800);
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

$('.reset-layout').addEventListener('click', () => {
  for (const m of band) m.holder.position.set(...HOME[m.id]);
  try { localStorage.removeItem(LAYOUT_KEY); } catch { /* nothing stored */ }
});

// ── the real rig, over Art-Net ──────────────────────────────────────────────

const artnetButtons = [...document.querySelectorAll('[data-artnet]')];
artnetButtons.forEach(b => b.addEventListener('click', () => setMode(b.dataset.artnet)));
const artnetDot = $('.artnet .dot'), artnetStatus = $('.artnet-status');

function artnetText() {
  const found = artnet.nodes.length ? ` · found ${artnet.nodes.map(n => n.name || n.ip).join(', ')}` : '';
  if (artnet.mode === 'off') return "The sim isn't talking to the real lights.";
  if (artnet.state === 'connecting') return 'Connecting to the bridge…';
  if (artnet.state === 'offline') return 'Bridge not running — start it with: node sim/bridge/artnet-bridge.mjs';
  if (artnet.mode === 'send') return `Live: the real lights follow the sim${found}`;
  if (!artnet.receiving) return "The bridge can't listen on port 6454 — another app on this computer has it.";
  const fresh = artnet.lastIn && performance.now() - artnet.lastIn < 2000;
  return (fresh ? 'Mirroring the desk' : 'Waiting for Art-Net from a desk…') + found;
}
function syncArtnet() {
  artnetButtons.forEach(b => b.setAttribute('aria-pressed', b.dataset.artnet === artnet.mode));
  artnetDot.dataset.state = artnet.mode === 'off' ? 'off' : artnet.state;
  artnetStatus.textContent = artnetText();
  artnetStatus.title = artnet.routes.map(r => `U${r.sim} → Art-Net universe ${r.artnet} → ${r.to}`).join('\n');
  document.body.classList.toggle('mirroring', artnet.mode === 'mirror');
}
artnet.onChange = syncArtnet;
syncArtnet();

// ── DMX monitor ─────────────────────────────────────────────────────────────

const mon = dmxPanel.querySelector('canvas'), mctx = mon.getContext('2d');
const COLS = 32, CELL = 10;
let shownU = 0;
const uButtons = universes.map((_, i) => {
  const b = button(`U${i + 1}`, null, () => { shownU = i; syncMonitor(); });
  $('.dmx .universes').append(b);
  return b;
});
function syncMonitor() {
  uButtons.forEach((b, i) => b.setAttribute('aria-pressed', i === shownU));
  $('.patch').innerHTML = PATCH.filter(p => p.universe === shownU + 1).map(p => {
    const n = PROFILES[p.profile].channels.length;
    return `<li>${p.id} · ${String(p.address).padStart(3, '0')}–${String(p.address + n - 1).padStart(3, '0')} · ${PROFILES[p.profile].name}</li>`;
  }).join('');
}
syncMonitor();

function drawMonitor() {
  const universe = universes[shownU], channelMap = channelMaps[shownU];
  mctx.fillStyle = '#0b0b0c';
  mctx.fillRect(0, 0, mon.width, mon.height);
  for (let i = 0; i < 512; i++) {
    const x = (i % COLS) * CELL, y = Math.floor(i / COLS) * CELL, owner = channelMap[i];
    const k = universe[i] / 255;
    let c;
    if (!owner) c = 'rgba(243,242,238,.04)';
    else if (/ R$/.test(owner.channel)) c = `rgb(${40 + 215 * k},${20 * (1 - k)},${20 * (1 - k)})`;
    else if (/ G$/.test(owner.channel)) c = `rgb(${20 * (1 - k)},${40 + 215 * k},${20 * (1 - k)})`;
    else if (/ B$/.test(owner.channel)) c = `rgb(${20 * (1 - k)},${30 * (1 - k)},${50 + 205 * k})`;
    else if (owner.fixture.profile === 'lb150') c = `rgb(${50 + 205 * k},${35 + 150 * k},${20 + 60 * k})`;
    else c = `rgb(${40 + 215 * k},${40 + 215 * k},${40 + 210 * k})`;
    mctx.fillStyle = c;
    mctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
  }
}
let hoverCh = -1;
mon.addEventListener('pointermove', e => {
  const r = mon.getBoundingClientRect();
  const cx = Math.floor(((e.clientX - r.left) / r.width) * COLS), cy = Math.floor(((e.clientY - r.top) / r.height) * 16);
  hoverCh = cy * COLS + cx;
});
mon.addEventListener('pointerleave', () => { hoverCh = -1; });

// ── loop ────────────────────────────────────────────────────────────────────

const beatDot = $('.beat');
const buildBtn = $('[data-scene=build]');
let frames = 0, fpsT = 0;

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;

  setlist.tick();   // a song that's playing moves the cues (and the tempo grid) along
  // mirroring a desk: the show stays out of the universes, the desk fills them
  const beat = artnet.mode === 'mirror' ? (t - show.beat0) * show.bpm / 60 : updateShow(t);
  pump(performance.now());

  for (const bar of bars) bar.update(t);
  for (const head of heads) head.update(t, dt, camera, ui.haze);
  fill.intensity = ui.fill * 260;

  // the four of you turn towards the camera (but never your backs), with a little nod on the beat
  const nod = Math.exp(-(beat % 1) * 6);
  const uiShown = !document.body.classList.contains('hide-ui');
  for (const m of movers) m.ring.visible = uiShown;
  for (const m of band) {
    const yaw = Math.atan2(camera.position.x - m.holder.position.x, camera.position.z - m.holder.position.z);
    m.holder.rotation.y = Math.max(-1.2, Math.min(1.2, yaw));
    m.card.scale.y = 1 - (show.scene === 'blackout' ? 0 : 0.012 * nod);
  }

  if (flight) {
    flight.t = Math.min(1, flight.t + dt / 1.2);
    const e = flight.t < 0.5 ? 4 * flight.t ** 3 : 1 - (-2 * flight.t + 2) ** 3 / 2;
    camera.position.lerpVectors(flight.fromPos, flight.toPos, e);
    controls.target.lerpVectors(flight.fromLook, flight.toLook, e);
    if (flight.t === 1) flight = null;
  }
  controls.update();
  composer.render();

  beatDot.style.opacity = 0.15 + 0.85 * nod;
  buildBtn.style.setProperty('--p', show.scene === 'build' ? buildProgress(t) : 0);
  if (!dmxPanel.hidden) {
    drawMonitor();
    const owner = channelMaps[shownU][hoverCh];
    dmxPanel.querySelector('.hover').textContent = hoverCh >= 0
      ? `U${shownU + 1} ch ${hoverCh + 1} · ${owner ? `${owner.fixture.id} ${owner.channel}` : 'unpatched'} · ${universes[shownU][hoverCh]}`
      : 'hover a channel';
  }
  frames++;
  if (t - fpsT > 1) {
    dmxPanel.querySelector('.fps').textContent = `${frames} fps`; frames = 0; fpsT = t;
    if (artnet.mode === 'mirror') syncArtnet();
  }
});
