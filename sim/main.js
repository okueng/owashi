import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { byId, channelMaps, LB150_WHEEL, PATCH, PROFILES, universes } from './dmx.js';
import { beamHit, cue, hit, lookProgress, PALETTE, SCENE_LIST, setHeadWalls, show, tap, tubeHit, updateShow } from './show.js';
import { BeamHead, CobTube, setBeamStops, WashPar } from './fixtures.js';
import { artnet, bridgeUrl, pump, setMode } from './artnet.js';
import { effect } from '@preact/signals';
import * as setlist from './setlist.js';
import { mountSetlist } from './setlist-ui.js';
import { createLabels } from './labels.js';
import { actions as pedalActions, ANAGRAM_LABEL, ANAGRAM_SCENES, anagramTarget, bridgeListeners, connect as connectPedal, connectBridge, connectIfAllowed, learnPads, PAD_COUNT, pedal, sendAnagramScene, setAnagram, SMC_PAD_POCKET } from './pedal.js';
import { inputs, onBridgeMessage, ROLES, setRole } from './inputs.js';
import { configure as configureLive, live, setDarkOnStop, setStopFloor, tick as liveTick } from './live.js';

// ── layout (metres; x = stage left→right as the audience sees it, z = towards the audience) ──
// The rig is placed for the audience's sightlines and the beams' distance from the band's eyes. The room is the
// December 2026 venue as read from photos of last year's concert there: the band plays on the floor (no riser) in
// a black-curtained alcove under a low white ceiling, with the room's own rig on a bar over the audience. Every
// size here is an estimate from those photos: measure the room and change DECK and ROOM.

const DECK = { w: 5, d: 3.5, h: 0, front: 1.0 };      // the playing area, on the floor: z = -2.5 to z = +1.0
const S = DECK.h;
const KIT_Z = -1.0;                                    // drums on the rug, no riser

// On 4 m the kit and the 2 m banner fill the middle, which leaves about 95 cm each side at the back. So each
// back corner carries two heads side by side with a tube between them, a little in front.
const RIG = {
  // two tubes framing the band at the stage edges, two at the back between the heads
  V1: { pos: [-1.9, S, 0.3] }, V2: { pos: [-1.54, S, -1.95] }, V3: { pos: [1.54, S, -1.95] }, V4: { pos: [1.9, S, 0.3] },
  // (the two horizontal floor bars at the stage front are out for now; they sat at the front edge, raise 0.05)
  // behind everyone, so nobody faces them, and on low cases to keep the beams clear of the amps and above eye level
  B1: { pos: [-1.78, S, -2.25], riser: 0.5 }, B2: { pos: [1.78, S, -2.25], riser: 0.5 },
  // the second pair: on the floor just outside the banner (no stands, nothing flown). Beams read brightest coming
  // towards the audience through the haze, so all four stay at the back. With the heads kept at least 45° above
  // the horizontal, a beam from the floor still clears an amp half a metre in front of it and passes about 3 m
  // above the front players, so a case under them only shows a little more of the beam's foot.
  B3: { pos: [-1.3, S, -2.25], riser: 0 }, B4: { pos: [1.3, S, -2.25], riser: 0 },
  // two wash PARs on the floor behind the kit, either side of the drummer and under the banner, leaning 60° from
  // straight up towards the room: through the kit, onto the front players' backs, then over the audience's heads
  P1: { pos: [-0.6, S, -2.05], tilt: 60 }, P2: { pos: [0.6, S, -2.05], tilt: 60 },
};

// The trio, left to right as the audience sees it: Cyril, Romain (back), Olivier. Where Cyril stands now that he
// is the only guitar is a guess (opposite Olivier); drag him.
// full = height in metres of the full-body picture in players/<id>.webp (Romain's is seated); h and holds are for
// the fallback cut-outs from the band photo (assets/band-2026-720.jpg + the ghost masks), with a low-poly instrument.
const BAND = [
  { id: 'cyril', full: 1.8, h: 1.78, pos: [-1.1, S, 0.35], holds: { model: 'guitarA', at: [0.02, 0.98, 0.16], rotZ: -62 } },
  { id: 'romain', full: 1.3, h: 1.36, pos: [0, S, KIT_Z - 0.42] },   // on the throne, behind the kit
  { id: 'olivier', full: 1.8, h: 1.82, pos: [1.1, S, 0.35], holds: { model: 'bass', at: [0.02, 1.0, 0.16], rotZ: -62 } },
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
  { model: 'guitarAmp', pos: [-1.45, S, -1.45], rotY: 15 },
  { model: 'bassAmp', pos: [1.45, S, -1.45], rotY: -15 },
];

// all inside the room: the back wall is at z = 6.5 and the ceiling at 2.8 m
const VIEWS = {
  FOH: { pos: [0, 1.7, 6.2], look: [0, 1.3, -0.8] },
  Pit: { pos: [-1.4, 1.1, 3.0], look: [0.2, 1.7, -1] },
  Side: { pos: [2.6, 1.9, 3.4], look: [-0.6, 1.2, -1.2] },
  Corner: { pos: [-2.2, 1.75, 5.6], look: [0.3, 1.3, -1.2] },
  // where the cameras go at the gig: the 360 on a stand centre stage in front of the kick, the phone at the back
  '360°': { pos: [0, 1.6, 0.4], look: [0, 1.5, -1.6] },
  Phone: { pos: [0, 2.0, 6.3], look: [0, 1.2, -1.0] },
};

// ── renderer ────────────────────────────────────────────────────────────────

