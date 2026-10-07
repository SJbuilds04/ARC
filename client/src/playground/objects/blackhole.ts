import * as THREE from "three";
import type { BuiltObject, ModelAction } from "./types";
import { at, part } from "./parts";

/**
 * Gargantua — a ray-traced black hole in the spirit of Interstellar.
 *
 * Every pixel inside a bounding sphere traces a light ray through Schwarzschild spacetime
 * (photon geodesics integrated with velocity Verlet, angular momentum conserved). Rays that
 * fall below the horizon are black (the shadow); rays that loop round the hole cross the
 * accretion disk again and again, which draws the lensed far side of the disk over and under
 * the shadow and the thin photon ring at its edge. Escaping rays sample the scene's own star
 * backdrop in their bent direction, blended back to straight at the sphere's edge, so there
 * is no visible boundary. Like the film, the disk has no Doppler asymmetry.
 */

/** Scene brightness hook (set by the engine's brightness control). */
export const blackHoleGain = { value: 1 };
/** The star backdrop the engine shows (equirect texture + intensity; 0 = plain studio colour). */
export const blackHoleEnv: { texture: THREE.Texture | null; intensity: number } = { texture: null, intensity: 0 };

const RB = 1.6; // bounding sphere

const VERT = /* glsl */ `
  varying vec3 vPos;
  void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const FRAG = /* glsl */ `
  precision highp float;
  varying vec3 vPos;
  uniform vec3 uCam;        // camera in object space
  uniform mat3 uToWorld;    // object → world rotation (for the backdrop lookup)
  uniform float uPhase;     // integrated disk rotation
  uniform float uDisk;
  uniform float uGain;
  uniform sampler2D uEnv;
  uniform float uEnvI;      // backdrop intensity (0: transparent outside the disk)
  uniform float uSteps;     // quality: max integration steps

  const float RS = 0.12;
  const float R_IN = 0.36;
  const float R_OUT = 1.28;
  const float RBND = ${RB.toFixed(2)};
  const float PI = 3.14159265;

  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.07 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
    return s;
  }
  // Gas texture: streaks stretched along the orbit, sheared by Keplerian rotation.
  float gas(float rr, float phi, float phase) {
    float om = 1.0 / (rr * sqrt(rr));
    float ph = phi + phase * om;
    vec3 q = vec3(rr * 30.0, cos(ph) * 3.2, sin(ph) * 3.2);
    float n = fbm(q);
    float fine = noise(vec3(rr * 85.0, cos(ph) * 7.0, sin(ph) * 7.0));
    return n * 0.85 + fine * 0.18;
  }
  vec4 disk(vec3 c, float rr) {
    float x = (rr - R_IN) / (R_OUT - R_IN);
    float phi = atan(c.z, c.x);
    // two sheared layers cross-fade so the pattern never winds up into stripes
    float T = 24.0;
    float pa = mod(uPhase, T);
    float pb = mod(uPhase + T * 0.5, T);
    float w = abs(2.0 * fract(uPhase / T) - 1.0);
    float g = mix(gas(rr, phi, pa), gas(rr, phi + 2.1, pb), w);
    // thin-disk emission: peaks just outside the inner edge
    float s = R_IN / rr;
    float I = s * s * s * (1.0 - sqrt(s)) / 0.0568;
    vec3 hot = vec3(1.0, 0.87, 0.66);
    vec3 warm = vec3(0.98, 0.56, 0.2);
    vec3 deep = vec3(0.7, 0.25, 0.06);
    vec3 col = mix(hot, warm, smoothstep(0.0, 0.42, x));
    col = mix(col, deep, smoothstep(0.42, 1.0, x));
    float edge = smoothstep(0.0, 0.025, x) * (1.0 - smoothstep(0.7, 1.0, x));
    float lanes = smoothstep(0.18, 0.75, g);
    float a = clamp(0.2 + 0.85 * I, 0.0, 0.96) * edge * (0.45 + 0.55 * lanes) * uDisk;
    vec3 e = col * (0.12 + 1.7 * I) * (0.4 + 0.8 * lanes);
    return vec4(e, a);
  }
  vec3 env(vec3 d) {
    vec3 w = normalize(uToWorld * d);
    vec2 uv = vec2(atan(w.z, w.x) * 0.1591549 + 0.5, asin(clamp(w.y, -1.0, 1.0)) * 0.3183099 + 0.5);
    return textureLod(uEnv, uv, 0.0).rgb * uEnvI;
  }

  void main() {
    vec3 ro = uCam;
    vec3 rd = normalize(vPos - ro);
    // enter the bounding sphere (or start at the camera if inside it)
    float bq = dot(ro, rd);
    float cq = dot(ro, ro) - RBND * RBND;
    float disc = bq * bq - cq;
    if (disc < 0.0) discard;
    float t0 = max(0.0, -bq - sqrt(disc));
    vec3 p = ro + rd * t0;
    vec3 v = rd;
    vec3 hv = cross(p, v);
    float h2 = dot(hv, hv);
    float b0 = sqrt(h2); // impact parameter of the incoming ray

    vec3 col = vec3(0.0);
    float alpha = 0.0;
    bool captured = false;
    int steps = int(uSteps);
    for (int i = 0; i < 400; i++) {
      if (i >= steps) break;
      float r = length(p);
      if (r < RS) { captured = true; break; }
      if (r > RBND + 0.001 && dot(p, v) > 0.0) break;
      float dt = clamp(0.065 * r, 0.0035, 0.15);
      // stay accurate where the ray is about to cross the disk plane
      if (abs(p.y) < 0.05 && r < R_OUT + 0.1) dt = min(dt, max(0.004, abs(p.y) * 0.8 + 0.006));
      float r5 = r * r * r * r * r;
      vec3 acc = -1.5 * RS * h2 * p / r5;
      vec3 vh = v + 0.5 * dt * acc;
      vec3 pn = p + dt * vh;
      float rn = length(pn);
      float rn5 = rn * rn * rn * rn * rn;
      v = vh + 0.5 * dt * (-1.5 * RS * h2 * pn / rn5);
      if (p.y * pn.y < 0.0) {
        float f = p.y / (p.y - pn.y);
        vec3 c = mix(p, pn, f);
        float rr = length(c.xz);
        if (rr > R_IN && rr < R_OUT) {
          vec4 d = disk(c, rr);
          col += (1.0 - alpha) * d.rgb * d.a;
          alpha += (1.0 - alpha) * d.a;
          if (alpha > 0.995) break;
        }
      }
      p = pn;
    }
    col *= uGain;
    if (captured) {
      alpha = 1.0; // the shadow: nothing comes back
    } else if (uEnvI > 0.0) {
      // backdrop seen along the bent ray; straightened toward the sphere edge (no seam)
      float straight = smoothstep(RBND * 0.55, RBND * 0.97, b0);
      float rim = straight * straight;
      vec3 d = normalize(mix(normalize(v), rd, straight));
      col += (1.0 - alpha) * (1.0 - rim) * env(d);
      alpha = 1.0 - (1.0 - alpha) * rim; // hand over to the real background at the rim
    }
    gl_FragColor = vec4(col, alpha);
  }`;

export function buildBlackHole(): BuiltObject {
  const uniforms = {
    uCam: { value: new THREE.Vector3(0, 0.2, 3) },
    uToWorld: { value: new THREE.Matrix3() },
    uPhase: { value: 0 },
    uDisk: { value: 1 },
    uGain: { value: 1 },
    uEnv: { value: null as THREE.Texture | null },
    uEnvI: { value: 0 },
    uSteps: { value: 260 },
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
  });
  const volume = new THREE.Mesh(new THREE.SphereGeometry(RB, 48, 32), mat);
  volume.userData.keepMaterial = true; // AR / x-ray styles must not replace the ray tracer
  volume.userData.noPick = true;
  const inv = new THREE.Matrix4();
  const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  placeholder.needsUpdate = true;
  volume.onBeforeRender = (_r, _s, camera) => {
    inv.copy(volume.matrixWorld).invert();
    uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
    uniforms.uToWorld.value.setFromMatrix4(volume.matrixWorld);
    // remove scale from the rotation
    const e = uniforms.uToWorld.value.elements;
    for (let c = 0; c < 3; c++) {
      const l = Math.hypot(e[c * 3], e[c * 3 + 1], e[c * 3 + 2]) || 1;
      e[c * 3] /= l;
      e[c * 3 + 1] /= l;
      e[c * 3 + 2] /= l;
    }
    uniforms.uEnv.value = blackHoleEnv.texture ?? placeholder;
    uniforms.uEnvI.value = blackHoleEnv.texture && state.stars ? blackHoleEnv.intensity : 0;
  };
  // Invisible picking proxies (the volume itself would catch every click around the hole).
  const proxy = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), new THREE.MeshBasicMaterial({ visible: false }));
  const diskProxy = new THREE.Mesh(new THREE.RingGeometry(0.36, 1.28, 48), new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }));
  diskProxy.rotation.x = -Math.PI / 2;
  const content = new THREE.Group();
  content.add(volume, proxy, diskProxy);
  content.rotation.z = 0.06;
  content.rotation.x = 0.04;

  const state = { spin: "Fast", disk: true, stars: true };
  const anim = { disk: 1, spin: 0.55 };
  let phase = 0;
  const actions: ModelAction[] = [
    { id: "spin", label: "Disk spin", kind: "choice", options: ["Slow", "Fast", "Frozen"], words: ["spin", "rotation", "rotate"], value: "Fast" },
    { id: "disk", label: "Accretion disk", kind: "toggle", words: ["disk", "disc", "accretion", "ring"], value: true, parts: [diskProxy] },
    { id: "stars", label: "Star backdrop", kind: "toggle", words: ["stars", "lensing", "background", "space", "backdrop"], value: true },
  ];
  const parts = [
    part("Event horizon", "The boundary nothing escapes, not even light: the black shadow.", 1, at(content, 0, 0, 0)),
    part("Photon ring", "Light that orbited the hole before escaping, a thin bright line at the shadow's edge.", 1, at(content, 0.31, 0.06, 0)),
    part("Accretion disk", "Superheated gas spiralling in; the inner edge is the hottest and brightest.", 1, at(content, 1.0, 0, 0.35), diskProxy),
    part("Lensed far side", "The back of the disk, bent up and over the top by gravity.", 2, at(content, 0, 0.46, 0)),
    part("Secondary image", "The underside of the disk, wrapped round beneath the shadow.", 2, at(content, 0, -0.38, 0)),
  ];
  const group = new THREE.Group();
  group.add(content);
  // Deep Dive: no turntable under it, and a real star backdrop while "stars" is on.
  group.userData.noPlatform = true;
  group.userData.spaceBackdrop = true;
  group.userData.spaceOn = true;
  return {
    content: group,
    radius: 1.05,
    parts,
    actions,
    act(id, value) {
      if (id === "spin") state.spin = String(value);
      if (id === "disk") state.disk = Boolean(value);
      if (id === "stars") {
        state.stars = Boolean(value);
        group.userData.spaceOn = state.stars;
      }
    },
    update(dt) {
      const k = 1 - Math.exp(-dt * 3);
      anim.disk += ((state.disk ? 1 : 0) - anim.disk) * k;
      anim.spin += ((state.spin === "Fast" ? 0.55 : state.spin === "Slow" ? 0.14 : 0) - anim.spin) * k;
      phase += dt * anim.spin;
      uniforms.uDisk.value = anim.disk;
      uniforms.uPhase.value = phase;
      uniforms.uGain.value = blackHoleGain.value;
      uniforms.uSteps.value = blackHoleQuality.steps;
    },
  };
}

/** Integration budget (lowered on weak GPUs by the engine). */
export const blackHoleQuality = { steps: 260 };
