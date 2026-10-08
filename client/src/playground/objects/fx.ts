import * as THREE from "three";
import { holoGain, holoTime } from "../holo";

/**
 * Effects kit for the animated science models: glowing particles, light beams, photons drawn
 * the physics way (a wave packet), flashes. Everything is additive and follows the brightness
 * control, and none of it is a regular mesh material, so AR / x-ray styles leave it glowing.
 */

const _size = new THREE.Vector2();

export interface GlowPoints {
  points: THREE.Points;
  /** xyz per point. */
  pos: Float32Array;
  /** Brightness 0..1 per point (0 = hidden). */
  alpha: Float32Array;
  /** Size multiplier per point. */
  size: Float32Array;
  /** rgb per point. */
  color: Float32Array;
  count: number;
  /** Upload the arrays after changing them. */
  commit(): void;
}

/** Soft round glow points, sized in world units, with per-point position, brightness, size and colour. */
export function glowPoints(count: number, baseSize = 0.03, rgb: THREE.ColorRepresentation = 0xffffff): GlowPoints {
  const pos = new Float32Array(count * 3);
  const alpha = new Float32Array(count);
  const size = new Float32Array(count).fill(1);
  const color = new Float32Array(count * 3);
  const c = new THREE.Color(rgb);
  for (let i = 0; i < count; i++) color.set([c.r, c.g, c.b], i * 3);
  const geo = new THREE.BufferGeometry();
  const attr = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", attr(pos, 3));
  geo.setAttribute("alpha", attr(alpha, 1));
  geo.setAttribute("psize", attr(size, 1));
  geo.setAttribute("color", attr(color, 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: baseSize }, uScale: { value: 1000 }, uGain: holoGain },
    vertexShader: /* glsl */ `
      attribute float alpha; attribute float psize; attribute vec3 color;
      varying float vA; varying vec3 vC;
      uniform float uSize; uniform float uScale;
      void main() {
        vA = alpha; vC = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float s = length(modelMatrix[0].xyz);
        gl_PointSize = alpha <= 0.0 ? 0.0 : max(1.5, uSize * psize * s * uScale / max(0.05, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uGain; varying float vA; varying vec3 vC;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d) * 4.0;
        if (r2 > 1.0) discard;
        float core = exp(-r2 * 7.0);
        float halo = exp(-r2 * 2.2) * 0.4;
        float g = 0.45 + 0.85 * uGain;
        gl_FragColor = vec4(vC * (core * 1.7 + halo) * vA * g, (core + halo) * vA);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.userData.noPick = true;
  points.onBeforeRender = (renderer, _s, camera) => {
    renderer.getDrawingBufferSize(_size);
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 42;
    mat.uniforms.uScale.value = _size.y / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
  };
  return {
    points,
    pos,
    alpha,
    size,
    color,
    count,
    commit() {
      geo.attributes.position.needsUpdate = true;
      geo.attributes.alpha.needsUpdate = true;
      geo.attributes.psize.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
  };
}

/**
 * A light beam / radiation field on a cone or cylinder: brightest at the source end (uv.y = 1)
 * and where it faces you, soft at its edges, optionally pulsing along its length.
 */
export function beamMaterial(color: THREE.ColorRepresentation, opts: { intensity?: number; falloff?: number; pulse?: number; speed?: number } = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uI: { value: opts.intensity ?? 1 },
      uFall: { value: opts.falloff ?? 1.5 },
      uPulse: { value: opts.pulse ?? 0 },
      uSpeed: { value: opts.speed ?? 12 },
      uTime: holoTime,
      uGain: holoGain,
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uI; uniform float uFall; uniform float uPulse; uniform float uSpeed; uniform float uTime; uniform float uGain;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float along = pow(clamp(vUv.y, 0.0, 1.0), uFall);
        float pulse = 1.0 + uPulse * 0.5 * sin(vUv.y * 38.0 + uTime * uSpeed);
        float a = facing * facing * along * uI * pulse;
        gl_FragColor = vec4(uColor * a * (0.5 + 0.8 * uGain), a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

/** A glowing "hot" material (filaments, cores): colour × intensity, following the brightness control. */
export class HotMaterial extends THREE.MeshBasicMaterial {
  private base: THREE.Color;
  constructor(color: THREE.ColorRepresentation) {
    super({ color, toneMapped: false });
    this.base = new THREE.Color(color);
  }
  /** Change the colour it glows in. */
  setBase(c: THREE.ColorRepresentation): void {
    this.base.set(c);
  }
  /** Set the glow level (≈0…3; above 1 blooms). */
  level(v: number): void {
    this.color.copy(this.base).multiplyScalar(v * (0.45 + 0.85 * holoGain.value));
  }
}

/**
 * A photon drawn the physics way: a wavy packet (a sine under a Gaussian envelope) along +x,
 * centred on the origin. Move the mesh along its path; it fades in and out at its ends.
 */
export function photonGeometry(length: number, waves: number, amp: number, radius: number): THREE.BufferGeometry {
  const pts: THREE.Vector3[] = [];
  const n = Math.max(48, Math.round(waves * 14));
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const env = Math.exp(-Math.pow((u - 0.5) * 3.0, 2));
    pts.push(new THREE.Vector3((u - 0.5) * length, Math.sin(u * waves * Math.PI * 2) * amp * env, 0));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), n * 2, radius, 5, false);
}

export function photonMaterial(color: THREE.ColorRepresentation, intensity = 1.6): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uI: { value: intensity }, uFade: { value: 1 }, uGain: holoGain },
    vertexShader: /* glsl */ `varying float vU; void main() { vU = uv.x; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uI; uniform float uFade; uniform float uGain; varying float vU;
      void main() {
        float a = pow(sin(3.14159 * clamp(vU, 0.0, 1.0)), 1.3) * uFade;
        gl_FragColor = vec4(uColor * a * uI * (0.5 + 0.8 * uGain), a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** One travelling photon: a packet mesh plus where it is going. */
export interface Photon {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  from: THREE.Vector3;
  dir: THREE.Vector3;
  /** Distance travelled / path length. */
  s: number;
  len: number;
  speed: number;
  alive: boolean;
  /** Free slot for the model (what stops it, etc.). */
  tag: number;
}

const _x = new THREE.Vector3(1, 0, 0);

/** A pool of photons that fly along straight paths and fade at the end. */
export class PhotonPool {
  readonly group = new THREE.Group();
  readonly items: Photon[] = [];
  constructor(count: number, geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, intensity = 1.6) {
    for (let i = 0; i < count; i++) {
      const mat = photonMaterial(color, intensity);
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.visible = false;
      mesh.userData.noPick = true;
      mesh.userData.keepMaterial = true;
      this.group.add(mesh);
      this.items.push({ mesh, mat, from: new THREE.Vector3(), dir: new THREE.Vector3(1, 0, 0), s: 0, len: 1, speed: 1, alive: false, tag: 0 });
    }
  }
  /** Launch a photon from `from` along `dir` for `len` units. Returns it (or null if all are busy). */
  emit(from: THREE.Vector3, dir: THREE.Vector3, len: number, speed: number, tag = 0): Photon | null {
    const p = this.items.find((x) => !x.alive);
    if (!p) return null;
    p.from.copy(from);
    p.dir.copy(dir).normalize();
    p.len = len;
    p.speed = speed;
    p.s = 0;
    p.tag = tag;
    p.alive = true;
    p.mesh.visible = true;
    p.mesh.quaternion.setFromUnitVectors(_x, p.dir);
    p.mesh.rotateX(Math.random() * Math.PI * 2);
    return p;
  }
  /** Advance; `stop(p)` may return a distance at which this photon is absorbed. */
  update(dt: number, fade = 1): void {
    for (const p of this.items) {
      if (!p.alive) continue;
      p.s += dt * p.speed;
      if (p.s > p.len) {
        p.alive = false;
        p.mesh.visible = false;
        continue;
      }
      p.mesh.position.copy(p.from).addScaledVector(p.dir, p.s);
      const edge = Math.min(1, p.s / 0.08, (p.len - p.s) / 0.12);
      p.mat.uniforms.uFade.value = Math.max(0, edge) * fade;
    }
  }
  clear(): void {
    for (const p of this.items) {
      p.alive = false;
      p.mesh.visible = false;
    }
  }
}

let flashTex: THREE.Texture | null = null;
function flashTexture(): THREE.Texture {
  if (flashTex) return flashTex;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.18, "rgba(255,255,255,0.55)");
  gr.addColorStop(0.5, "rgba(255,255,255,0.12)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  flashTex = new THREE.CanvasTexture(c);
  flashTex.colorSpace = THREE.SRGBColorSpace;
  return flashTex;
}

/** A soft additive glow / flash sprite (scale and opacity are animated by the model). */
export function flash(color: THREE.ColorRepresentation, scale = 0.4): THREE.Sprite {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTexture(), color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
  s.scale.setScalar(scale);
  s.userData.noPick = true;
  return s;
}

/** Lines that glow (additive), brightness from the brightness control. */
export function glowLineMaterial(color: THREE.ColorRepresentation, opacity = 0.8): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uGain: holoGain },
    vertexShader: /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uOpacity; uniform float uGain;
      void main() { gl_FragColor = vec4(uColor * uOpacity * (0.5 + 0.8 * uGain), uOpacity); }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

/** Seeded random (stable layouts that don't change on every build). */
export function rng(seed = 1): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A label-able anchor point that never gets picked. */
export function marker(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  const o = new THREE.Object3D();
  o.position.set(x, y, z);
  o.userData.noPick = true;
  parent.add(o);
  return o;
}