const canvas = document.querySelector('canvas.stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
let pixelRatio = Math.min(devicePixelRatio, 1.5);   // stepped down by the loop if the device can't keep up
renderer.setPixelRatio(pixelRatio);
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

// Widen the lens on tall screens, and lift the stage clear of whatever covers the bottom of the screen
// (the control panel; on phones also the tab bar and the setlist, which docks at the bottom there).
const panel = document.querySelector('.panel');
const narrow = matchMedia('(max-width: 640px)');
const shown = el => el && el.getBoundingClientRect().height > 0;
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = Math.min(72, 42 * Math.max(1, 1.3 / camera.aspect));
  const drawer = document.querySelector('.setlist');
  const bottom = [panel, narrow.matches && drawer].filter(shown);
  const covered = document.body.classList.contains('hide-ui') ? 0 : Math.max(0, ...bottom.map(el => h - el.getBoundingClientRect().top));
  document.documentElement.style.setProperty('--panel-h', `${shown(panel) ? h - panel.getBoundingClientRect().top : 0}px`);
  // on wide screens the setlist sits on the right: slide the stage left of it
  const side = drawer && !drawer.hidden && covered && w > 900 ? (drawer.getBoundingClientRect().width + 16) / 2 : 0;
  camera.setViewOffset(w, h, side, Math.min(covered, h * 0.5) / 2, w, h);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
new ResizeObserver(resize).observe(panel);
resize();
const toggleUi = () => { document.body.classList.toggle('hide-ui'); resize(); };

// ── room & deck ─────────────────────────────────────────────────────────────

// The alcove (5 m wide, black walls and curtain, acoustic panels hung at 2.6 m under a 2.8 m ceiling) opens onto
// the audience room (6 m wide, white walls, white ceiling at 2.8 m) under a white soffit that hangs to 2.4 m, with
// a black duct along it that turns towards the audience on the right. At the back right, three steps lead up to a
// doorway behind the curtain. The room's own lights hang from a bar over the front of the audience: drawn, never
// lit (we don't drive them). Glass double doors at the back of the room, a counter and a glowing cube on the left.
const ROOM = {
  w: 6, alcoveW: 5, back: DECK.front - DECK.d - 0.05, front: 6.5, h: 2.8, stageH: 2.6,
  soffit: { z: 0.6, d: 0.35, bottom: 2.4 }, houseBar: { z: 2.0, y: 2.68 },
};
ROOM.lip = ROOM.soffit.z + ROOM.soffit.d;   // where the alcove opens into the room
{
  const tex = (w, h, paint) => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    paint(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  };
  const rnd = n => { const v = Math.sin(n * 91.7 + 47.3) * 43758.5453; return v - Math.floor(v); };
  const mat = (color, roughness, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, ...extra });
  const plane = (w, h, material, pos, rot) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    m.position.set(...pos); m.rotation.set(...rot);
    scene.add(m);
    return m;
  };
  const block = (size, material, pos) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    m.position.set(...pos);
    scene.add(m);
    return m;
  };
  const pipeMesh = (a, b, r, material) => {   // a cylinder from point a to point b
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), d = B.clone().sub(A);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 16), material);
    m.position.copy(A).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    scene.add(m);
    return m;
  };
  const box3 = (x0, y0, z0, x1, y1, z1) => new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  const stops = [];   // the solid things a beam can't pass
  const W = ROOM.w, AW = ROOM.alcoveW, H = ROOM.h, lip = ROOM.lip, hall = ROOM.front - lip, alcove = lip - ROOM.back;

  // dark grey vinyl tiles, 50 cm
  const tiles = tex(512, 512, (x, w, h) => {
    x.fillStyle = '#2c2c2f'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      x.fillStyle = `rgba(255,255,255,${0.01 + rnd(i * 4 + j) * 0.025})`; x.fillRect(i * 128 + 2, j * 128 + 2, 124, 124);
    }
  });
  const L = ROOM.front - ROOM.back;
  tiles.wrapS = tiles.wrapT = THREE.RepeatWrapping; tiles.repeat.set(W / 2, L / 2);
  plane(W, L, mat(0xffffff, 0.42, { map: tiles, metalness: 0.08 }), [0, 0, (ROOM.front + ROOM.back) / 2], [-Math.PI / 2, 0, 0]);

  // the Persian rug under the drums
  const rug = tex(1024, 768, (x, w, h) => {
    x.fillStyle = '#5e1712'; x.fillRect(0, 0, w, h);
    x.strokeStyle = '#1c2340'; x.lineWidth = 46; x.strokeRect(40, 40, w - 80, h - 80);
    x.strokeStyle = '#b08a55'; x.lineWidth = 6; x.strokeRect(70, 70, w - 140, h - 140); x.strokeRect(14, 14, w - 28, h - 28);
    for (let i = 0; i < 900; i++) {
      x.fillStyle = ['#8a2a1c', '#1c2340', '#b08a55', '#3a0e0b'][i % 4];
      x.globalAlpha = 0.35; x.fillRect(100 + rnd(i) * (w - 200), 100 + rnd(i + 0.5) * (h - 200), 6 + rnd(i + 2) * 14, 4 + rnd(i + 3) * 8);
    }
    x.globalAlpha = 1; x.fillStyle = '#1c2340';
    x.beginPath(); x.ellipse(w / 2, h / 2, 150, 110, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#b08a55'; x.beginPath(); x.ellipse(w / 2, h / 2, 60, 42, 0, 0, Math.PI * 2); x.fill();
  });
  plane(3.0, 2.25, mat(0xffffff, 0.95, { map: rug }), [0, 0.004, KIT_Z - 0.25], [-Math.PI / 2, 0, 0]);

  // walls: black curtain across the back and black alcove sides, white from the soffit forward
  const curtain = tex(1024, 256, (x, w, h) => {
    x.fillStyle = '#0d0d10'; x.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      const fx = (i + rnd(i) * 0.6) * (w / 60), g = x.createLinearGradient(fx - 9, 0, fx + 9, 0);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.5, 'rgba(255,255,255,0.05)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g; x.fillRect(fx - 9, 0, 18, h);
    }
  });
  const black = mat(0xffffff, 0.97, { map: curtain }), white = mat(0xd9d9d6, 0.9), ceiling = mat(0xe4e4e0, 0.95);
  plane(AW, H, black, [0, H / 2, ROOM.back], [0, 0, 0]);
  // the alcove's sides; on the right, a doorway near the back at the top of the steps
  const STEPS = { x: 2.0, rise: 0.18, fronts: [-1.35, -1.65, -1.95] }, DOOR = { z0: -2.45, z1: -1.6, top: 2.45 };
  const doorBottom = STEPS.rise * STEPS.fronts.length;
  const wallX = side => side * AW / 2;
  plane(alcove, H, black, [wallX(-1), H / 2, ROOM.back + alcove / 2], [0, Math.PI / 2, 0]);
  const rightWall = (z0, z1, y0, y1) => plane(z1 - z0, y1 - y0, black, [wallX(1), (y0 + y1) / 2, (z0 + z1) / 2], [0, -Math.PI / 2, 0]);
  rightWall(ROOM.back, DOOR.z0, 0, H);
  rightWall(DOOR.z1, lip, 0, H);
  rightWall(DOOR.z0, DOOR.z1, DOOR.top, H);
  rightWall(DOOR.z0, DOOR.z1, 0, doorBottom);
  // light from the corridor behind the doorway
  plane(DOOR.z1 - DOOR.z0, DOOR.top - doorBottom, new THREE.MeshBasicMaterial({ color: 0x4a4740 }),
    [wallX(1) + 0.35, (DOOR.top + doorBottom) / 2, (DOOR.z0 + DOOR.z1) / 2], [0, -Math.PI / 2, 0]);
  for (const s of [-1, 1]) block([0.02, DOOR.top - doorBottom, 0.35], black, [wallX(1) + 0.17, (DOOR.top + doorBottom) / 2, s < 0 ? DOOR.z0 : DOOR.z1]);
  // three steps up to it, against the right wall
  STEPS.fronts.forEach((z, i) => {
    const h = STEPS.rise * (i + 1), d = z - ROOM.back;
    block([AW / 2 - STEPS.x, h, d], mat(0x1a1a1c, 0.8), [(STEPS.x + AW / 2) / 2, h / 2, ROOM.back + d / 2]);
  });
  // the room is wider than the alcove: short white returns either side of the opening
  for (const side of [-1, 1]) {
    plane((W - AW) / 2, H, white, [side * (W + AW) / 4, H / 2, lip], [0, 0, 0]);
    plane(hall, H, white, [side * W / 2, H / 2, lip + hall / 2], [0, -side * Math.PI / 2, 0]);
    stops.push(side < 0 ? box3(-W / 2, 0, ROOM.back, -AW / 2, H, lip) : box3(AW / 2, 0, ROOM.back, W / 2, H, lip));
  }
  // the back wall of the room, with glass double doors
  plane(W, H, white, [0, H / 2, ROOM.front], [0, Math.PI, 0]);
  const glass = mat(0x1a2530, 0.15, { metalness: 0.4 });
  for (const dx of [-0.41, 0.41]) plane(0.78, 2.05, glass, [-0.4 + dx, 1.05, ROOM.front - 0.01], [0, Math.PI, 0]);

  // ceilings: the alcove's real ceiling with three acoustic panels hung below it (gaps between them), the soffit,
  // and the room's ceiling
  plane(AW, ROOM.soffit.z - ROOM.back, ceiling, [0, H, (ROOM.back + ROOM.soffit.z) / 2], [Math.PI / 2, 0, 0]);
  const PANEL_GAP = 0.15, panelD = (ROOM.soffit.z - ROOM.back - 0.1 - 2 * PANEL_GAP) / 3;
  for (let i = 0; i < 3; i++) {
    const z0 = ROOM.back + 0.05 + i * (panelD + PANEL_GAP);
    block([AW - 0.4, 0.04, panelD], ceiling, [0, ROOM.stageH, z0 + panelD / 2]);
    stops.push(box3(-(AW - 0.4) / 2, ROOM.stageH - 0.02, z0, (AW - 0.4) / 2, ROOM.stageH + 0.02, z0 + panelD));
  }
  plane(W, hall, ceiling, [0, H, lip + hall / 2], [Math.PI / 2, 0, 0]);
  block([AW, H - ROOM.soffit.bottom, ROOM.soffit.d], ceiling, [0, (H + ROOM.soffit.bottom) / 2, ROOM.soffit.z + ROOM.soffit.d / 2]);
  stops.push(box3(-AW / 2, ROOM.soffit.bottom, ROOM.soffit.z, AW / 2, H, lip));
  // the duct: along the soffit, then up and along the right-hand side towards the audience
  const ductMat = mat(0x101012, 0.5), DR = 0.075, dy = ROOM.soffit.bottom - 0.08, dz = lip - 0.1;
  pipeMesh([-AW / 2, dy, dz], [2.3, dy, dz], DR, ductMat);
  pipeMesh([2.3, dy, dz], [2.7, H - 0.2, lip + 0.35], DR, ductMat);
  pipeMesh([2.7, H - 0.2, lip + 0.35], [2.7, H - 0.2, 4.2], DR, ductMat);
  stops.push(box3(-AW / 2, dy - DR, dz - DR, 2.3, dy + DR, dz + DR), box3(2.6, H - 0.2 - DR, lip, 2.8, H, 4.2));

  // the PA tops on poles at the corners of the opening, and two wedges
  const gear = mat(0x18181a, 0.7);
  for (const side of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.6, 8), gear);
    pole.position.set(side * 2.25, 0.8, 0.55); scene.add(pole);
    block([0.42, 0.68, 0.38], gear, [side * 2.25, 1.94, 0.55]);
    const wedge = block([0.55, 0.32, 0.4], gear, [side * 1.1, 0.16, 1.25]);
    wedge.rotation.x = -0.45;
  }

  // the service counter on the audience's left, and the cube that glows by it
  block([0.6, 1.0, 1.8], mat(0x202022, 0.6), [-W / 2 + 0.3, 0.5, 2.4]);
  block([0.6, 0.6, 0.6], new THREE.MeshBasicMaterial({ color: 0x163a55 }), [-W / 2 + 0.45, 0.3, 1.2]);

  // the room's rig: moving heads and flat 7-LED PARs (JB Systems Plano Spot) alternating along one bar
  const { z: bz, y: by } = ROOM.houseBar;
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, W - 0.4, 10), mat(0x9a9a9e, 0.4, { metalness: 0.7 }));
  pipe.rotation.z = Math.PI / 2; pipe.position.set(0, by, bz);
  scene.add(pipe);
  stops.push(box3(-(W - 0.4) / 2, by - 0.03, bz - 0.03, (W - 0.4) / 2, H, bz + 0.03));
  for (let i = 0; i < 9; i++) {
    const x = -2.6 + i * 0.65;
    if (i % 2) {   // hanging moving head: base, yoke, head pointing down
      block([0.34, 0.13, 0.26], gear, [x, by - 0.09, bz]);
      for (const dx of [-0.13, 0.13]) block([0.04, 0.26, 0.12], gear, [x + dx, by - 0.28, bz]);
      block([0.21, 0.24, 0.22], gear, [x, by - 0.38, bz]);
      stops.push(box3(x - 0.17, by - 0.5, bz - 0.13, x + 0.17, by, bz + 0.13));
    } else {       // PAR in its bracket, tilted towards the stage
      const par = block([0.24, 0.2, 0.09], gear, [x, by - 0.17, bz]);
      par.rotation.x = -0.7;
      stops.push(box3(x - 0.12, by - 0.3, bz - 0.1, x + 0.12, by, bz + 0.1));
    }
  }
  // two lights in the alcove ceiling near the curtain
  block([0.3, 0.26, 0.3], gear, [-1.0, ROOM.stageH - 0.15, -1.9]);
  block([0.22, 0.2, 0.22], gear, [1.3, ROOM.stageH - 0.12, -2.0]);

  // the beams end where they hit the ceiling, the soffit, a wall or the house rig
  setBeamStops(box3(-W / 2, 0, ROOM.back, W / 2, H, ROOM.front), stops);
}

