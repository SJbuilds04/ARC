import * as THREE from "three";
import type { BuiltObject, ModelAction } from "./types";
import { part } from "./parts";
import { holoGain, holoTime } from "../holo";
import { beamMaterial, flash, glowLineMaterial, glowPoints, marker, rng } from "./fx";

/**
 * Frontier physics, animated: a pulsar sweeping its radiation beams, a particle collider event
 * display, and a tokamak fusion reactor with flowing plasma. ARC's own procedural models.
 */

const TAU = Math.PI * 2;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

const wrap = (content: THREE.Group, radius: number, extra: Omit<BuiltObject, "content" | "radius">): BuiltObject => {
  const g = new THREE.Group();
  g.add(content);
  return { content: g, radius, ...extra };
};

/** Polylines → one LineSegments buffer. */
function linesGeometry(polys: THREE.Vector3[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const poly of polys) for (let i = 0; i < poly.length - 1; i++) pos.push(poly[i].x, poly[i].y, poly[i].z, poly[i + 1].x, poly[i + 1].y, poly[i + 1].z);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pulsar
// ─────────────────────────────────────────────────────────────────────────────

export function buildPulsar(): BuiltObject {
  const R = rng(3);
  const content = new THREE.Group();
  const spin = new THREE.Group();
  content.add(spin);
  const tilt = new THREE.Group();
  tilt.rotation.z = 0.62; // magnetic axis tilted from the spin axis
  spin.add(tilt);

  // neutron star: hot, granular surface, brighter at the magnetic poles
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uTime: holoTime, uGain: holoGain, uPulse: { value: 0 } },
    vertexShader: /* glsl */ `varying vec3 vN; varying vec3 vP; varying vec3 vV;
      void main() { vN = normalize(normalMatrix * normal); vP = position; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform float uTime; uniform float uGain; uniform float uPulse; varying vec3 vN; varying vec3 vP; varying vec3 vV;
      float h(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float n3(vec3 x) { vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(h(i), h(i + vec3(1,0,0)), f.x), mix(h(i + vec3(0,1,0)), h(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(h(i + vec3(0,0,1)), h(i + vec3(1,0,1)), f.x), mix(h(i + vec3(0,1,1)), h(i + vec3(1,1,1)), f.x), f.y), f.z); }
      void main() {
        vec3 d = normalize(vP);
        float gran = n3(d * 22.0 + uTime * 0.3) * 0.6 + n3(d * 55.0) * 0.4;
        float pole = pow(abs(d.y), 8.0);
        float rim = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);
        vec3 c = mix(vec3(0.55, 0.75, 1.0), vec3(1.0), pole) * (0.7 + 0.5 * gran) + vec3(0.4, 0.7, 1.0) * rim;
        gl_FragColor = vec4(c * (1.2 + 1.6 * uPulse) * (0.6 + 0.8 * uGain), 1.0);
      }`,
  });
  const star = new THREE.Mesh(new THREE.SphereGeometry(0.13, 64, 40), starMat);
  star.userData.keepMaterial = true;
  tilt.add(star);
  const glow = flash(0x9fd8ff, 0.9);
  content.add(glow);

  // dipole field lines: r = L sin²θ around the magnetic axis
  const polys: THREE.Vector3[][] = [];
  for (const L of [0.34, 0.52, 0.78, 1.08]) {
    for (let k = 0; k < 8; k++) {
      const phi = (k / 8) * TAU + L;
      const line: THREE.Vector3[] = [];
      for (let i = 0; i <= 80; i++) {
        const th = 0.08 + (Math.PI - 0.16) * (i / 80);
        const r = L * Math.sin(th) ** 2;
        if (r < 0.135) {
          if (line.length > 1) polys.push(line.splice(0));
          else line.length = 0;
          continue;
        }
        line.push(V(r * Math.sin(th) * Math.cos(phi), r * Math.cos(th), r * Math.sin(th) * Math.sin(phi)));
      }
      if (line.length > 1) polys.push(line);
    }
  }
  const fieldMat = glowLineMaterial(0x7fc8ff, 0.42);
  const field = new THREE.LineSegments(linesGeometry(polys), fieldMat);
  field.userData.noPick = true;
  tilt.add(field);

  // radiation beams along the magnetic axis
  const beamMat = beamMaterial(0xc7e8ff, { intensity: 1.6, falloff: 1.6, pulse: 0.5, speed: 18 });
  const beams = new THREE.Group();
  tilt.add(beams);
  for (const s of [1, -1]) {
    const g = new THREE.ConeGeometry(0.3, 1.9, 48, 1, true);
    g.rotateX(Math.PI);
    g.translate(0, 0.95, 0);
    const m = new THREE.Mesh(g, beamMat);
    m.userData.keepMaterial = true;
    m.userData.noPick = true;
    if (s < 0) m.rotation.z = Math.PI;
    beams.add(m);
  }
  // particles streaming out along the beams
  const P = glowPoints(180, 0.018, 0xd8f0ff);
  tilt.add(P.points);
  const pState = Array.from({ length: P.count }, () => ({ s: R(), side: R() < 0.5 ? 1 : -1, a: R() * TAU, rf: Math.sqrt(R()) }));
  // rotation axis
  const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(0, -1.35, 0), V(0, 1.35, 0)]), glowLineMaterial(0xffffff, 0.22));
  content.add(axis);

  // ── actions ──
  const state = { spin: "Slow", field: true, beams: true };
  const anim = { spin: 1.4, field: 1, beams: 1 };
  const actions: ModelAction[] = [
    { id: "spin", label: "Spin", kind: "choice", options: ["Slow", "Fast"], words: ["spin", "rotation", "speed", "millisecond"], value: "Slow" },
    { id: "field", label: "Field lines", kind: "toggle", words: ["field", "field lines", "magnetic field", "magnetosphere"], value: true },
    { id: "beams", label: "Beams", kind: "toggle", words: ["beams", "beam", "radiation", "lighthouse", "jets"], value: true, parts: [star] },
  ];
  const parts = [
    part("Neutron star", "A collapsed star 20 km across: a teaspoon of it weighs a billion tonnes.", 1, marker(content, 0, 0.17, 0)),
    part("Magnetic field", "A trillion times Earth's: it channels particles into two beams.", 2, marker(tilt, 0.42, 0.1, 0)),
    part("Radiation beams", "Radio, X-ray and gamma beams that sweep past us like a lighthouse.", 1, marker(beams, 0, 1.0, 0)),
    part("Rotation axis", "It spins up to hundreds of times a second; we see a pulse each sweep.", 2, marker(content, 0, 1.3, 0)),
  ];

  const tmp = V();
  const camDir = V();
  glow.onBeforeRender = (_r, _s, camera) => {
    // a pulse whenever a beam points toward you
    tmp.set(0, 1, 0).applyQuaternion(tilt.getWorldQuaternion(new THREE.Quaternion()));
    camDir.copy(camera.position).sub(glow.getWorldPosition(V())).normalize();
    const d = Math.abs(tmp.dot(camDir));
    const pulse = THREE.MathUtils.smoothstep(d, 0.86, 0.99) * anim.beams;
    starMat.uniforms.uPulse.value = pulse;
    (glow.material as THREE.SpriteMaterial).opacity = 0.35 + 0.65 * pulse;
    glow.scale.setScalar(0.7 + 1.3 * pulse);
  };

  return wrap(content, 1.3, {
    parts,
    actions,
    act(id, value) {
      if (id === "spin") state.spin = value === "Fast" ? "Fast" : "Slow";
      if (id === "field") state.field = Boolean(value);
      if (id === "beams") state.beams = Boolean(value);
    },
    explode(a) {
      beams.scale.setScalar(1 + 0.4 * a);
      field.scale.setScalar(1 + 0.5 * a);
    },
    update(dt) {
      const k = 1 - Math.exp(-dt * 3);
      anim.spin += ((state.spin === "Fast" ? 9 : 1.4) - anim.spin) * k;
      anim.field += ((state.field ? 1 : 0) - anim.field) * k;
      anim.beams += ((state.beams ? 1 : 0) - anim.beams) * k;
      spin.rotation.y += dt * anim.spin;
      fieldMat.uniforms.uOpacity.value = 0.42 * anim.field;
      field.visible = anim.field > 0.01;
      beamMat.uniforms.uI.value = 1.6 * anim.beams;
      beams.visible = anim.beams > 0.01;
      for (let i = 0; i < P.count; i++) {
        const q = pState[i];
        q.s += dt * 0.45;
        if (q.s > 1) {
          q.s -= 1;
          q.a = R() * TAU;
        }
        const r = 0.28 * q.s * q.rf;
        P.pos.set([Math.cos(q.a) * r, q.side * (0.15 + q.s * 1.8), Math.sin(q.a) * r], i * 3);
        P.alpha[i] = anim.beams * Math.sin(Math.PI * q.s) * 0.85;
      }
      P.commit();
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Particle collider (event display, beam along z)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TRACKS = 30;
const TRACK_PTS = 48;

export function buildCollider(): BuiltObject {
  const R = rng(9);
  const content = new THREE.Group();
  const det = new THREE.Group();
  content.add(det);
  const steel = new THREE.MeshStandardMaterial({ color: 0xa9b1ba, metalness: 1, roughness: 0.3 });
  const translucent = (color: number, opacity: number) => new THREE.MeshStandardMaterial({ color, transparent: true, opacity, depthWrite: false, metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide });

  // beam pipe
  const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 2.6, 24, 1, true), steel);
  pipe.rotation.x = Math.PI / 2;
  det.add(pipe);
  // inner tracker: three silicon layers
  const tracker = new THREE.Group();
  det.add(tracker);
  const trackerLines: THREE.Vector3[][] = [];
  for (const r of [0.11, 0.18, 0.26]) {
    const layer = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.9, 48, 1, true), translucent(0x9fb8cc, 0.14));
    layer.rotation.x = Math.PI / 2;
    tracker.add(layer);
    for (const z of [-0.45, 0.45]) trackerLines.push(Array.from({ length: 49 }, (_, i) => V(Math.cos((i / 48) * TAU) * r, Math.sin((i / 48) * TAU) * r, z)));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      trackerLines.push([V(Math.cos(a) * r, Math.sin(a) * r, -0.45), V(Math.cos(a) * r, Math.sin(a) * r, 0.45)]);
    }
  }
  tracker.add(new THREE.LineSegments(linesGeometry(trackerLines), glowLineMaterial(0xbcd4ff, 0.3)));
  // solenoid
  const solenoid = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 1.0, 64, 1, true), translucent(0xc27a45, 0.22));
  solenoid.rotation.x = Math.PI / 2;
  det.add(solenoid);
  // calorimeters: ECAL (teal) and HCAL (amber) wedges
  const outer = new THREE.Group();
  det.add(outer);
  const ring = (rIn: number, rOut: number, n: number, color: number, opacity: number, length: number) => {
    const mat = translucent(color, opacity);
    const g = new THREE.BoxGeometry((TAU * rIn) / n * 0.86, rOut - rIn, length);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const m = new THREE.Mesh(g, mat);
      m.position.set(Math.cos(a) * (rIn + rOut) / 2, Math.sin(a) * (rIn + rOut) / 2, 0);
      m.rotation.z = a - Math.PI / 2;
      outer.add(m);
    }
  };
  ring(0.35, 0.45, 40, 0x3aa889, 0.42, 1.1);
  ring(0.48, 0.64, 30, 0xc98a3a, 0.34, 1.25);
  // muon chambers: octagon of red frames
  const muonLines: THREE.Vector3[][] = [];
  for (const r of [0.72, 0.8, 0.88]) {
    const oct = Array.from({ length: 9 }, (_, i) => V(Math.cos((i / 8) * TAU + Math.PI / 8) * r, Math.sin((i / 8) * TAU + Math.PI / 8) * r, 0));
    for (const z of [-0.7, 0, 0.7]) muonLines.push(oct.map((p) => V(p.x, p.y, z)));
    for (const p of oct.slice(0, 8)) muonLines.push([V(p.x, p.y, -0.7), V(p.x, p.y, 0.7)]);
  }
  outer.add(new THREE.LineSegments(linesGeometry(muonLines), glowLineMaterial(0xff5a4a, 0.45)));
  const backCap = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.9, 64), translucent(0x5a6878, 0.25));
  backCap.position.z = -0.72;
  outer.add(backCap);

  // tracks: a fixed buffer drawn progressively (attribute t = 0..1 along each track)
  const segs = MAX_TRACKS * (TRACK_PTS - 1);
  const tPos = new Float32Array(segs * 6);
  const tAlong = new Float32Array(segs * 2);
  const tColor = new Float32Array(segs * 6);
  const trackGeo = new THREE.BufferGeometry();
  trackGeo.setAttribute("position", new THREE.BufferAttribute(tPos, 3).setUsage(THREE.DynamicDrawUsage));
  trackGeo.setAttribute("along", new THREE.BufferAttribute(tAlong, 1).setUsage(THREE.DynamicDrawUsage));
  trackGeo.setAttribute("color", new THREE.BufferAttribute(tColor, 3).setUsage(THREE.DynamicDrawUsage));
  const trackMat = new THREE.ShaderMaterial({
    uniforms: { uProg: { value: 0 }, uFade: { value: 0 }, uGain: holoGain },
    vertexShader: /* glsl */ `attribute float along; attribute vec3 color; varying float vT; varying vec3 vC;
      void main() { vT = along; vC = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform float uProg; uniform float uFade; uniform float uGain; varying float vT; varying vec3 vC;
      void main() { if (vT > uProg) discard; float head = smoothstep(uProg - 0.08, uProg, vT) * step(uProg, 0.999);
        float a = uFade * (0.8 + 0.2 * head);
        gl_FragColor = vec4(vC * (1.8 + 2.0 * head) * a * (0.6 + 0.8 * uGain), a); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const tracks = new THREE.LineSegments(trackGeo, trackMat);
  tracks.frustumCulled = false;
  tracks.userData.noPick = true;
  content.add(tracks);
  // tracker hits (where each track crosses a silicon layer)
  const hits = glowPoints(MAX_TRACKS * 3, 0.022, 0xffffff);
  content.add(hits.points);
  const hitT = new Float32Array(MAX_TRACKS * 3);
  // calorimeter energy towers
  const towers: THREE.Mesh[] = [];
  const towerMat = beamMaterial(0xffd36a, { intensity: 1.0, falloff: 0.4 });
  const towerGeo = new THREE.BoxGeometry(0.03, 1, 0.03);
  towerGeo.translate(0, 0.5, 0);
  for (let i = 0; i < MAX_TRACKS; i++) {
    const m = new THREE.Mesh(towerGeo, towerMat);
    m.visible = false;
    m.userData.keepMaterial = true;
    m.userData.noPick = true;
    content.add(m);
    towers.push(m);
  }
  const towerH = new Float32Array(MAX_TRACKS);
  // incoming bunches + collision flash
  const bunches = glowPoints(2, 0.07, 0x9fe0ff);
  content.add(bunches.points);
  const bang = flash(0xffffff, 0.4);
  bang.visible = false;
  content.add(bang);

  const newEvent = () => {
    const n = 14 + Math.floor(R() * (MAX_TRACKS - 14));
    let muons = 0;
    for (let tr = 0; tr < MAX_TRACKS; tr++) {
      const base = tr * (TRACK_PTS - 1);
      if (tr >= n) {
        for (let s = 0; s < TRACK_PTS - 1; s++) tAlong.set([2, 2], (base + s) * 2);
        towers[tr].visible = false;
        for (let li = 0; li < 3; li++) hitT[tr * 3 + li] = 2;
        continue;
      }
      const isMuon = muons < 2 && R() < 0.12;
      if (isMuon) muons++;
      const q = R() < 0.5 ? 1 : -1;
      const pt = isMuon ? 2 + R() * 4 : 0.25 + Math.pow(R(), 2) * 3;
      const Rc = pt * 0.9;
      const phi0 = R() * TAU;
      const eta = (R() - 0.5) * 2.6;
      const cotT = Math.sinh(eta) * 0.55;
      const rEnd = isMuon ? 0.92 : 0.36 + R() * 0.28;
      const col = isMuon ? [1.0, 0.35, 0.3] : R() < 0.25 ? [0.45, 1.0, 0.55] : [1.0, 0.82, 0.35];
      const pts: THREE.Vector3[] = [];
      const maxS = Math.min(rEnd * 2.4, Math.PI * Rc);
      for (let i = 0; i < TRACK_PTS; i++) {
        const s = (maxS * i) / (TRACK_PTS - 1);
        const x = q * Rc * (Math.sin(phi0 + (q * s) / Rc) - Math.sin(phi0));
        const y = -q * Rc * (Math.cos(phi0 + (q * s) / Rc) - Math.cos(phi0));
        const z = THREE.MathUtils.clamp(s * cotT, -1.1, 1.1);
        pts.push(V(x, y, z));
        if (Math.hypot(x, y) > rEnd) break;
      }
      while (pts.length < TRACK_PTS) pts.push(pts[pts.length - 1].clone());
      [0.11, 0.18, 0.26].forEach((layer, li) => {
        const idx = tr * 3 + li;
        hits.alpha[idx] = 0;
        hitT[idx] = 2;
        for (let i = 1; i < TRACK_PTS; i++) {
          if (Math.hypot(pts[i].x, pts[i].y) >= layer) {
            hits.pos.set([pts[i].x, pts[i].y, pts[i].z], idx * 3);
            hits.color.set([...col], idx * 3);
            hitT[idx] = i / (TRACK_PTS - 1);
            break;
          }
        }
      });
      for (let s = 0; s < TRACK_PTS - 1; s++) {
        const a = pts[s];
        const b = pts[s + 1];
        tPos.set([a.x, a.y, a.z, b.x, b.y, b.z], (base + s) * 6);
        tAlong.set([s / (TRACK_PTS - 1), (s + 1) / (TRACK_PTS - 1)], (base + s) * 2);
        tColor.set([...col, ...col], (base + s) * 6);
      }
      // energy deposit where a hadron / electron stops in the calorimeters
      const end = pts[TRACK_PTS - 1];
      const tw = towers[tr];
      if (!isMuon && Math.hypot(end.x, end.y) > 0.33) {
        tw.visible = true;
        tw.position.copy(end);
        tw.rotation.set(0, 0, Math.atan2(end.y, end.x) - Math.PI / 2);
        towerH[tr] = 0.05 + R() * 0.22;
      } else {
        tw.visible = false;
        towerH[tr] = 0;
      }
    }
    trackGeo.attributes.position.needsUpdate = true;
    trackGeo.attributes.along.needsUpdate = true;
    trackGeo.attributes.color.needsUpdate = true;
  };

  // ── actions ──
  const state = { rate: "Slow", detector: true };
  const anim = { detector: 1 };
  let clock = 0;
  let cycle = 4.2;
  const actions: ModelAction[] = [
    { id: "collide", label: "Collide", kind: "trigger", words: ["collide", "collision", "smash", "fire", "event"], value: false, parts: [pipe] },
    { id: "rate", label: "Rate", kind: "choice", options: ["Slow", "Fast", "Paused"], words: ["rate", "speed", "pause", "play"], value: "Slow" },
    { id: "detector", label: "Detector", kind: "toggle", words: ["detector", "calorimeter", "layers", "outer"], value: true },
  ];
  const parts = [
    part("Collision point", "Two proton bunches meet head-on at nearly the speed of light.", 1, marker(content, 0, 0.03, 0)),
    part("Particle tracks", "Charged particles curl in the magnet; the curve tells their momentum.", 1, marker(content, 0.2, 0.2, 0)),
    part("Inner tracker", "Silicon layers that record each particle's path.", 2, marker(tracker, 0, 0.26, 0.2), tracker),
    part("Calorimeters", "Stop particles and measure their energy (the glowing towers).", 2, marker(outer, 0, 0.56, 0)),
    part("Muon chambers", "Only muons get this far; the outer frames track them.", 2, marker(outer, 0.62, 0.62, 0)),
    part("Beam pipe", "Ultra-high vacuum tube the beams travel through.", 2, marker(pipe, 0, 0, 0.9), pipe),
  ];

  newEvent();
  return wrap(content, 1.25, {
    parts,
    actions,
    act(id, value) {
      if (id === "collide") clock = 0;
      if (id === "rate") state.rate = ["Slow", "Fast", "Paused"].includes(String(value)) ? String(value) : "Slow";
      if (id === "detector") state.detector = Boolean(value);
    },
    explode(a) {
      outer.scale.setScalar(1 + 0.35 * a);
      tracker.position.z = 0.6 * a;
    },
    update(dt) {
      const k = 1 - Math.exp(-dt * 3);
      anim.detector += ((state.detector ? 1 : 0) - anim.detector) * k;
      outer.visible = solenoid.visible = anim.detector > 0.02;
      outer.scale.z = Math.max(0.001, anim.detector);
      cycle = state.rate === "Fast" ? 2.4 : 4.2;
      if (state.rate !== "Paused" || clock < 1.1) clock += dt;
      if (clock >= cycle) {
        clock = 0;
      }
      if (clock < dt + 1e-6) newEvent();
      // 0–0.35: bunches fly in · 0.35: collision · then tracks grow, hold, fade
      const approach = THREE.MathUtils.clamp(clock / 0.35, 0, 1);
      bunches.pos.set([0, 0, 1.3 * (1 - approach), 0, 0, -1.3 * (1 - approach)]);
      bunches.alpha[0] = bunches.alpha[1] = approach < 1 ? 1 : 0;
      bunches.commit();
      const tb = clock - 0.35;
      bang.visible = tb > 0 && tb < 0.4;
      if (bang.visible) {
        (bang.material as THREE.SpriteMaterial).opacity = 1 - tb / 0.4;
        bang.scale.setScalar(0.15 + tb * 1.4);
      }
      trackMat.uniforms.uProg.value = THREE.MathUtils.clamp(tb / 0.6, 0, 1);
      const fadeStart = cycle - 0.7;
      trackMat.uniforms.uFade.value = tb < 0 ? 0 : state.rate === "Paused" ? 1 : 1 - THREE.MathUtils.clamp((clock - fadeStart) / 0.7, 0, 1);
      for (let i = 0; i < MAX_TRACKS; i++) {
        if (!towers[i].visible) continue;
        const grow = THREE.MathUtils.clamp((tb - 0.45) / 0.3, 0, 1);
        towers[i].scale.set(1, Math.max(0.001, towerH[i] * grow), 1);
      }
      towerMat.uniforms.uI.value = trackMat.uniforms.uFade.value;
      const prog = trackMat.uniforms.uProg.value;
      for (let i = 0; i < MAX_TRACKS * 3; i++) hits.alpha[i] = hitT[i] <= prog ? trackMat.uniforms.uFade.value : 0;
      hits.commit();
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokamak fusion reactor
// ─────────────────────────────────────────────────────────────────────────────

export function buildTokamak(): BuiltObject {
  const content = new THREE.Group();
  const RM = 0.72; // major radius
  const rv = 0.27; // vessel minor radius
  const steel = new THREE.MeshStandardMaterial({ color: 0xa3abb5, metalness: 1, roughness: 0.32, side: THREE.DoubleSide });
  const dark = new THREE.MeshStandardMaterial({ color: 0x262b32, metalness: 0.85, roughness: 0.4 });
  const copper = new THREE.MeshStandardMaterial({ color: 0xb8743f, metalness: 1, roughness: 0.34 });

  // everything is built around the y axis; the cut-away faces the viewer
  const reactor = new THREE.Group();
  reactor.rotation.y = (5 * Math.PI) / 4;
  content.add(reactor);

  // vacuum vessel: 3/4 of the torus, so the plasma is visible
  const vessel = new THREE.Group();
  vessel.rotation.x = Math.PI / 2;
  reactor.add(vessel);
  vessel.add(new THREE.Mesh(new THREE.TorusGeometry(RM, rv, 40, 120, Math.PI * 1.5), steel));
  for (const [x, y, ry] of [
    [RM, 0, 0],
    [0, -RM, Math.PI / 2],
  ] as const) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(rv, 0.012, 10, 64), dark);
    rim.position.set(x, y, 0);
    if (ry) rim.rotation.y = ry;
    else rim.rotation.x = Math.PI / 2;
    vessel.add(rim);
  }

  // plasma: flowing filaments in the torus, hotter when heated
  const plasmaMat = new THREE.ShaderMaterial({
    uniforms: { uTime: holoTime, uGain: holoGain, uHeat: { value: 0 }, uOn: { value: 1 }, uFlow: { value: 1 } },
    vertexShader: /* glsl */ `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() { vUv = uv; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `uniform float uTime; uniform float uGain; uniform float uHeat; uniform float uOn; uniform float uFlow;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n2(vec2 x) { vec2 i = floor(x); vec2 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      void main() {
        float u = vUv.x * 40.0;   // around the torus (wraps)
        float v = vUv.y;
        float t = uTime * uFlow;
        // filaments twisted into a helix, flowing round the torus
        float f = n2(vec2(u - t * 6.0 + v * 9.0, v * 6.0 + t * 0.6)) * 0.6 + n2(vec2(u * 2.3 - t * 9.0 + v * 17.0, v * 13.0)) * 0.4;
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float body = pow(facing, 1.4) * 0.6 + pow(1.0 - facing, 2.0) * 0.6;
        vec3 cool = mix(vec3(1.0, 0.35, 0.85), vec3(0.55, 0.35, 1.0), f);
        vec3 hot = mix(vec3(0.7, 0.85, 1.0), vec3(1.0), f);
        vec3 c = mix(cool, hot, uHeat);
        float a = (0.35 + 0.65 * smoothstep(0.25, 0.85, f)) * body * uOn;
        gl_FragColor = vec4(c * a * (1.9 + 1.2 * uHeat) * (0.55 + 0.8 * uGain), a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const plasma = new THREE.Mesh(new THREE.TorusGeometry(RM, 0.19, 48, 220), plasmaMat);
  plasma.rotation.x = Math.PI / 2;
  plasma.userData.keepMaterial = true;
  plasma.userData.noPick = true;
  reactor.add(plasma);
  const glows: THREE.PointLight[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + 0.5;
    const l = new THREE.PointLight(0xff7ad8, 0.35, 1.4, 2);
    l.position.set(Math.cos(a) * RM, 0, Math.sin(a) * RM);
    reactor.add(l);
    glows.push(l);
  }

  // helical magnetic field lines round the plasma (toroidal + poloidal = helix)
  const fieldPolys: THREE.Vector3[][] = [];
  for (let k = 0; k < 7; k++) {
    const line: THREE.Vector3[] = [];
    const off = (k / 7) * TAU;
    for (let i = 0; i <= 900; i++) {
      const phi = (i / 900) * TAU;
      const psi = off + phi * 3; // three poloidal turns per lap
      const rr = 0.215;
      line.push(V((RM + rr * Math.cos(psi)) * Math.cos(phi), rr * Math.sin(psi), (RM + rr * Math.cos(psi)) * Math.sin(phi)));
    }
    fieldPolys.push(line);
  }
  const fieldMat = glowLineMaterial(0x7fe3ff, 0.32);
  const fieldLines = new THREE.LineSegments(linesGeometry(fieldPolys), fieldMat);
  fieldLines.userData.noPick = true;
  reactor.add(fieldLines);

  // toroidal field coils (D-shaped), leaving the cut-away open
  const coils = new THREE.Group();
  reactor.add(coils);
  class DCoil extends THREE.Curve<THREE.Vector3> {
    constructor() {
      super();
    }
    getPoint(t: number, out = new THREE.Vector3()) {
      const a = t * TAU;
      const c = Math.cos(a);
      const rho = c >= 0 ? RM + 0.38 * Math.pow(c, 0.7) : RM - 0.33 * Math.pow(-c, 0.3);
      return out.set(rho, 0.47 * Math.sin(a), 0);
    }
  }
  const coilGeo = new THREE.TubeGeometry(new DCoil(), 120, 0.034, 10, true);
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * TAU;
    // the vessel's open quarter is between 270° and 360° of its own arc
    const deg = ((ang * 180) / Math.PI + 360) % 360;
    if (deg > 272 && deg < 358) continue;
    const coil = new THREE.Mesh(coilGeo, i % 2 ? copper : dark);
    coil.rotation.y = -ang;
    coils.add(coil);
  }
  // central solenoid with banding
  const solenoid = new THREE.Group();
  reactor.add(solenoid);
  solenoid.add(new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 1.0, 48), copper));
  for (let i = 0; i < 9; i++) {
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.203, 0.008, 8, 48), dark);
    band.rotation.x = Math.PI / 2;
    band.position.y = -0.44 + i * 0.11;
    solenoid.add(band);
  }
  // poloidal field coils
  const pf = new THREE.Group();
  reactor.add(pf);
  for (const [r, y] of [
    [1.12, 0.36],
    [1.12, -0.36],
    [0.5, 0.56],
    [0.5, -0.56],
  ] as const) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.032, 12, 96), dark);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = y;
    pf.add(ring);
  }
  // diagnostic ports on the outer equator
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * TAU + 0.3;
    const deg = ((ang * 180) / Math.PI + 360) % 360;
    if (deg > 265 && deg < 360) continue;
    const port = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.12), steel);
    port.position.set(Math.cos(ang) * (RM + rv + 0.05), 0, Math.sin(ang) * (RM + rv + 0.05));
    port.rotation.y = -ang;
    reactor.add(port);
  }
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.25, 0.06, 64), dark);
  base.position.y = -0.62;
  content.add(base);

  // ── actions ──
  const state = { plasma: true, heating: "Low", field: true };
  const anim = { on: 1, heat: 0, field: 1 };
  const actions: ModelAction[] = [
    { id: "plasma", label: "Plasma", kind: "toggle", words: ["plasma", "ignite", "ignition", "fusion", "reactor"], value: true, parts: [plasma] },
    { id: "heating", label: "Heating", kind: "choice", options: ["Low", "High"], words: ["heating", "heat", "temperature", "power"], value: "Low" },
    { id: "field", label: "Field lines", kind: "toggle", words: ["field", "field lines", "magnetic field", "helix"], value: true },
  ];
  const parts = [
    part("Plasma", "Hydrogen at ~150 million °C, ten times hotter than the Sun's core.", 1, marker(plasma, RM, 0, 0.22)),
    part("Toroidal field coils", "Huge magnets that bend the plasma into a ring it can't escape.", 1, marker(coils, RM + 0.4, 0.3, 0), coils),
    part("Central solenoid", "Drives a current through the plasma, heating and confining it.", 2, marker(solenoid, 0, 0.55, 0), solenoid),
    part("Vacuum vessel", "Steel doughnut holding the plasma in near-perfect vacuum.", 2, marker(vessel, -RM, 0, 0.3), vessel),
    part("Poloidal coils", "Shape and position the plasma inside the vessel.", 2, marker(pf, 1.12, 0.4, 0), pf),
    part("Magnetic field lines", "Twisted into a helix so the plasma stays balanced.", 2, marker(fieldLines, 0, 0.24, RM), fieldLines),
  ];

  return wrap(content, 1.3, {
    parts,
    actions,
    act(id, value) {
      if (id === "plasma") state.plasma = Boolean(value);
      if (id === "heating") state.heating = value === "High" ? "High" : "Low";
      if (id === "field") state.field = Boolean(value);
    },
    explode(a) {
      coils.scale.setScalar(1 + 0.3 * a);
      pf.position.y = 0;
      pf.scale.set(1 + 0.25 * a, 1 + 0.9 * a, 1 + 0.25 * a);
      solenoid.position.y = 0.7 * a;
      vessel.position.y = -0.25 * a;
    },
    update(dt) {
      const k = 1 - Math.exp(-dt * 2);
      anim.on += ((state.plasma ? 1 : 0) - anim.on) * k;
      anim.heat += ((state.heating === "High" ? 1 : 0) - anim.heat) * k;
      anim.field += ((state.field ? 1 : 0) - anim.field) * k;
      plasmaMat.uniforms.uOn.value = anim.on;
      plasmaMat.uniforms.uHeat.value = anim.heat;
      plasmaMat.uniforms.uFlow.value = 0.8 + anim.heat * 0.9;
      plasma.visible = anim.on > 0.01;
      for (const l of glows) {
        l.intensity = 0.35 * anim.on * (1 + anim.heat) * holoGain.value;
        l.color.setHSL(0.86 - 0.3 * anim.heat, 0.8, 0.7);
      }
      fieldMat.uniforms.uOpacity.value = 0.32 * anim.field;
      fieldLines.visible = anim.field > 0.01;
      fieldLines.rotation.y += dt * (0.35 + 0.5 * anim.heat);
    },
  });
}
