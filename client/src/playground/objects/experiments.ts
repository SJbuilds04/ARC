import * as THREE from "three";
import type { BuiltObject, ModelAction } from "./types";
import { at, centerOf, part } from "./parts";

/** Famous physics experiments, animated and interactive. */

const TAU = Math.PI * 2;
const chrome = () => new THREE.MeshStandardMaterial({ color: 0xe8edf2, metalness: 1, roughness: 0.08 });
const darkMetal = () => new THREE.MeshStandardMaterial({ color: 0x2a2f36, metalness: 0.85, roughness: 0.4 });
const WAVELENGTHS: Record<string, { color: THREE.Color; k: number }> = {
  Red: { color: new THREE.Color(1.0, 0.18, 0.12), k: 34 },
  Green: { color: new THREE.Color(0.25, 1.0, 0.35), k: 42 },
  Violet: { color: new THREE.Color(0.62, 0.3, 1.0), k: 52 },
};

// ─── Young's double slit ───

const FIELD_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform float uTime;
  uniform float uK;
  uniform vec3 uColor;
  uniform float uObserve;  // 0 = waves interfere, 1 = which-way detector on
  uniform float uSlitX;
  uniform float uD;
  void main() {
    // plane coords: x from -1.05 (source) to 1.05 (screen), z from -0.55 to 0.55
    float x = mix(-1.05, 1.05, vUv.x);
    float z = mix(-0.55, 0.55, vUv.y);
    float a;
    if (x < uSlitX) {
      a = cos(uK * (x + 1.05) - uTime * 6.0);
      a = a * a * 0.8;
    } else {
      float r1 = distance(vec2(x, z), vec2(uSlitX, -uD));
      float r2 = distance(vec2(x, z), vec2(uSlitX, uD));
      float w1 = cos(uK * r1 - uTime * 6.0) / sqrt(r1 + 0.05);
      float w2 = cos(uK * r2 - uTime * 6.0) / sqrt(r2 + 0.05);
      float cohI = (w1 + w2) * (w1 + w2) * 0.18;
      float incoherent = (w1 * w1 + w2 * w2) * 0.18;
      a = mix(cohI, incoherent, uObserve);
    }
    float edge = smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.94, vUv.y);
    gl_FragColor = vec4(uColor * a * edge, a * edge * 0.9);
  }`;

const SCREEN_FRAG = /* glsl */ `
  varying vec2 vUv;
  uniform float uK;
  uniform vec3 uColor;
  uniform float uObserve;
  uniform float uD;
  void main() {
    float z = mix(-0.55, 0.55, vUv.x);
    float L = 1.05 - (-0.2);
    // two-slit fringes under a single-slit envelope; with a detector: two plain bands
    float phase = uK * (2.0 * uD) * z / sqrt(L * L + z * z) * 0.5;
    float fringes = cos(phase) * cos(phase);
    float env = exp(-z * z * 9.0);
    float bands = exp(-pow((z - uD * 1.8), 2.0) * 40.0) + exp(-pow((z + uD * 1.8), 2.0) * 40.0);
    float I = mix(fringes * env, bands * 0.8, uObserve);
    float v = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
    gl_FragColor = vec4(uColor * I * 1.6 * v + vec3(0.03), 1.0);
  }`;

const QUAD_VERT = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export function buildDoubleSlit(): BuiltObject {
  const content = new THREE.Group();
  const SLIT_X = -0.2;
  const D = 0.09;
  const table = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.05, 1.25), new THREE.MeshStandardMaterial({ color: 0x0c1118, metalness: 0.4, roughness: 0.6 }));
  table.position.y = -0.03;
  table.receiveShadow = true;
  content.add(table);

  const uniforms = {
    uTime: { value: 0 },
    uK: { value: WAVELENGTHS.Red.k },
    uColor: { value: WAVELENGTHS.Red.color.clone() },
    uObserve: { value: 0 },
    uSlitX: { value: SLIT_X },
    uD: { value: D },
  };
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 1.1, 1, 1),
    new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: FIELD_FRAG, uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  );
  field.rotation.x = -Math.PI / 2;
  field.position.y = 0.002;
  field.userData.keepMaterial = true;
  field.userData.noPick = true;
  content.add(field);

  // Laser source
  const laser = new THREE.Group();
  laser.position.set(-1.05, 0.08, 0);
  content.add(laser);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.16), darkMetal());
  body.castShadow = true;
  laser.add(body);
  const aperture = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24), new THREE.MeshBasicMaterial({ color: uniforms.uColor.value, toneMapped: false }));
  aperture.rotation.y = Math.PI / 2;
  aperture.position.x = 0.111;
  aperture.userData.keepMaterial = true;
  laser.add(aperture);

  // Barrier with two slits (z = ±D)
  const barrier = new THREE.Group();
  barrier.position.x = SLIT_X;
  content.add(barrier);
  const bm = new THREE.MeshStandardMaterial({ color: 0x9aa4ae, metalness: 0.9, roughness: 0.35 });
  const slitW = 0.03;
  for (const [z0, z1] of [[-0.55, -D - slitW / 2], [-D + slitW / 2, D - slitW / 2], [D + slitW / 2, 0.55]]) {
    const seg = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.3, z1 - z0), bm);
    seg.position.set(0, 0.15, (z0 + z1) / 2);
    seg.castShadow = true;
    barrier.add(seg);
  }

  // Detection screen with the live pattern
  const screen = new THREE.Mesh(
    new THREE.PlaneGeometry(1.1, 0.34),
    new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: SCREEN_FRAG, uniforms, toneMapped: false }),
  );
  screen.rotation.y = -Math.PI / 2;
  screen.position.set(1.06, 0.17, 0);
  screen.userData.keepMaterial = true;
  content.add(screen);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.38, 1.16), darkMetal());
  frame.position.set(1.085, 0.17, 0);
  content.add(frame);

  // Which-way detector (observer)
  const detector = new THREE.Group();
  detector.position.set(SLIT_X + 0.12, 0.32, -0.32);
  content.add(detector);
  const cam = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.12, 20), darkMetal());
  cam.rotation.z = Math.PI / 2;
  cam.rotation.y = -0.9;
  detector.add(cam);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x331010, toneMapped: false });
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 8), ledMat);
  led.position.y = 0.05;
  led.userData.keepMaterial = true;
  detector.add(led);

  const state = { observer: false, wavelength: "Red" };
  const anim = { observe: 0 };
  const actions: ModelAction[] = [
    { id: "observer", label: "Which-way detector", kind: "toggle", words: ["observer", "detector", "observe", "measure", "measurement", "watch"], value: false, parts: [detector] },
    { id: "wavelength", label: "Wavelength", kind: "choice", options: ["Red", "Green", "Violet"], words: ["wavelength", "laser", "light", "colour", "color"], value: "Red", parts: [laser] },
  ];
  const parts = [
    part("Light source", "Coherent laser light, one wavelength.", 1, at(laser, 0, 0.1, 0), laser),
    part("Double slit", "Two narrow openings: each photon can pass through both.", 1, at(barrier, 0, 0.32, 0), barrier),
    part("Interference fringes", "Bright and dark bands where waves add and cancel.", 1, at(screen, 0, 0.2, 0), screen),
    part("Which-way detector", "Watching the slits destroys the interference: wave–particle duality.", 1, at(detector, 0, 0.06, 0), detector),
    part("Wave field", "Wavefronts spreading from each slit and overlapping.", 2, at(content, 0.45, 0.03, 0.25)),
  ];
  content.position.y = -0.15;
  const group = new THREE.Group();
  group.add(content);
  return {
    content: group,
    radius: 1.2,
    parts,
    actions,
    act(id, value) {
      if (id === "observer") state.observer = Boolean(value);
      if (id === "wavelength" && typeof value === "string" && WAVELENGTHS[value]) state.wavelength = value;
    },
    update(dt, t) {
      const k = 1 - Math.exp(-dt * 3);
      anim.observe += ((state.observer ? 1 : 0) - anim.observe) * k;
      uniforms.uObserve.value = anim.observe;
      uniforms.uTime.value = t;
      const w = WAVELENGTHS[state.wavelength];
      uniforms.uK.value += (w.k - uniforms.uK.value) * k;
      uniforms.uColor.value.lerp(w.color, k);
      ledMat.color.setRGB(0.2 + 0.8 * anim.observe * (0.6 + 0.4 * Math.sin(t * 6)), 0.06, 0.05);
    },
  };
}

// ─── Newton's cradle ───

export function buildNewtonCradle(): BuiltObject {
  const content = new THREE.Group();
  const frameMat = chrome();
  const W = 1.1;
  const H = 1.0;
  const D = 0.5;
  const base = new THREE.Mesh(new THREE.BoxGeometry(W + 0.3, 0.06, D + 0.2), new THREE.MeshStandardMaterial({ color: 0x15191f, metalness: 0.5, roughness: 0.5 }));
  base.position.y = 0.03;
  base.receiveShadow = true;
  content.add(base);
  const frame = new THREE.Group();
  content.add(frame);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, H, 12), frameMat);
      post.position.set((sx * W) / 2, H / 2 + 0.06, (sz * D) / 2);
      frame.add(post);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, W, 12), frameMat);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, H + 0.06, (sx * D) / 2);
    frame.add(bar);
  }
  const pivotY = H + 0.06;
  const L = 0.62;
  const R = 0.075;
  const ballMat = chrome();
  const lineMat = new THREE.LineBasicMaterial({ color: 0xcfd8e0, transparent: true, opacity: 0.7 });
  const balls: THREE.Group[] = [];
  for (let i = 0; i < 5; i++) {
    const pend = new THREE.Group();
    pend.position.set((i - 2) * R * 2.02, pivotY, 0);
    content.add(pend);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(R, 32, 24), ballMat);
    ball.position.y = -L;
    ball.castShadow = true;
    pend.add(ball);
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -L + R, 0), new THREE.Vector3(0, 0, D / 2), new THREE.Vector3(0, -L + R, 0), new THREE.Vector3(0, 0, -D / 2)]);
    const strings = new THREE.LineSegments(geo, lineMat);
    strings.userData.noPick = true;
    pend.add(strings);
    balls.push(pend);
  }

  const state = { swing: "1 ball" };
  let amp = 0.55;
  let phase = 0;
  const actions: ModelAction[] = [{ id: "swing", label: "Swing", kind: "choice", options: ["1 ball", "2 balls", "3 balls", "Stop"], words: ["swing", "balls", "pull", "release", "cradle", "stop"], value: "1 ball", parts: balls }];
  const parts = [
    part("Steel balls", "Identical masses: momentum passes straight through the row.", 1, at(balls[2], 0, -L, R)),
    part("Strings", "Each ball hangs on a V so it swings in one plane.", 2, at(balls[0], 0, -L / 2, 0)),
    part("Frame", "Rigid support; energy loss to it slowly damps the motion.", 2, centerOf(frame, 0.4), frame),
  ];
  content.position.y = -0.6;
  const group = new THREE.Group();
  group.add(content);
  return {
    content: group,
    radius: 1.0,
    parts,
    actions,
    act(id, value) {
      if (id !== "swing") return;
      state.swing = String(value);
      amp = state.swing === "Stop" ? amp : 0.55;
    },
    update(dt) {
      const n = state.swing === "2 balls" ? 2 : state.swing === "3 balls" ? 3 : 1;
      if (state.swing === "Stop") amp *= Math.exp(-dt * 2.5);
      else amp = Math.max(0.2, amp * Math.exp(-dt * 0.02));
      phase += dt * Math.sqrt(9.8 / L);
      const s = Math.sin(phase) * amp;
      balls.forEach((b, i) => {
        // left n balls swing out when s < 0, right n balls when s > 0 (collisions in the middle)
        b.rotation.z = (s < 0 && i < n ? s : 0) + (s > 0 && i >= 5 - n ? s : 0);
      });
    },
  };
}

// ─── Newton's prism ───

export function buildPrism(): BuiltObject {
  const content = new THREE.Group();
  const tri = new THREE.Shape();
  tri.moveTo(-0.32, -0.28);
  tri.lineTo(0.32, -0.28);
  tri.lineTo(0, 0.28);
  tri.closePath();
  const prismGeo = new THREE.ExtrudeGeometry(tri, { depth: 0.5, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01, bevelSegments: 2 });
  prismGeo.translate(0, 0, -0.25);
  const prism = new THREE.Mesh(prismGeo, new THREE.MeshPhysicalMaterial({ color: 0xffffff, metalness: 0, roughness: 0.02, transmission: 1, thickness: 0.5, ior: 1.52, transparent: true, opacity: 0.6, clearcoat: 1 }));
  prism.castShadow = true;
  content.add(prism);
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 0.06, 48), darkMetal());
  stand.position.y = -0.31;
  content.add(stand);

  const beamMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const white = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.0, 10), beamMat);
  white.rotation.z = Math.PI / 2 + 0.2;
  white.position.set(-0.62, -0.08, 0);
  white.userData.keepMaterial = true;
  content.add(white);
  const spectrum = new THREE.Group();
  content.add(spectrum);
  const colors = [0xff2020, 0xff8a1a, 0xffe41a, 0x34e04a, 0x2aa8ff, 0x4a3cff, 0xa040ff];
  const beams: THREE.MeshBasicMaterial[] = [];
  colors.forEach((c, i) => {
    const m = new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.03, 1.1, 10), m);
    // red bends least, violet most: a fan leaving the prism's right face, heading down-right
    const ang = -Math.PI / 2 - (0.18 + i * 0.05);
    const dx = -Math.sin(ang);
    const dy = Math.cos(ang);
    beam.rotation.z = ang;
    beam.position.set(0.14 + dx * 0.55, -0.02 + dy * 0.55, 0);
    beam.userData.keepMaterial = true;
    spectrum.add(beam);
    beams.push(m);
  });

  const state = { beam: true };
  let on = 1;
  const actions: ModelAction[] = [{ id: "beam", label: "Light beam", kind: "toggle", words: ["beam", "light", "laser"], value: true, parts: [white, prism] }];
  const parts = [
    part("White light", "A mix of every visible wavelength.", 1, at(white, 0, 0.3, 0.02)),
    part("Glass prism", "Glass bends violet more than red (dispersion).", 1, at(prism, 0, 0.1, 0.26), prism),
    part("Spectrum", "Red · orange · yellow · green · blue · indigo · violet.", 1, at(spectrum, 0.75, -0.25, 0)),
  ];
  const group = new THREE.Group();
  group.add(content);
  return {
    content: group,
    radius: 1.0,
    parts,
    actions,
    act(id, value) {
      if (id === "beam") state.beam = Boolean(value);
    },
    update(dt, t) {
      on += ((state.beam ? 1 : 0) - on) * (1 - Math.exp(-dt * 4));
      beamMat.opacity = 0.95 * on;
      beams.forEach((m, i) => (m.opacity = 0.85 * on * (0.9 + 0.1 * Math.sin(t * 3 + i))));
      void TAU;
    },
  };
}