// The ŌWASHI banner: 2 × 1 m of black cloth with the logo printed in white, so it takes the colour of whatever
// light hits it. It hangs from a telescopic bar between two light stands (Ulanzi MT-89, 2 m at full height)
// just behind the kit, so its top edge is level with the tops of the tubes and its lower half sits behind the drummer.
const BANNER = { w: 2, h: 1, top: 2.0, z: -2.38, logoW: 1.8 };
const bannerCanvas = document.createElement('canvas');
bannerCanvas.width = 2048; bannerCanvas.height = Math.round(2048 * BANNER.h / BANNER.w);
const bannerTex = new THREE.CanvasTexture(bannerCanvas);
bannerTex.colorSpace = THREE.SRGBColorSpace;
bannerTex.anisotropy = 8;
const banner = new THREE.Mesh(new THREE.PlaneGeometry(BANNER.w, BANNER.h), new THREE.MeshStandardMaterial({ map: bannerTex, roughness: 0.95 }));
banner.position.set(0, S + BANNER.top - BANNER.h / 2, BANNER.z);
scene.add(banner);
{
  const metal = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.6, metalness: 0.5 });
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, BANNER.w + 0.12, 8), metal);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, S + BANNER.top + 0.012, BANNER.z);
  scene.add(bar);
  for (const side of [-1, 1]) {
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, BANNER.top, 8), metal);
    stand.position.set(side * (BANNER.w / 2 + 0.05), S + BANNER.top / 2, BANNER.z);
    scene.add(stand);
  }
}

async function paintBanner() {
  const c = bannerCanvas, x = c.getContext('2d'), W = c.width, H = c.height;
  const rnd = n => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
  x.fillStyle = '#0d0d0e';
  x.fillRect(0, 0, W, H);
  for (let i = 0; i < 14; i++) {   // soft vertical folds in the cloth
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
  x.drawImage(logo, (W - lw) / 2, (H - lh) / 2, lw, lh);
  x.globalAlpha = 1;
  bannerTex.needsUpdate = true;
}
paintBanner();

// house light: a little ambient so the room isn't a void, plus a front fill the slider controls
scene.add(new THREE.HemisphereLight(0x8899aa, 0x000000, 0.06));
const fill = new THREE.SpotLight(0xffe2c0, 0, 0, 0.42, 0.8, 2);
fill.position.set(0, 2.7, 6.8);
fill.target.position.set(0, 1.2, -0.5);
scene.add(fill, fill.target);

// ── fixtures ────────────────────────────────────────────────────────────────

const bars = [], heads = [], pars = [];
for (const [id, place] of Object.entries(RIG)) {
  const f = byId[id];
  const [x, y, z] = place.pos;
  if (f.profile === 'tube') {
    const tube = new CobTube(f);
    const standMat = new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.6 });
    if (place.raise) {
      tube.group.rotation.z = -Math.PI / 2;   // zone 1 ends up on the audience's left
      tube.group.position.set(x, y + place.raise, z);
      for (const dx of [-0.8, 0.8]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, place.raise, 10), standMat);
        post.position.set(x + dx, y + place.raise / 2, z);
        const base = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.09, 0.015, 20), standMat);
        base.position.set(x + dx, y + 0.0075, z);
        scene.add(post, base);
      }
      scene.add(tube.group);
    } else {
      tube.group.position.set(x, y + 0.02 + 0.03 + 1, z);   // foot, end cap, half the tube
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, 0.02, 24), standMat);
      foot.position.set(x, y + 0.01, z);
      scene.add(tube.group, foot);
    }
    bars.push(tube);
  } else if (f.profile === 'hexpar') {
    const par = new WashPar(f, place.tilt);
    par.group.position.set(x, y, z);
    scene.add(par.group);
    pars.push(par);
  } else {
    const head = new BeamHead(f);
    head.group.position.set(x, y + place.riser, z);
    scene.add(head.group);
    if (place.riser) {
      const flightCase = new THREE.Mesh(new THREE.BoxGeometry(0.4, place.riser, 0.4), new THREE.MeshStandardMaterial({ color: 0x151517, roughness: 0.6 }));
      flightCase.position.set(x, y + place.riser / 2, z);
      scene.add(flightCase);
    }
    heads.push(head);
  }
}
// the show keeps each head's outward beams off its own side wall: tell it how far that wall is and how high the lens is
scene.updateMatrixWorld();
setHeadWalls(Object.fromEntries(heads.map(h => {
  const p = h.beams.getWorldPosition(new THREE.Vector3());
  return [h.f.id, { wall: (p.z < ROOM.lip ? ROOM.alcoveW : ROOM.w) / 2 - Math.abs(p.x), lens: p.y }];
})));

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

async function loadModels(keys) {
  const entries = await Promise.all([...keys].map(async key => {
    const gltf = await loader.loadAsync(`./models/${MODELS[key].file}`);
    return [key, fit(gltf.scene, MODELS[key])];
  }));
  return Object.fromEntries(entries);
}

