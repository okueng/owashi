// The 3D side of each fixture. Every frame they read their channels from the universes —
// they never know (or care) what wrote them.

import * as THREE from 'three';

const HOUSING = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.5, metalness: 0.6 });
const PIXEL_GAIN = 3.2;     // pushes full-on pixels past the bloom threshold
const BAR_SPILL = 9;        // area-light brightness of a full-white bar
const TUBE_GAIN = 2.6;
const TUBE_SPILL = 7;

// Zone i as the fixture outputs it (0–1), straight from DMX.
function zoneOut(f, i, out) {
  const a = f.zone0 + i * 3;
  out[0] = f.u[a] / 255; out[1] = f.u[a + 1] / 255; out[2] = f.u[a + 2] / 255;
  return out;
}
// RGB all on is three times the light of one colour; keep white from blooming over everything
const whiteNorm = p => 1 / Math.max(1, (p[0] + p[1] + p[2]) / 2);

// ── homemade COB tube: one continuous 3 cm diffuser, 64 zones, light all the way round ──

export class CobTube {
  constructor(fixture, { length = 2, radius = 0.015 } = {}) {
    this.f = fixture;
    this.n = fixture.n;
    this.group = new THREE.Group();

    // the 64 zones live in a 1×64 texture; linear filtering blends them like the COB strip does
    this.data = new Uint8Array(this.n * 4);
    this.tex = new THREE.DataTexture(this.data, 1, this.n, THREE.RGBAFormat);
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    this.tex.needsUpdate = true;
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false });
    mat.color.setScalar(TUBE_GAIN);
    this.group.add(new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 20, 1, true), mat));

    const cap = new THREE.CylinderGeometry(radius + 0.003, radius + 0.003, 0.03, 20);
    for (const y of [-1, 1]) {
      const c = new THREE.Mesh(cap, HOUSING);
      c.position.y = y * (length / 2 + 0.015);
      this.group.add(c);
    }

    // a tube glows all the way round, so it lights the wall behind it as much as the band
    this.lights = [0, Math.PI].map(rot => {
      const l = new THREE.RectAreaLight(0xffffff, 0, 0.05, length);
      l.rotation.y = rot + Math.PI;   // area lights shine down their -Z
      l.position.z = rot ? -radius : radius;
      this.group.add(l);
      return l;
    });
    this.px = [0, 0, 0];
  }

  update() {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < this.n; i++) {
      const p = zoneOut(this.f, i, this.px), k = whiteNorm(p) * 255;
      r += p[0]; g += p[1]; b += p[2];
      this.data[i * 4] = p[0] * k; this.data[i * 4 + 1] = p[1] * k; this.data[i * 4 + 2] = p[2] * k; this.data[i * 4 + 3] = 255;
    }
    this.tex.needsUpdate = true;
    const peak = Math.max(r, g, b);
    for (const l of this.lights) {
      if (peak > 0) l.color.setRGB(r / peak, g / peak, b / peak);
      l.intensity = (peak / this.n) * TUBE_SPILL;
    }
  }
}

// ── pixel bar (the floor bars, until we know their model) ──

export class LedBar {
  constructor(fixture, { length = 2, horizontal = false } = {}) {
    this.f = fixture;
    this.n = fixture.n;
    this.group = new THREE.Group();
    const body = new THREE.Group();
    if (horizontal) body.rotation.z = -Math.PI / 2;   // pixel 1 ends up on the left
    this.group.add(body);

    const depth = 0.06, cell = length / this.n;
    body.add(new THREE.Mesh(new THREE.BoxGeometry(0.075, length + 0.04, depth), HOUSING));

    this.pixels = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.046, cell * 0.84),
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      this.n,
    );
    const m = new THREE.Matrix4();
    for (let i = 0; i < this.n; i++) {
      this.pixels.setMatrixAt(i, m.makeTranslation(0, -length / 2 + (i + 0.5) * cell, depth / 2 + 0.002));
      this.pixels.setColorAt(i, new THREE.Color(0));
    }
    body.add(this.pixels);

    this.light = new THREE.RectAreaLight(0xffffff, 0, 0.07, length);
    this.light.position.z = depth / 2 + 0.01;
    this.light.rotation.y = Math.PI;   // area lights shine down their -Z; turn it to face out of the bar
    body.add(this.light);

    this.px = [0, 0, 0];
    this.c = new THREE.Color();
  }

  update(t) {
    const f = this.f;
    const k = (f.get('Dimmer') / 255) * f.def.gate(f.get('Strobe'), t);
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < this.n; i++) {
      const p = zoneOut(f, i, this.px);
      r += p[0]; g += p[1]; b += p[2];
      const gain = k * PIXEL_GAIN * whiteNorm(p);
      this.pixels.setColorAt(i, this.c.setRGB(p[0] * gain, p[1] * gain, p[2] * gain));
    }
    this.pixels.instanceColor.needsUpdate = true;
    const peak = Math.max(r, g, b);
    if (peak > 0) this.light.color.setRGB(r / peak, g / peak, b / peak);
    this.light.intensity = (peak / this.n) * k * BAR_SPILL;
  }
}

