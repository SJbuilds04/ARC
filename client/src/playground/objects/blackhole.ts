import * as THREE from "three";
import type { BuiltObject, ModelAction } from "./types";
import { at, part } from "./parts";

/**
 * Gargantua — a ray-marched black hole in the spirit of Interstellar. Light rays bend around
 * the hole (photon geodesics, Schwarzschild approximation), so the far side of the accretion
 * disk appears lensed over and under the shadow; the approaching side is Doppler-brightened;
 * background stars are lensed too. Rendered inside a box; transparent everywhere else.
 */

const VERT = /* glsl */ `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vPos;
  uniform vec3 uCam;      // camera position in object space
  uniform float uTime;
  uniform float uSpin;    // disk rotation speed
  uniform float uDisk;    // 0..1 accretion disk visibility
  uniform float uStars;   // 0..1 lensed starfield
  uniform float uGain;
  const float RS = 0.15;
  const float R_IN = 0.42;
  const float R_OUT = 0.98;

  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float stars(vec3 d) {
    vec3 c = floor(d * 160.0);
    float h = hash(c);
    return h > 0.994 ? pow((h - 0.994) / 0.006, 4.0) * 0.9 : 0.0;
  }
  vec2 boxHit(vec3 ro, vec3 rd) {
    vec3 inv = 1.0 / rd;
    vec3 t0 = (-vec3(1.0) - ro) * inv, t1 = (vec3(1.0) - ro) * inv;
    vec3 mn = min(t0, t1), mx = max(t0, t1);
    return vec2(max(max(mn.x, mn.y), mn.z), min(min(mx.x, mx.y), mx.z));
  }

  void main() {
    vec3 ro = uCam;
    vec3 rd = normalize(vPos - ro);
    vec2 hit = boxHit(ro, rd);
    vec3 p = ro + rd * max(hit.x, 0.0);
    vec3 v = rd;
    vec3 col = vec3(0.0);
    float alpha = 0.0;
    bool captured = false;
    vec3 ring = vec3(0.0);
    for (int i = 0; i < 110; i++) {
      float r = length(p);
      if (r < RS) { captured = true; break; }
      vec3 h = cross(p, v);
      float h2 = dot(h, h);
      vec3 acc = -1.5 * RS * h2 * p / pow(r, 5.0);
      float dt = clamp(0.045 * r, 0.006, 0.06);
      vec3 pn = p + v * dt;
      v = normalize(v + acc * dt);
      // Photon ring: a thin bright halo just outside the shadow.
      ring += (1.0 - alpha) * vec3(1.0, 0.82, 0.6) * exp(-pow((r - 1.5 * RS) / 0.01, 2.0)) * 0.012 * uDisk;
      // Crossing the disk plane (y = 0).
      if (p.y * pn.y < 0.0) {
        float f = p.y / (p.y - pn.y);
        vec3 c = mix(p, pn, f);
        float rr = length(c.xz);
        if (rr > R_IN && rr < R_OUT) {
          float x = (rr - R_IN) / (R_OUT - R_IN);
          float ang = atan(c.z, c.x) - uTime / (rr * rr * 2.0); // uTime = integrated spin phase
          float bands = 0.55 + 0.45 * sin(rr * 46.0 + sin(ang * 3.0) * 1.5) * sin(ang * 7.0 + rr * 20.0);
          float heat = pow(1.0 - x, 1.6);
          vec3 hot = mix(vec3(1.0, 0.62, 0.25), vec3(1.0, 0.95, 0.86), heat);
          vec3 tangent = normalize(vec3(-c.z, 0.0, c.x));
          float dop = clamp(1.0 + 0.75 * dot(tangent, -v), 0.25, 1.9);
          float a = clamp(heat * 1.7 + 0.12, 0.0, 1.0) * smoothstep(0.0, 0.06, x) * (1.0 - smoothstep(0.82, 1.0, x)) * uDisk;
          col += (1.0 - alpha) * hot * (0.35 + 0.65 * bands) * dop * dop * a * 1.6;
          alpha += (1.0 - alpha) * a;
          if (alpha > 0.985) break;
        }
      }
      p = pn;
      if (dot(p, p) > 3.2 && dot(p, v) > 0.0) break;
    }
    // Captured rays are pure black (the shadow); only escaping rays show the photon ring glow.
    if (captured) { col *= 1.0; alpha = 1.0; }
    else {
      col += min(ring, vec3(0.6));
      float s = stars(v) * uStars;
      col += (1.0 - alpha) * vec3(s);
      alpha += (1.0 - alpha) * min(1.0, s);
    }
    gl_FragColor = vec4(col * uGain, alpha);
  }`;