function loadImage(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

// Each member is a card standing on the stage: their full-body picture from players/<id>.webp
// (green screen or transparent) when we have one, otherwise cut out of the band photo with their ghost mask.
async function loadBand() {
  let photo = null;   // only fetched if someone has no picture
  return Promise.all(BAND.map(async member => {
    const player = await loadImage(`./players/${member.id}.webp`).catch(() => null);
    const cut = player ? keyOut(player)
      : cutFromPhoto(await (photo ??= loadImage('../assets/band-2026-720.jpg')), await loadImage(`../assets/ghost-${member.id}.png`));

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
  // a place saved on a wider stage is pulled back onto this one
  const onDeck = (x, z) => [Math.min(DECK.w / 2 - 0.3, Math.max(-DECK.w / 2 + 0.3, x)), S, Math.min(DECK.front - 0.2, Math.max(DECK.front - DECK.d + 0.35, z))];
  for (const m of BAND) if (Array.isArray(saved[m.id])) m.pos = onDeck(saved[m.id][0], saved[m.id][1]);
} catch { /* private window or blocked storage: start from the default layout */ }

// the drums and amps straight away; the low-poly instruments only for players without a picture
const [propModels, band] = await Promise.all([loadModels(new Set(PROPS.map(p => p.model))), loadBand()]);
const models = { ...propModels, ...(await loadModels(new Set(band.filter(m => !m.full && m.holds).map(m => m.holds.model)))) };

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

// One panel open at a time.
const SHEETS = ['.more-sheet', '.dmx', '.wheel', '.pedal', '.inputs'].map($);
const labelOf = id => SCENE_LIST.find(s => s[0] === id)[1];
function showOnly(el) {
  SHEETS.forEach(s => { s.hidden = s !== el; });
  $('.more-open').setAttribute('aria-pressed', !$('.more-sheet').hidden);
  if ($('.pedal').hidden && pedal.learning) { pedal.learning = null; pedal.onChange(); }
  if ($('.wheel').hidden && show.wheelTest) { show.wheelTest = null; syncWheel(); }
}
const toggleSheet = el => showOnly(el.hidden ? el : null);
canvas.addEventListener('pointerdown', () => showOnly(null));   // clicking the stage puts it all away

const toastEl = $('.toast');
let toastTimer = 0;
function toast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1800);
}

function button(label, key, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  if (key) { const k = document.createElement('kbd'); k.textContent = key; b.append(k); }
  b.addEventListener('click', onClick);
  return b;
}

const clock = new THREE.Clock();   // for drawing: how long since the last frame
// The show's own time. It has to keep running when the browser stops drawing, or the real lights would stall with it.
const showStart = performance.now();
const showTime = () => (performance.now() - showStart) / 1000;

const nextSong = () => { const l = setlist.songs.value, i = l.findIndex(x => x.id === setlist.songId.value); return i >= 0 ? l[i + 1] : null; };
// Show mode's readout: the song, where we are in it, what comes next, and a countdown to the next switch.
//
// The countdown runs on a song clock, not on the last press, so a press too many can't throw it off. The clock
// starts with the song's first cue and runs at the speed of the 15 Nov takes. A press near its cue's planned time
// (within a third of the gap before it) re-syncs it there: the live tempo drifts, so every on-time press corrects
// it. A press far from its time (a double press, a wrong section) leaves the clock alone, so it still knows where
// the band is, and the readout says the lights are ahead. Back never moves it: the countdown carries on.
const hudTimerEl = $('.hud-timer'), hudEtaEl = $('.hud-eta'), hudClockEl = $('.hud-clock'), hudSegsEl = $('.hud-segs');
const hudHeadEl = $('.hud-head'), hudDriftEl = $('.hud-drift');
let hudCueKey = '', hudCueT0 = 0, lastHudTick = -1, hudSegsKey = '';
// song position `pos` at show time `at`; `synced` is the cue it was last set to
const songClock = { id: '', running: false, at: 0, pos: 0, synced: -1 };
let cueMove = '';   // why the cue is about to change: 'next', 'back', or '' (a jump, a song change, the recording)
const fmtEta = sec => {
  const s = Math.max(0, Math.round(sec)), m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};
const isReadyCue = (c, i) => i === 0 && c.scene === 'blackout' && c.t === 0;   // dark, waiting for the band
// the energy curve's length, or just past the last cue if the curve stops before it (it can be from an older take)
const songLength = s => Math.max(s?.energy?.values?.length ? s.energy.values.length * s.energy.step : 0,
  (setlist.cues.value.at(-1)?.t ?? 0) + 5);
const following = () => setlist.follow.value && setlist.playing.value;   // a recording drives the cues
function songPos(t) {
  if (following()) return setlist.position();
  return songClock.running ? songClock.pos + (t - songClock.at) : null;
}
function anchorClock(i, pos, t) { Object.assign(songClock, { running: true, at: t, pos, synced: i }); }
// a cue just came on: start, re-sync or leave the song clock
function onCueChange(t) {
  const s = setlist.song.value, cues = setlist.cues.value, i = setlist.index.value, cur = cues[i];
  const move = cueMove; cueMove = '';
  if (songClock.id !== (s?.id || '')) Object.assign(songClock, { id: s?.id || '', running: false });
  if (!cur || isReadyCue(cur, i)) { songClock.running = false; return; }
  if (!songClock.running || move === '') return anchorClock(i, cur.t, t);
  // Back, or Next onto a cue the clock already passed through (after a Back): the clock was right, keep it
  if (move === 'back' || i <= songClock.synced) return;
  const pos = songPos(t), prev = cues[i - 1];
  const tolerance = Math.max(4, (cur.t - (prev?.t ?? 0)) / 3);
  if (Math.abs(pos - cur.t) <= tolerance) anchorClock(i, cur.t, t);
}
// which cue the clock says the band is in
const clockIndex = (cues, pos) => { let k = 0; while (k + 1 < cues.length && cues[k + 1].t <= pos) k++; return k; };
function updateCueProgress(t) {
  const cues = setlist.cues.value, i = setlist.index.value, cur = cues[i], next = cues[i + 1];
  const expected = cur && next ? next.t - cur.t : 0;
  const onCue = cur && show.scene === cur.scene && show.variant === cur.variant;
  if (!onCue || !next || expected < 2 || isReadyCue(cur, i)) {
    show.cueP = 0.5;   // neutral mid-arc in Manual mode or on ready/final cues
    return null;
  }
  const pos = songPos(t);
  const elapsed = Math.max(0, pos !== null ? pos - cur.t : t - hudCueT0);
  const p = Math.min(1, Math.max(0, elapsed / expected));
  show.cueP = p;
  return { expected, elapsed, p };
}
// the song as a strip of cues, each as long as it lasts
function drawSegments(s, cues) {
  const key = `${s?.id}:${cues.map(c => c.t).join(',')}`;
  if (key === hudSegsKey) return;
  hudSegsKey = key;
  const len = songLength(s);
  hudSegsEl.replaceChildren(...cues.map((c, k) => {
    const el = document.createElement('i');
    el.style.flexGrow = Math.max(0.1, (cues[k + 1]?.t ?? len) - c.t);
    return el;
  }));
}
function syncHudTimer(t, force = false) {
  if (!force && (document.body.dataset.mode !== 'show' || t - lastHudTick < 0.15)) return;
  lastHudTick = t;
  const info = updateCueProgress(t);
  const s = setlist.song.value, cues = setlist.cues.value, i = setlist.index.value, next = cues[i + 1];
  const pos = songPos(t), len = songLength(s);
  hudTimerEl.hidden = !cues.length;
  if (!cues.length) { hudDriftEl.hidden = true; return; }
  drawSegments(s, cues);
  [...hudSegsEl.children].forEach((el, k) => {
    el.classList.toggle('lit', k === i);
    el.classList.toggle('past', k < i);
  });
  hudHeadEl.hidden = pos === null;
  if (pos !== null) hudHeadEl.style.left = `${(Math.min(1, Math.max(0, pos / len)) * 100).toFixed(2)}%`;
  hudClockEl.textContent = pos === null ? `– / ${fmtEta(len)}` : `${fmtEta(pos)} / ${fmtEta(len)}`;
  // the countdown to the next cue, on the clock (on the last press until the clock runs)
  const rem = !next || !info ? null : pos !== null ? next.t - pos : info.expected - info.elapsed;
  hudTimerEl.dataset.state = rem === null ? 'ok' : rem <= 0 ? 'due' : rem <= 10 ? 'soon' : 'ok';
  hudEtaEl.textContent = rem === null ? '' : rem > 0 ? `next ~${fmtEta(rem)}` : rem > -3 ? 'NOW' : `next +${fmtEta(-rem)}`;
  // lights ahead of the clock (a press too many), or two or more behind (one behind is the late countdown above)
  const drift = pos === null || following() || i < 0 ? 0 : i - clockIndex(cues, pos);
  hudDriftEl.hidden = !(drift > 0 || drift <= -2);
  if (!hudDriftEl.hidden) {
    const n = Math.abs(drift), cuesWord = n === 1 ? 'cue' : 'cues';
    hudDriftEl.textContent = drift > 0 ? `${n} ${cuesWord} ahead of the clock · Back` : `${n} ${cuesWord} behind the clock · Next`;
  }
  hudSegsEl.parentElement.classList.toggle('drift', !hudDriftEl.hidden);
}
function syncHud() {
  const s = setlist.song.value, cues = setlist.cues.value, i = setlist.index.value, cur = cues[i], next = cues[i + 1];
  const key = `${s?.id || ''}:${i}:${cur?.id || ''}`;
  if (key !== hudCueKey) { hudCueKey = key; hudCueT0 = showTime(); onCueChange(hudCueT0); }
  const ana = cur?.anagram ? ` · Anagram ${cur.anagram} ${ANAGRAM_LABEL[cur.anagram]}` : '';
  $('.hud-song').textContent = s ? (cur ? `${s.title} · cue ${cur.id}${ana}` : s.title) : 'No song';
  $('.song-name').textContent = s?.title || 'No song';
  $('.hud-cue').textContent = show.scene === 'blackout' ? 'Blackout' : cur ? `${cur.name} · ${labelOf(show.scene)}` : labelOf(show.scene);
  const nextAna = next?.anagram ? ` → Anagram ${next.anagram} ${ANAGRAM_LABEL[next.anagram]}` : '';
  $('.hud-next').textContent = !cues.length ? 'No cues yet: Next steps through the looks'
    : next ? `Next: ${next.name} · ${labelOf(next.scene)}${nextAna}`
    : nextSong() ? `Next song: ${nextSong().title}` : 'End of the set';
  $('.hud-choke').hidden = !show.autoChoke;
  syncHudTimer(showTime(), true);
}

const sceneButtons = SCENE_LIST.map(([id, label, key, , hint]) => {
  const b = button(label, null, () => setScene(id));
  b.dataset.scene = id; b.title = `${hint} (key ${key.toUpperCase()})`;
  if (id !== 'blackout') $('.scenes').append(b);   // Blackout has its own button on the bar, in every mode
  return b;
});
function syncLooks() {
  document.querySelectorAll('.panel [data-scene]').forEach(b => {
    const on = b.dataset.scene === show.scene;
    b.setAttribute('aria-pressed', on);
    if (!on) b.style.setProperty('--p', 0);
  });
  $('.blackout').setAttribute('aria-pressed', show.scene === 'blackout');
  syncHud();
}
function setScene(id) {
  cue(id, showTime());
  syncLooks();
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
function syncSwatches() {
  swatchButtons.forEach(b => b.setAttribute('aria-pressed', show['color' + b.dataset.slot] === b.dataset.name));
}
syncSwatches();

$('.more-open').addEventListener('click', () => toggleSheet($('.more-sheet')));
function doTap() { tap(showTime()); $('.tempo .bpm').textContent = show.bpm; setlist.onTap(); }
$('.tap').addEventListener('click', doTap);

configureLive({ now: showTime });   // the drummer's strokes, on the same clock as the show
setlist.configure({
  now: () => showTime(),
  onApplied() {   // a cue changed the look: bring the buttons along
    syncLooks();
    syncSwatches();
    $('.tempo .bpm').textContent = show.bpm;
  },
});
mountSetlist(document.getElementById('setlist-root'));
setlist.loadSongs();
narrow.addEventListener('change', () => setTimeout(resize));

effect(() => {   // the setlist opens and closes with Setup: move the stage over once it's drawn
  setlist.open.value;
  setTimeout(() => {
    resize();
    const drawer = document.querySelector('.setlist');
    if (drawer && !drawer.dataset.watched) { drawer.dataset.watched = 1; new ResizeObserver(resize).observe(drawer); }
  });
});
effect(syncHud);
window.sim.setlist = setlist;
const flashBtn = $('.flash');
const setFlash = on => { show.flash = on; flashBtn.setAttribute('aria-pressed', on); };
flashBtn.addEventListener('pointerdown', () => setFlash(true));
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) flashBtn.addEventListener(ev, () => setFlash(false));
$('.hit').addEventListener('pointerdown', () => hit(showTime()));

// a fader's filled track, and its readout if it has one, follow its value however it was set
function syncFader(input) {
  input.style.setProperty('--v', `${(+input.value / +input.max) * 100}%`);
  const out = input.parentElement.querySelector('output');
  if (out) out.textContent = `${Math.round(+input.value * 100)}%`;
}
const FADERS = { master: v => { show.master = v; }, beams: v => { show.beams = v; }, haze: v => { ui.haze = v; }, fill: v => { ui.fill = v; } };
for (const [name, set] of Object.entries(FADERS)) {
  const input = $(`.${name}`);
  input.addEventListener('input', () => { set(+input.value); syncFader(input); });
  syncFader(input);
}

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
const toggleDmx = () => toggleSheet(dmxPanel);
$('.dmx-toggle').addEventListener('click', toggleDmx);

// Soundcheck helper: step through the 12 LB150 colour-wheel slots on the real heads.
const wheelPanel = $('.wheel');
const wheelButtons = LB150_WHEEL.map(([name, rgb]) => {
  const dmx = PROFILES.lb150.encodeColour(name);
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = `<i style="--c:rgb(${rgb.map(v => Math.round(v * 255)).join(',')})"></i><span>${name}</span><small>${dmx}</small>`;
  b.dataset.wheel = name;
  b.addEventListener('click', () => {
    show.wheelTest = show.wheelTest?.name === name ? null : { name, dmx };
    syncWheel();
  });
  $('.wheel-grid').append(b);
  return b;
});
function syncWheel() {
  wheelButtons.forEach(b => b.setAttribute('aria-pressed', show.wheelTest?.name === b.dataset.wheel));
  $('.wheel-toggle').setAttribute('aria-pressed', !wheelPanel.hidden);
}
$('.wheel-toggle').addEventListener('click', () => {
  const opening = wheelPanel.hidden;
  toggleSheet(wheelPanel);
  if (opening) { show.wheelTest = { name: LB150_WHEEL[0][0], dmx: 0 }; syncWheel(); }
});
$('.wheel-stop').addEventListener('click', () => showOnly(null));
syncWheel();
$('.hide').addEventListener('click', () => { showOnly(null); toggleUi(); });
$('.unhide').addEventListener('click', toggleUi);   // the way back on a phone, where there's no H key
$('.credits-open').addEventListener('click', () => $('dialog.credits').showModal());
const showKeys = () => $('dialog.shortcuts').showModal();
$('.keys-open').addEventListener('click', showKeys);

addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea, dialog') || e.metaKey || e.ctrlKey) return;
  if (e.repeat) { if (e.code === 'Space') e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  // the same in every mode
  if (k === 'escape') { if (pedal.padLearn !== null) learnPads(false); return showOnly(null); }
  if (k === '?') return showKeys();
  if (k === 'b') return toggleBlackout();
  if (k === 'h') return toggleUi();
  if (k === 'd') return toggleDmx();
  if (k === 'm') return togglePedal();
  if (k === 'n') return toggleLabels();
  if (k === 'v') {
    const names = Object.keys(VIEWS), cur = viewButtons.findIndex(b => b.getAttribute('aria-pressed') === 'true');
    return flyTo(names[(cur + 1) % names.length]);
  }
  // Show: only moving through the set, so a stray key can't change a look mid-song
  if (mode === 'show') {
    if (k === 'arrowright' || k === 'g') { e.preventDefault(); PEDAL_DO.nextScene(); }
    else if (k === 'arrowleft') { e.preventDefault(); PEDAL_DO.prevScene(); }
    else if (k === ']') PEDAL_DO.nextSong();
    else if (k === '[') PEDAL_DO.prevSong();
    return;
  }
  const s = SCENE_LIST.find(([, , key]) => key === k);
  if (s) s[0] === 'blackout' ? toggleBlackout() : setScene(s[0]);
  else if (e.code === 'Space') { e.preventDefault(); setFlash(true); }
  else if (k === 'enter') { e.preventDefault(); hit(showTime()); }
  else if (k === 't') $('.tap').click();
  else if (mode !== 'setup') return;
  else if (k === 'p') setlist.playPause();
  else if (k === 'r') setlist.toggleRecord();
  else if (k === 'arrowright' || k === 'g') { e.preventDefault(); setlist.go(); }
  else if (k === 'arrowleft') { e.preventDefault(); setlist.back(); }
});
addEventListener('keyup', e => { if (e.code === 'Space') { e.preventDefault(); setFlash(false); } });

// ── placing the players ─────────────────────────────────────────────────────
// Drag a guitar player (or the ring at their feet) to move them around the deck.

const movers = band.filter(m => ['cyril', 'olivier'].includes(m.id));
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
  placeTag.textContent = `${m.id[0].toUpperCase() + m.id.slice(1)} · ${side} · ${(DECK.front - z).toFixed(1)} m from the front of the stage`;
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

const RIG_START_MASTER = 0.2;   // the real lights always come on dim; Master goes up by hand from there
$('.rig').addEventListener('click', () => {
  if (artnet.mode !== 'off') return setMode('off');
  show.master = Math.min(show.master, RIG_START_MASTER);
  $('.master').value = show.master;
  syncFader($('.master'));
  setMode('send');
});
$('.mirror').addEventListener('click', () => setMode(artnet.mode === 'mirror' ? 'off' : 'mirror'));

function artnetText() {
  const found = artnet.nodes.length ? ` · found ${artnet.nodes.map(n => n.name || n.ip).join(', ')}` : '';
  if (artnet.mode === 'off') return artnet.notice || "The sim isn't talking to the real lights.";
  if (artnet.state === 'connecting') return 'Connecting to the bridge…';
  if (artnet.state === 'offline') return 'Bridge not running. Start it with: node sim/bridge/artnet-bridge.mjs';
  if (artnet.mode === 'send') return `The real lights follow the sim${found}`;
  if (!artnet.receiving) return "The bridge can't listen on port 6454: another app on this computer has it.";
  const fresh = artnet.lastIn && performance.now() - artnet.lastIn < 2000;
  return (fresh ? 'Mirroring the desk' : 'Waiting for Art-Net from a desk…') + found;
}
let shownProblem = '';
function syncArtnet() {
  const rig = $('.rig'), live = artnet.mode === 'send' && artnet.state === 'connected', off = artnet.mode === 'off';
  document.body.classList.toggle('live', live);
  document.body.classList.toggle('mirroring', artnet.mode === 'mirror');
  rig.dataset.on = !off;
  rig.textContent = off ? 'Drive rig' : artnet.state === 'connecting' ? 'Connecting… Stop'
    : artnet.state === 'offline' ? 'Bridge offline · Stop' : live ? 'LIVE · Stop' : 'Mirroring · Stop';
  const routes = artnet.routes.map(r => `U${r.sim} → ${r.to}`).join('\n');
  rig.title = artnetText() + (routes ? `\n${routes}` : '');
  $('.mirror').setAttribute('aria-pressed', artnet.mode === 'mirror');
  // only the things you have to act on get said out loud
  const problem = (off && artnet.notice) || (!off && artnet.state === 'offline' && artnetText()) || (artnet.mode === 'mirror' && !artnet.receiving && artnetText()) || '';
  if (problem && problem !== shownProblem) toast(problem);
  shownProblem = problem;
  syncRigStatus();
  syncWakeLock();
}
artnet.onChange = syncArtnet;

// Keep the screen awake on laptops/tablets while in Show mode or driving the real rig.
let wakeLock = null, wakeWanted = false;
async function acquireWakeLock() {
  if (!wakeWanted || document.hidden || wakeLock || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; if (wakeWanted && !document.hidden) acquireWakeLock(); });
  } catch { /* browser denied or battery saver */ }
}
function syncWakeLock() {
  wakeWanted = artnet.mode === 'send' || document.body.dataset.mode === 'show';
  if (wakeWanted) acquireWakeLock();
  else if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && wakeWanted) acquireWakeLock(); });