// ── Betopper LB150 beam moving head ─────────────────────────────────────────

const BEAM_LEN = 24;
const LENS_R = 0.045;
const HALF_ANGLE = 0.86;   // degrees — the LB150 is a 1.72° beam
const FACETS = 6;          // 6-facet prism

const beamGeometry = (() => {
  const r0 = LENS_R * 0.85, r1 = r0 + BEAM_LEN * Math.tan(THREE.MathUtils.degToRad(HALF_ANGLE));
  const g = new THREE.CylinderGeometry(r1, r0, BEAM_LEN, 36, 1, true);
  g.translate(0, BEAM_LEN / 2, 0);
  return g;
})();

const beamShader = {
  vertexShader: /* glsl */`
    uniform float uLength;
    varying float vT;
    varying vec3 vPosW;
    varying vec3 vNormW;
    void main() {
      vT = position.y / uLength;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vPosW = wp.xyz;
      vNormW = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uColor;
    uniform float uIntensity;
    uniform float uTime;
    varying float vT;
    varying vec3 vPosW;
    varying vec3 vNormW;
    float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float noise(vec3 x) {
      vec3 i = floor(x), f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }
    void main() {
      vec3 V = normalize(cameraPosition - vPosW);
      float core = pow(abs(dot(V, normalize(vNormW))), 1.6);        // brightest down the middle of the pencil
      float fall = pow(1.0 - vT, 1.5) * smoothstep(0.0, 0.01, vT);  // fades out with distance
      vec3 q = vPosW * 0.8 + vec3(uTime * 0.07, uTime * 0.03, -uTime * 0.05);
      float haze = 0.45 + 0.4 * noise(q) + 0.25 * noise(q * 2.9);   // drifting haze texture
      gl_FragColor = vec4(uColor * (uIntensity * core * fall * haze), 1.0);
    }`,
};