export function buildBlackHole(): BuiltObject {
  const uniforms = {
    uCam: { value: new THREE.Vector3(0, 0.2, 3) },
    uTime: { value: 0 },
    uSpin: { value: 0.6 },
    uDisk: { value: 1 },
    uStars: { value: 1 },
    uGain: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    toneMapped: false,
  });
  const box = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
  box.userData.keepMaterial = true; // AR / x-ray styles must not replace the ray marcher
  const inv = new THREE.Matrix4();
  box.onBeforeRender = (_r, _s, camera) => {
    inv.copy(box.matrixWorld).invert();
    uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
  };
  // Invisible picking proxy (the box itself would catch every click around the hole).
  const proxy = new THREE.Mesh(new THREE.SphereGeometry(0.45, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
  const disk = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.98, 48), new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
  disk.rotation.x = -Math.PI / 2;
  const content = new THREE.Group();
  content.add(box, proxy, disk);
  content.rotation.z = 0.08;
  content.rotation.x = 0.06;

  const state = { spin: "Fast", disk: true, stars: true };
  const anim = { disk: 1, stars: 1, spin: 0.6 };
  let phase = 0;
  const actions: ModelAction[] = [
    { id: "spin", label: "Disk spin", kind: "choice", options: ["Slow", "Fast", "Frozen"], words: ["spin", "rotation", "rotate"], value: "Fast" },
    { id: "disk", label: "Accretion disk", kind: "toggle", words: ["disk", "disc", "accretion", "ring"], value: true, parts: [disk] },
    { id: "stars", label: "Lensed stars", kind: "toggle", words: ["stars", "lensing", "background"], value: true },
  ];
  const parts = [
    part("Event horizon", "The boundary nothing escapes, not even light.", 1, at(content, 0, 0, 0)),
    part("Photon ring", "Light orbiting the hole at 1.5× the horizon radius.", 1, at(content, 0.23, 0.0, 0)),
    part("Accretion disk", "Superheated gas spiralling in at a large fraction of light speed.", 1, at(content, 0.78, 0, 0.3), disk),
    part("Lensed far side", "The disk behind the hole, bent over the top by gravity.", 2, at(content, 0, 0.42, 0)),
    part("Doppler beaming", "The side moving toward you looks brighter and bluer.", 2, at(content, -0.7, 0, 0.2)),
  ];
  const group = new THREE.Group();
  group.add(content);
  return {
    content: group,
    radius: 1.2,
    parts,
    actions,
    act(id, value) {
      if (id === "spin") state.spin = String(value);
      if (id === "disk") state.disk = Boolean(value);
      if (id === "stars") state.stars = Boolean(value);
    },
    update(dt, t) {
      const k = 1 - Math.exp(-dt * 3);
      anim.disk += ((state.disk ? 1 : 0) - anim.disk) * k;
      anim.stars += ((state.stars ? 1 : 0) - anim.stars) * k;
      anim.spin += ((state.spin === "Fast" ? 0.6 : state.spin === "Slow" ? 0.15 : 0) - anim.spin) * k;
      uniforms.uDisk.value = anim.disk;
      uniforms.uStars.value = anim.stars;
      uniforms.uSpin.value = anim.spin;
      phase += dt * anim.spin;
      uniforms.uTime.value = phase;
      void t;
      uniforms.uGain.value = blackHoleGain.value;
    },
  };
}

/** Scene brightness hook (set by the engine's brightness control). */
export const blackHoleGain = { value: 1 };