// Show-mode pre-flight status dots: Bridge · Rig · Pedal · XR18
function setDot(sel, state, title) {
  const el = $(sel);
  if (!el) return;
  el.dataset.state = state;
  el.title = title;
}
function syncRigStatus() {
  const bridgeUp = pedal.bridgeConnected || artnet.state === 'connected';
  setDot('.st-bridge', bridgeUp ? 'ok' : 'err', bridgeUp ? 'Bridge connected' : 'Bridge offline — run: node sim/bridge/artnet-bridge.mjs');

  const driving = artnet.mode === 'send' && artnet.state === 'connected';
  const rigState = artnet.mode === 'off' ? 'off'
    : artnet.state === 'offline' ? 'err'
    : driving ? (artnet.nodes.length ? 'ok' : 'warn') : 'warn';
  setDot('.st-rig', rigState, artnetText());

  const midiNames = pedal.bridge ? pedal.bridge : pedal.inputs;
  const pedalState = midiNames.length ? 'ok' : (pedal.bridgeConnected || pedal.state === 'ready') ? 'warn' : 'off';
  setDot('.st-pedal', pedalState, midiNames.length ? `MIDI: ${midiNames.join(', ')}` : 'No MIDI pedal or pad connected');

  const anaOut = anagramTarget();
  const anaState = pedal.anagram.target === 'off' ? 'off' : anaOut ? 'ok' : 'warn';
  const anaTitle = pedal.anagram.target === 'off' ? 'Anagram MIDI out is off'
    : anaOut ? `Anagram: ${anaOut} · ch ${pedal.anagram.channel} · CC ${pedal.anagram.cc}${pedal.anagramLast ? ` (scene ${pedal.anagramLast})` : ''}`
    : 'Anagram not found — plug in over USB-C';
  setDot('.st-anagram', anaState, anaTitle);

  const audioState = !inputs.device ? 'off' : show.autoChoke ? 'warn' : 'ok';
  const audioTitle = !inputs.device ? (inputs.note || 'No audio interface connected')
    : show.autoChoke ? `${inputs.device} · dead stop active (lights dark)` : `${inputs.device}: ${inputs.channels} ch`;
  setDot('.st-audio', audioState, audioTitle);
}
$('.st-bridge').addEventListener('click', () => toast(pedal.bridgeConnected || artnet.state === 'connected' ? 'Bridge connected' : 'Bridge offline · node sim/bridge/artnet-bridge.mjs'));
$('.st-rig').addEventListener('click', () => $('.rig').click());
$('.st-pedal').addEventListener('click', () => toggleSheet($('.pedal')));
$('.st-anagram').addEventListener('click', () => toggleSheet($('.pedal')));
$('.st-audio').addEventListener('click', () => toggleSheet($('.inputs')));

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
    return `<li>${p.id} · ${String(p.address).padStart(3, '0')}–${String(p.address + n - 1).padStart(3, '0')} · ${p.label}</li>`;
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
    else if (owner.fixture.profile === 'lb150' || owner.fixture.profile === 'hexpar') c = `rgb(${50 + 205 * k},${35 + 150 * k},${20 + 60 * k})`;
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