function beamMaterial() {
  return new THREE.ShaderMaterial({
    ...beamShader,
    uniforms: {
      uLength: { value: BEAM_LEN }, uColor: { value: new THREE.Color() }, uIntensity: { value: 0 }, uTime: { value: 0 },
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
}

const glareTexture = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.15, 'rgba(255,255,255,.45)');
  g.addColorStop(0.45, 'rgba(255,255,255,.08)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

export class BeamHead {
  constructor(fixture) {
    this.f = fixture;
    this.group = new THREE.Group();
    this.pan = 0; this.tilt = 0; this.prismAngle = 0;

    // 236 × 174 × 329 mm, per the spec sheet
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.236, 0.085, 0.174), HOUSING);
    base.position.y = 0.0425;
    this.yoke = new THREE.Group(); this.yoke.position.y = 0.085;
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.02, 0.09), HOUSING); plate.position.y = 0.01;
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.2, 0.08), HOUSING); armL.position.set(-0.098, 0.12, 0);
    const armR = armL.clone(); armR.position.x = 0.098;
    this.head = new THREE.Group(); this.head.position.y = 0.16;
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.076, 0.17, 28), HOUSING);
    this.lensMat = new THREE.MeshBasicMaterial({ color: 0, toneMapped: false });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(LENS_R, 28), this.lensMat);
    lens.rotation.x = -Math.PI / 2; lens.position.y = 0.0855;
    this.head.add(shell, lens);
    this.yoke.add(plate, armL, armR, this.head);
    this.group.add(base, this.yoke);

    // the beam itself, plus the prism version
    this.beams = new THREE.Group(); this.beams.position.y = 0.086;
    this.mainMat = beamMaterial();
    this.main = new THREE.Mesh(beamGeometry, this.mainMat);
    this.prismMat = beamMaterial();
    this.prism = new THREE.Group();
    for (let k = 0; k < FACETS; k++) {
      const arm = new THREE.Group(); arm.rotation.y = (k * 2 * Math.PI) / FACETS;
      const m = new THREE.Mesh(beamGeometry, this.prismMat); m.rotation.z = THREE.MathUtils.degToRad(3.2);
      arm.add(m); this.prism.add(arm);
    }
    this.beams.add(this.main, this.prism);
    this.head.add(this.beams);

    // what the beam lights up when it lands on something
    this.spot = new THREE.SpotLight(0xffffff, 0, 0, 0.05, 0.4, 2);
    this.spot.position.y = 0.09;
    this.spot.target.position.y = 10;
    this.head.add(this.spot, this.spot.target);

    // the hot spot you see when a beam points at you
    this.glare = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glareTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    this.glare.position.y = 0.1;
    this.head.add(this.glare);

    this.dir = new THREE.Vector3(); this.lensW = new THREE.Vector3(); this.toCam = new THREE.Vector3();
  }

  update(t, dt, camera, haze) {
    const f = this.f, def = f.def;
    const [panT, tiltT] = f.angles();
    const speed = def.speedFactor(f.get('P/T speed'));
    this.pan = approach(this.pan, panT, (def.panRange / def.panTime) * speed, dt);
    this.tilt = approach(this.tilt, tiltT, (def.tiltRange / def.tiltTime) * speed, dt);
    this.yoke.rotation.y = THREE.MathUtils.degToRad(this.pan);
    this.head.rotation.x = THREE.MathUtils.degToRad(this.tilt);

    const k = (f.get('Dimmer') / 255) * def.gate(f.get('Shutter'), t);
    const [r0, g0, b0] = def.decodeColour(f.get('Colour'), t)[1];
    const norm = 1 / Math.max(1, (r0 + g0 + b0) / 1.5);   // keep open white from out-blinding the colours
    const r = r0 * norm, g = g0 * norm, b = b0 * norm;
    const prism = def.decodePrism(f.get('Prism'));
    this.prismAngle += prism.spin * dt * 4;

    for (const mat of [this.mainMat, this.prismMat]) {
      mat.uniforms.uColor.value.setRGB(r, g, b);
      mat.uniforms.uTime.value = t;
    }
    const level = k * haze * 1.6;
    this.mainMat.uniforms.uIntensity.value = prism.on ? 0 : level;
    this.prismMat.uniforms.uIntensity.value = prism.on ? level * 0.45 : 0;
    this.main.visible = !prism.on && k > 0;
    this.prism.visible = prism.on && k > 0;
    this.prism.rotation.y = this.prismAngle;

    this.lensMat.color.setRGB(r * k * 8, g * k * 8, b * k * 8);

    this.spot.color.setRGB(r, g, b);
    this.spot.intensity = k * 1400;
    this.spot.angle = Math.atan((LENS_R + BEAM_LEN * Math.tan(THREE.MathUtils.degToRad(HALF_ANGLE))) / BEAM_LEN) * (prism.on ? 5 : 1.4);

    // glare grows as the beam swings towards the camera
    this.head.updateWorldMatrix(true, false);
    this.dir.set(0, 1, 0).transformDirection(this.head.matrixWorld);
    this.lensW.set(0, 0.1, 0).applyMatrix4(this.head.matrixWorld);
    const facing = Math.max(0, this.dir.dot(this.toCam.subVectors(camera.position, this.lensW).normalize()));
    const glow = k * (0.25 + 3 * facing ** 10);
    this.glare.material.color.setRGB(r * glow, g * glow, b * glow);
    this.glare.scale.setScalar(0.3 + 1.4 * facing ** 6);
    this.glare.visible = k > 0;
  }
}

function approach(cur, target, maxSpeed, dt) {
  const step = (target - cur) * (1 - Math.exp(-dt * 9));
  const lim = maxSpeed * dt;
  return cur + Math.max(-lim, Math.min(lim, step));
}
