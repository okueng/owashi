// The 3D side of each fixture. Every frame they read their channels from the universes —
// they never know (or care) what wrote them.

import * as THREE from 'three';

const HOUSING = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.5, metalness: 0.6 });
const TUBE_GAIN = 2.6;
const TUBE_SPILL = 7;

// Zone i as the fixture outputs it (0–1, or more with its white LEDs on top), straight from DMX.
// The white LEDs draw as plain white: the strip's colour temperature isn't known.
function zoneOut(f, i, out) {
  const a = f.zone0 + i * 4, w = f.u[a + 3] / 255;
  out[0] = f.u[a] / 255 + w; out[1] = f.u[a + 1] / 255 + w; out[2] = f.u[a + 2] / 255 + w;
  return out;
}
// RGB all on is three times the light of one colour; keep white from blooming over everything
const whiteNorm = p => 1 / Math.max(1, (p[0] + p[1] + p[2]) / 2, p[0], p[1], p[2]);

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
    this.output = [0, 0, 0];   // the tube's average colour right now, 0–1, for its label
  }

  update() {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < this.n; i++) {
      const p = zoneOut(this.f, i, this.px), k = whiteNorm(p) * 255;
      r += p[0]; g += p[1]; b += p[2];
      this.data[i * 4] = p[0] * k; this.data[i * 4 + 1] = p[1] * k; this.data[i * 4 + 2] = p[2] * k; this.data[i * 4 + 3] = 255;
    }
    this.tex.needsUpdate = true;
    this.output[0] = r / this.n; this.output[1] = g / this.n; this.output[2] = b / this.n;
    const peak = Math.max(r, g, b);
    for (const l of this.lights) {
      if (peak > 0) l.color.setRGB(r / peak, g / peak, b / peak);
      l.intensity = (peak / this.n) * TUBE_SPILL;
    }
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
    this.output = [0, 0, 0];   // the beam's colour right now, 0–1, for its label
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
    this.output[0] = r * k; this.output[1] = g * k; this.output[2] = b * k;
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

// ── LED wash PAR: a flat can on the floor, twelve six-colour LEDs behind one face ──

// Its light in the haze is a wide, soft volume, not a pencil: a dozen soft discs strung along its axis, each as
// wide as the light is there. They always face the camera, so the glow reads from the side (a cone) and from the
// front (a halo round the can) alike. A hollow cone, as the beams use, all but vanishes when it points at you.
const PAR_HALF = 18, PAR_LEN = 3.6, PAR_R = 0.1, PUFFS = 12, PAR_GLOW = 1.0;
const hazeTexture = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d'), g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,.62)');
  g.addColorStop(0.5, 'rgba(255,255,255,.25)'); g.addColorStop(0.75, 'rgba(255,255,255,.06)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();

export class WashPar {
  // tilt: degrees from straight up, leaning towards the audience
  constructor(fixture, tilt = 0) {
    this.f = fixture;
    this.group = new THREE.Group();
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.14), HOUSING);
    foot.position.y = 0.01;
    this.head = new THREE.Group();
    this.head.position.y = 0.14;
    this.head.rotation.x = THREE.MathUtils.degToRad(tilt);
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.09, 28), HOUSING);
    this.lensMat = new THREE.MeshBasicMaterial({ color: 0, toneMapped: false });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(PAR_R, 28), this.lensMat);
    lens.rotation.x = -Math.PI / 2; lens.position.y = 0.046;

    // the glow in the haze: discs along the axis, thinning out as the light spreads (a column of haze through a
    // cone shows 1/r of the light) and fading away at the end
    this.puffs = [];
    for (let i = 0; i < PUFFS; i++) {
      const d = 0.12 + (PAR_LEN - 0.12) * (i / (PUFFS - 1)) ** 1.5, r = PAR_R + d * Math.tan(THREE.MathUtils.degToRad(PAR_HALF));
      const puff = new THREE.Sprite(new THREE.SpriteMaterial({ map: hazeTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
      puff.position.y = 0.05 + d;
      puff.scale.setScalar(2.4 * r);
      puff.userData.w = ((PAR_R + 0.05) / r) * (1 - (d / PAR_LEN) ** 2);
      this.puffs.push(puff);
    }

    this.spot = new THREE.SpotLight(0xffffff, 0, 0, THREE.MathUtils.degToRad(24), 0.7, 2);
    this.spot.position.y = 0.05;
    this.spot.target.position.y = 10;

    this.glare = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glareTexture, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    this.glare.position.y = 0.06;
    this.head.add(can, lens, ...this.puffs, this.spot, this.spot.target, this.glare);
    this.group.add(foot, this.head);

    this.dir = new THREE.Vector3(); this.lensW = new THREE.Vector3(); this.toCam = new THREE.Vector3();
    this.output = [0, 0, 0];
  }

  update(t, dt, camera, haze) {
    const f = this.f, ch = n => f.get(n) / 255;
    const k = ch('Dimmer') * f.def.gate(f.get('Strobe'), t);
    const w = ch('White'), am = ch('Amber'), uv = ch('UV');
    let r = ch('Red') + w + am + uv * 0.25, g = ch('Green') + w + am * 0.42, b = ch('Blue') + w * 0.92 + uv;
    const norm = 1 / Math.max(1, r, g, b, (r + g + b) / 2);   // all six on isn't six times the light
    r *= norm; g *= norm; b *= norm;
    this.output[0] = r * k; this.output[1] = g * k; this.output[2] = b * k;

    const glowK = k * haze * PAR_GLOW;
    for (const puff of this.puffs) {
      const w = glowK * puff.userData.w;
      puff.material.color.setRGB(r * w, g * w, b * w);
      puff.visible = glowK > 0;
    }
    this.lensMat.color.setRGB(r * k * 5, g * k * 5, b * k * 5);
    this.spot.color.setRGB(r, g, b);
    this.spot.intensity = k * 90;

    this.head.updateWorldMatrix(true, false);
    this.dir.set(0, 1, 0).transformDirection(this.head.matrixWorld);
    this.lensW.set(0, 0.06, 0).applyMatrix4(this.head.matrixWorld);
    const facing = Math.max(0, this.dir.dot(this.toCam.subVectors(camera.position, this.lensW).normalize()));
    const glow = k * (0.2 + 1.2 * facing ** 4);
    this.glare.material.color.setRGB(r * glow, g * glow, b * glow);
    this.glare.scale.setScalar(0.4 + 0.6 * facing ** 4);
    this.glare.visible = k > 0;
  }
}

function approach(cur, target, maxSpeed, dt) {
  const step = (target - cur) * (1 - Math.exp(-dt * 9));
  const lim = maxSpeed * dt;
  return cur + Math.max(-lim, Math.min(lim, step));
}