// ── names on the lights ─────────────────────────────────────────────────────

const LABELS_KEY = 'owashi-sim:labels-on';   // off unless turned on in Settings
const labels = createLabels($('.tags'), [...bars, ...heads, ...pars].map(({ f }) => {
  const [x, y, z] = RIG[f.id].pos;
  const at = f.profile === 'hexpar' ? [x, y + 0.4, z + 0.1] : f.profile === 'lb150' ? [x, y + Math.max(RIG[f.id].riser / 2, 0.12), z + 0.25]   // on the front of its flight case, or of its base
    : RIG[f.id].raise ? [x, y + RIG[f.id].raise + 0.12, z]                     // just above the bar
    : [x, y + 2.2, z];                                                         // just above the tube
  return { f, at };
}), camera);
function setLabels(on) {
  document.body.classList.toggle('no-tags', !on);
  $('.labels-toggle').setAttribute('aria-pressed', on);
  try { localStorage.setItem(LABELS_KEY, on ? '1' : '0'); } catch { /* it just won't be remembered */ }
}
const toggleLabels = () => setLabels(document.body.classList.contains('no-tags'));
$('.labels-toggle').addEventListener('click', toggleLabels);
let labelsWanted = false;
try { labelsWanted = localStorage.getItem(LABELS_KEY) === '1'; } catch { /* private window: leave them off */ }
setLabels(labelsWanted);

// ── the pad (Manual) ────────────────────────────────────────────────────────
// Mirrors the SMC-PAD: two rows of looks, then a row to tap and a row to hold. Velocity sets how hard a hit lands.

const PADS = [
  { scene: 'ambient' }, { scene: 'sweep' }, { scene: 'searchlight' }, { scene: 'build' },
  { scene: 'riff' }, { scene: 'slab' }, { scene: 'blast' }, { scene: 'wall' },
  { label: 'Hit', kind: 'tap', tap: v => hit(showTime(), v) },
  { label: 'Beams hit', kind: 'tap', tap: v => beamHit(showTime(), v) },
  { label: 'Tubes hit', kind: 'tap', tap: v => tubeHit(showTime(), v) },
  { label: 'Tap tempo', kind: 'tap', tap: doTap },
  { label: 'Flash', kind: 'hold', hold: on => setFlash(on) },
  { label: 'Choke', kind: 'hold', hold: on => { show.choke = on; } },
  { label: 'Swap A·B', kind: 'hold', hold: on => { show.swap = on; } },
  { label: 'Blackout', kind: 'tap', tap: () => toggleBlackout() },
];
const padButtons = PADS.map((p, i) => {
  const b = document.createElement('button');
  if (p.scene) { b.dataset.scene = p.scene; b.textContent = labelOf(p.scene); b.title = SCENE_LIST.find(s => s[0] === p.scene)[4]; }
  else { b.className = `fx ${p.label === 'Blackout' ? 'stop' : p.kind}`; b.innerHTML = `${p.label}<small>${p.kind}</small>`; }
  b.addEventListener('pointerdown', e => { e.preventDefault(); padDown(i, 1); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => padUp(i));
  $('.padgrid').append(b);
  return b;
});
// the looks that aren't on the pad, as plain buttons beside it
for (const [id, label, key, , hint] of SCENE_LIST) {
  if (id === 'blackout' || PADS.some(p => p.scene === id)) continue;
  const b = button(label, null, () => setScene(id));
  b.dataset.scene = id; b.title = `${hint} (key ${key.toUpperCase()})`;
  $('.more-looks').append(b);
}
const padTimers = [];
function padDown(i, v) {
  if (artnet.mode === 'mirror') return;   // the desk is in charge
  const p = PADS[i], b = padButtons[i];
  if (p.scene) return setScene(p.scene);
  if (p.hold) { p.hold(true); b.classList.add('on'); return; }
  p.tap(v);
  b.classList.add('on');   // a tap lights the pad on screen for a moment
  clearTimeout(padTimers[i]);
  padTimers[i] = setTimeout(() => b.classList.remove('on'), 150);
}
function padUp(i) {
  const p = PADS[i];
  if (p.hold && padButtons[i].classList.contains('on')) { p.hold(false); padButtons[i].classList.remove('on'); }
}
pedal.tapPads = new Set(PADS.flatMap((p, i) => (p.kind === 'tap' ? [i] : [])));
pedal.onPad = (i, down, v) => {
  if (mode === 'show') { if (down) toast('The pad works in Manual and Setup'); return; }
  if (down) padDown(i, v); else padUp(i);
};
function syncPadLearn() {
  const i = pedal.padLearn;
  padButtons.forEach((b, k) => b.classList.toggle('learn', k === i));
  $('.pad-hint').hidden = i === null;
  if (i !== null) $('.pad-hint').textContent = `Press the pad marked here: ${i + 1} of ${PAD_COUNT}. Esc stops.`;
}
$('.pad-setup').addEventListener('click', () => {
  if (pedal.padLearn !== null) return learnPads(false);
  setUiMode('manual');   // the pad is drawn there
  learnPads(true);
});

// ── foot pedal ──────────────────────────────────────────────────────────────
// Four switches: scene and song, each way. What happened shows up big on screen, to read from the stage.

const LOOK_CYCLE = SCENE_LIST.filter(s => s[3] !== 'Cut').map(s => s[0]);   // never lands on Strobe or Blackout by accident
function stepLook(dir) {
  const i = LOOK_CYCLE.indexOf(show.scene);
  const next = LOOK_CYCLE[i < 0 ? 0 : (i + dir + LOOK_CYCLE.length) % LOOK_CYCLE.length];
  setScene(next);
  return labelOf(next);
}
// A song with cues steps through them; one without steps through the looks, so the switch always does something.
function stepScene(dir) {
  const cues = setlist.cues.value;
  if (!cues.length) return stepLook(dir);
  const to = cues[setlist.index.value + dir];
  if (!to) return dir > 0 ? 'End of the song' : 'First cue';
  if (dir > 0) setlist.go(); else setlist.back();
  return `${to.name} · ${labelOf(to.scene)}`;
}
function stepSong(dir) {
  const list = setlist.songs.value;
  if (!list.length) return 'No songs';
  const i = list.findIndex(s => s.id === setlist.songId.value);
  const next = list[Math.min(list.length - 1, Math.max(0, i + dir))];
  if (next.id !== setlist.songId.value) setlist.selectSong(next.id);   // the lights stay as they are until the next scene
  return next.title;
}
// Through the set with one foot: Next runs through a song's scenes and, after its last one, into the next song
// at its first scene. Back retraces exactly that, so a press too many can always be undone.
// In Show, a second Next within NEXT_LOCK_S of the last one is taken for a double press and ignored: the closest
// cues in the set are 7 s apart. Back is never held up, so a mistake can always be undone at once.
const NEXT_LOCK_S = 2;
let lastNextT = -1e9;
function forward() {
  if (mode === 'show') {
    const t = showTime();
    if (t - lastNextT < NEXT_LOCK_S) { toast('Next ignored: pressed twice'); return null; }
    lastNextT = t;
  }
  const cues = setlist.cues.value;
  if (!cues.length || setlist.index.value + 1 < cues.length) {
    cueMove = 'next';
    try { return stepScene(1); } finally { cueMove = ''; }
  }
  const list = setlist.songs.value, i = list.findIndex(s => s.id === setlist.songId.value);
  if (i < 0 || i + 1 >= list.length) return 'End of the set';
  setlist.selectSong(list[i + 1].id);
  if (setlist.cues.value.length) setlist.go();
  return list[i + 1].title;
}
function backward() {
  const cues = setlist.cues.value;
  if (!cues.length || setlist.index.value > 0) {
    cueMove = 'back';
    try { return stepScene(-1); } finally { cueMove = ''; }
  }
  const list = setlist.songs.value, i = list.findIndex(s => s.id === setlist.songId.value);
  if (i <= 0) return 'Start of the set';
  setlist.selectSong(list[i - 1].id);
  const last = setlist.cues.value.length - 1;
  if (last >= 0) setlist.jumpTo(last);
  return list[i - 1].title;
}
const PEDAL_DO = { nextScene: forward, prevScene: backward, nextSong: () => stepSong(1), prevSong: () => stepSong(-1) };
// The foot pedal: next and back move through the set (through the looks in Manual); Blackout and Tap work anywhere.
const PEDAL = {
  next: forward,
  back: backward,
  blackout: () => { toggleBlackout(); return show.scene === 'blackout' ? 'Blackout' : labelOf(show.scene); },
  tap: () => { doTap(); return `Tap · ${show.bpm} BPM`; },
};
pedal.onAction = id => {
  const moves = id === 'next' || id === 'back';
  if (moves && artnet.mode === 'mirror') return toast('Mirroring a desk');   // the desk is in charge
  if (moves && mode === 'manual') return toast(stepLook(id === 'next' ? 1 : -1));
  const said = PEDAL[id]?.();
  if (said && (mode !== 'show' || id === 'tap')) toast(said);   // in Show the readout already says where we are
};

// Blackout, from the bar, the B key or anywhere: press again to come back to the look it interrupted.
let beforeBlackout = 'ambient';
function toggleBlackout() {
  if (artnet.mode === 'mirror') return;
  if (show.scene === 'blackout') return setScene(beforeBlackout === 'blackout' ? 'ambient' : beforeBlackout);
  beforeBlackout = show.scene;
  setScene('blackout');
}
$('.blackout').addEventListener('click', toggleBlackout);

// ── modes ───────────────────────────────────────────────────────────────────
// Manual for other bands, Show for our set, Setup for editing. Switching only changes the screen, never the lights.

const MODE_KEY = 'owashi-sim:mode';
let mode = 'manual';
const modeButtons = [...document.querySelectorAll('[data-mode]')];
function setUiMode(next) {
  if (mode === 'setup' && next !== 'setup') setlist.pause();   // a song playing in Setup would keep firing cues
  mode = next;
  document.body.dataset.mode = next;
  modeButtons.forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === next));
  setlist.open.value = next === 'setup';
  showOnly(null);
  syncHud();
  syncWakeLock();
  setTimeout(resize);
  try { localStorage.setItem(MODE_KEY, next); } catch { /* starts in Manual next time */ }
}
modeButtons.forEach(b => b.addEventListener('click', () => setUiMode(b.dataset.mode)));
$('.cue-next').addEventListener('click', () => PEDAL_DO.nextScene());
$('.cue-back').addEventListener('click', () => PEDAL_DO.prevScene());
$('.song-next').addEventListener('click', () => PEDAL_DO.nextSong());
$('.song-prev').addEventListener('click', () => PEDAL_DO.prevSong());
let savedMode = 'manual';
try { savedMode = localStorage.getItem(MODE_KEY) || 'manual'; } catch { /* private window */ }
setUiMode(['manual', 'show', 'setup'].includes(savedMode) ? savedMode : 'manual');

const togglePedal = () => toggleSheet($('.pedal'));
$('.pedal-toggle').addEventListener('click', togglePedal);
$('.pedal-connect').addEventListener('click', connectPedal);
const pedalRows = pedalActions.map(({ id, label }) => {
  const li = document.createElement('li');
  li.innerHTML = `<span>${label}</span><small></small><button class="learn">Learn</button>`;
  li.querySelector('.learn').addEventListener('click', () => { pedal.learning = pedal.learning === id ? null : id; syncPedal(); });
  $('.pedal-map').append(li);
  return { id, set: li.querySelector('small'), learn: li.querySelector('.learn') };
});
const anagramDestEl = $('.anagram-dest'), anagramChEl = $('.anagram-ch'), anagramCcEl = $('.anagram-cc');
for (let ch = 1; ch <= 16; ch++) {
  const o = document.createElement('option'); o.value = ch; o.textContent = `Ch ${ch}`;
  anagramChEl.append(o);
}
anagramDestEl.addEventListener('change', () => setAnagram({ target: anagramDestEl.value }));
anagramChEl.addEventListener('change', () => setAnagram({ channel: +anagramChEl.value }));
anagramCcEl.addEventListener('change', () => setAnagram({ cc: +anagramCcEl.value }));
const anagramButtons = ANAGRAM_SCENES.map(([n, label]) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = `${n} · ${label}`;
  b.dataset.scene = n;
  b.addEventListener('click', () => {
    if (!sendAnagramScene(n)) toast('Anagram not connected over USB-C');
  });
  $('.anagram-test').append(b);
  return b;
});
function syncAnagram() {
  const out = anagramTarget();
  $('.anagram-status').textContent = pedal.anagram.target === 'off' ? 'Anagram MIDI out: off'
    : out ? `Anagram: ${out}`
    : 'Anagram: plug in over USB-C (auto-matches Darkglass / Anagram)';
  const opts = [['auto', 'Auto (Anagram)'], ['off', 'Off'], ...pedal.destinations.map(n => [n, n])];
  if (pedal.anagram.target !== 'auto' && pedal.anagram.target !== 'off' && !pedal.destinations.includes(pedal.anagram.target)) {
    opts.push([pedal.anagram.target, `${pedal.anagram.target} (unplugged)`]);
  }
  const key = opts.map(o => o[0]).join('|');
  if (anagramDestEl.dataset.key !== key) {
    anagramDestEl.replaceChildren(...opts.map(([val, text]) => {
      const o = document.createElement('option'); o.value = val; o.textContent = text; return o;
    }));
    anagramDestEl.dataset.key = key;
  }
  anagramDestEl.value = pedal.anagram.target;
  anagramChEl.value = String(pedal.anagram.channel);
  anagramCcEl.value = String(pedal.anagram.cc);
  anagramButtons.forEach(b => {
    b.disabled = !out;
    b.setAttribute('aria-pressed', pedal.anagramLast === +b.dataset.scene);
  });
}
function syncPedal() {
  const padsSet = pedal.pads.filter(Boolean).length;
  const builtIn = pedal.pads.join() === SMC_PAD_POCKET.join();
  $('.pad-status').textContent = pedal.padLearn !== null ? 'Setting up the pad…' : builtIn ? 'Pad: SMC-PAD Pocket, as it comes' : padsSet ? `Pad: ${padsSet} of ${PAD_COUNT} pads set` : 'Pad: not set up';
  $('.pad-setup').textContent = pedal.padLearn !== null ? 'Stop' : padsSet ? 'Set up again' : 'Set up pad';
  syncPadLearn();
  $('.pedal-connect').hidden = !!pedal.bridge || pedal.state === 'ready' || pedal.state === 'unsupported';
  $('.pedal-status').textContent = pedal.learning ? 'Press the switch…'
    : pedal.bridge ? (pedal.bridge.length ? `Through the bridge: ${pedal.bridge.join(', ')}` : 'Through the bridge: no MIDI device found')
    : pedal.state === 'unsupported' ? 'This browser has no MIDI. Start the bridge, or use Chrome.'
    : pedal.state === 'denied' ? 'This browser blocks MIDI. Start the bridge, or use Chrome.'
    : pedal.state === 'off' ? 'Not connected'
    : !pedal.inputs.length ? 'No pedal found. Plug it in.'
    : pedal.inputs.join(', ');
  for (const r of pedalRows) {
    const key = pedal.map[r.id];
    r.set.textContent = key ? pedal.describe(key) : '';
    r.learn.setAttribute('aria-pressed', pedal.learning === r.id);
  }
  syncAnagram();
  syncRigStatus();
}
pedal.onChange = syncPedal;
syncPedal();
// ── inputs: what the mixer hears ─────────────────────────────────────────────
// One row per channel: its role, its level and a light for each hit. Drawn only while the sheet is open.

$('.inputs-toggle').addEventListener('click', () => toggleSheet($('.inputs')));
let inputRows = [];
$('.dark-on-stop').checked = live.darkOnStop;
const stopFloorEl = $('.stop-floor');
function syncStopFloor() {
  stopFloorEl.value = live.stopFloor;
  stopFloorEl.disabled = !live.darkOnStop;
  const min = +stopFloorEl.min, max = +stopFloorEl.max;
  stopFloorEl.style.setProperty('--v', `${((live.stopFloor - min) / (max - min)) * 100}%`);
  $('.stop-floor-out').textContent = `${live.stopFloor} dB`;
}
$('.dark-on-stop').addEventListener('change', e => { setDarkOnStop(e.currentTarget.checked); syncStopFloor(); });
stopFloorEl.addEventListener('input', e => { setStopFloor(e.currentTarget.value); syncStopFloor(); });
syncStopFloor();
live.onStopChange = () => { syncHud(); syncRigStatus(); };
function syncInputs() {
  $('.inputs-status').textContent = inputs.device ? `${inputs.device}: ${inputs.channels} channel${inputs.channels === 1 ? '' : 's'}`
    : inputs.note || 'Waiting for the bridge. Start it, then plug in the XR18 over USB.';
  syncRigStatus();
  if (inputRows.length === inputs.channels && inputRows.names === inputs.names.join('|')) { inputRows.forEach((r, i) => { r.role.value = inputs.roles[i] || ''; }); return; }
  $('.inputs-list').replaceChildren();
  inputRows = Array.from({ length: inputs.channels }, (_, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ch" title="${inputs.names[i] || ''}">${inputs.names[i] || i + 1}</span><select aria-label="Channel ${i + 1} is">${ROLES.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select><span class="meter"><i></i></span><span class="hit"></span>`;
    const role = li.querySelector('select');
    role.value = inputs.roles[i] || '';
    role.addEventListener('change', () => setRole(i, role.value));
    $('.inputs-list').append(li);
    return { role, bar: li.querySelector('.meter i'), hit: li.querySelector('.hit') };
  });
  inputRows.names = inputs.names.join('|');
}
inputs.onChange = syncInputs;
inputs.onLevels = () => {
  if ($('.inputs').hidden) return;
  const now = performance.now();
  $('.inputs-live').textContent = show.autoChoke ? 'The band stopped: dark until the next hit'
    : show.drums.live ? 'The drums are driving Riff, Blast, Breakdown, Wall, Drive and Backlight'
    : inputs.roles.some(r => r === 'kick' || r === 'snare') ? 'Waiting for the drums' : 'Give the kick and snare their roles to let the drums drive the looks';
  const lvl = live.level <= -89 ? '—' : `${Math.round(live.level)} dB`;
  $('.stop-level').textContent = inputs.roles.some(Boolean)
    ? `Band level: ${lvl} · dark below ${live.stopFloor} dB`
    : 'Assign at least one channel role to measure band level';
  inputRows.forEach((r, i) => {
    r.bar.style.width = `${Math.max(0, Math.min(100, ((inputs.levels[i] ?? -90) + 60) / 60 * 100))}%`;
    r.hit.classList.toggle('on', now - (inputs.hitAt[i] || 0) < 120);
  });
};
syncInputs();
bridgeListeners.add(onBridgeMessage);
connectBridge(bridgeUrl());   // the bridge passes on the Mac's MIDI, in any browser
connectIfAllowed();   // or the browser's own MIDI, if it was allowed once on this computer

// ── loop ────────────────────────────────────────────────────────────────────

// If the device can't hold ~28 fps (an older phone), render at a lower resolution, a step at a time.
// Frames over 250 ms are a hidden or throttled tab, not a slow device, so they don't count.
let sampled = 0, slow = 0;
function adaptQuality(frameTime) {
  if (document.hidden || frameTime > 0.25) return;
  sampled++;
  if (frameTime > 1 / 28) slow++;
  if (sampled < 120) return;
  if (slow > 60 && pixelRatio > 0.75) {
    pixelRatio = Math.max(0.75, pixelRatio - 0.25);
    renderer.setPixelRatio(pixelRatio);
    composer.setPixelRatio(pixelRatio);
    resize();
  }
  sampled = slow = 0;
}

const beatDots = [...document.querySelectorAll('.beats i')];
let frames = 0, fpsT = 0;

// One step of what the lights do: nothing here depends on drawing, so it can run without a frame.
// A look that fails must not stop the picture or the DMX: say so once, keep the last frame, and carry on.
let lastBeat = 0, failed = '';
function stepShow(t) {
  try {
    setlist.tick();   // a song that's playing moves the cues (and the tempo grid) along
    liveTick();       // and its recording's drums drive the looks
    updateCueProgress(t);   // drive each look's dramatic arc along the chapter timer
    // mirroring a desk: the show stays out of the universes, the desk fills them
    lastBeat = artnet.mode === 'mirror' ? (t - show.beat0) * show.bpm / 60 : updateShow(t);
  } catch (err) {
    if (failed !== err.message) { failed = err.message; console.error(err); toast(`A look failed: ${err.message}`); }
  }
  pump(performance.now());
  return lastBeat;
}
artnet.onTick = () => stepShow(showTime());   // while driving the rig, whatever the tab is doing

// Drawing at the screen's own rate (120 Hz on a recent Mac) doubles the work for nothing the eye can see,
// and over a long show it heats a fanless laptop until it slows down. 60 frames a second is plenty;
// the real lights don't depend on it (they get their DMX ~40 times a second either way).
const FRAME_MS = 1000 / 60;
let lastDraw = 0;
renderer.setAnimationLoop(now => {
  if (now - lastDraw < FRAME_MS - 2) return;
  lastDraw = now;
  const raw = clock.getDelta(), dt = Math.min(raw, 0.1), t = showTime();
  adaptQuality(raw);

  const beat = stepShow(t);
  // Show mode has no stage, only the readout: the lights don't need the picture, and the Mac keeps its breath
  if (mode === 'show') { syncHudTimer(t); return; }

  for (const bar of bars) bar.update(t);
  for (const head of heads) head.update(t, dt, camera, ui.haze);
  for (const par of pars) par.update(t, dt, camera, ui.haze);
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

  const beatNow = ((Math.floor(beat) % 4) + 4) % 4;
  beatDots.forEach((d, i) => { d.style.opacity = i === beatNow ? 0.25 + 0.75 * nod : 0.15; });
  const progress = lookProgress(t);
  document.querySelectorAll(`.panel [data-scene="${show.scene}"]`).forEach(b => b.style.setProperty('--p', progress));
  syncHudTimer(t);
  if (uiShown) labels.update(innerWidth, innerHeight);
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
