import * as THREE from "three";
import { inkify, inkScan } from "./ink";

/** Shared clock for every hologram shader (one uniform, updated once per frame). */
export const holoTime = { value: 0 };
/** Global hologram intensity (driven by the brightness control). */
export const holoGain = { value: 0.7 };

export const HOLO_CYAN = 0x5fd8ff;

const HOLO_VERT = /* glsl */ `
  varying vec3 vNormalV;
  varying vec3 vViewV;
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mv = viewMatrix * world;
    vNormalV = normalize(normalMatrix * normal);
    vViewV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }`;

const HOLO_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uGain;
  uniform float uPow;
  uniform float uScan;
  varying vec3 vNormalV;
  varying vec3 vViewV;
  varying vec3 vWorld;
  void main() {
    // light theme: a broader fresnel, so the blueprint shades like a sketch instead of a thin rim
    float f = pow(1.0 - abs(dot(normalize(vNormalV), normalize(vViewV))), uPow * (1.0 - 0.45 * uInk));
    float scan = 0.82 + 0.18 * sin(vWorld.y * 70.0 - uTime * 3.0);
    float band = smoothstep(0.0, 0.04, abs(fract(vWorld.y * 0.6 - uTime * 0.15) - 0.5)) * 0.25 + 0.75;
    // (uInk is declared by inkify: the light theme draws clean blueprint lines, no scanlines)
    float alpha = (0.08 + f * 0.95) * uOpacity * mix(1.0, scan * band, uScan * (1.0 - uInk)) * uGain;
    gl_FragColor = vec4(uColor * (0.55 + f * 1.6) * uGain, alpha);
  }`;

export function holoMaterial(
  color: THREE.ColorRepresentation = HOLO_CYAN,
  opts: { opacity?: number; fresnel?: number; scan?: number; ink?: { tone?: number; alpha?: number } } = {},
) {
  // light theme: a blueprint — dark ink at the silhouette, clear inside
  return inkify(
    new THREE.ShaderMaterial({
    uniforms: {
      uTime: holoTime,
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opts.opacity ?? 1 },
      uGain: holoGain,
      uPow: { value: opts.fresnel ?? 2.2 },
      uScan: { value: opts.scan ?? 0.6 },
    },
    vertexShader: HOLO_VERT,
    fragmentShader: HOLO_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.FrontSide,
    }),
    opts.ink?.tone ?? 0.26,
    opts.ink?.alpha ?? 2.2,
  );
}

/** Blueprint-style edge overlay. */
export function edgeLines(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation = HOLO_CYAN, opacity = 0.55, threshold = 22) {
  const lines = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry, threshold),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  lines.userData.noPick = true;
  inkScan(lines);
  return lines;
}

/** Clean line material (normal blending) whose brightness follows the brightness control. */
export function lineMaterial(color: THREE.ColorRepresentation = HOLO_CYAN, opacity = 0.7) {
  return inkify(
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity }, uGain: holoGain },
      vertexShader: /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uOpacity; uniform float uGain;
      void main() { gl_FragColor = vec4(uColor * (0.3 + 0.6 * uGain), uOpacity * (0.5 + 0.5 * uGain)); }`,
      transparent: true,
      depthWrite: false,
    }),
    0.25,
    2.0,
  );
}

/** Dark translucent core used inside holographic shells so objects read as solid. */
export function coreMaterial(color: THREE.ColorRepresentation = 0x07182c, opacity = 0.85) {
  return new THREE.MeshStandardMaterial({ color, metalness: 0.6, roughness: 0.35, transparent: opacity < 1, opacity, emissive: 0x02101e });
}

/** A hologram object = dark core + fresnel shell + edges. */
export function holoMesh(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation = HOLO_CYAN, edgeThreshold = 22) {
  const group = new THREE.Group();
  const core = new THREE.Mesh(geometry, coreMaterial());
  core.castShadow = true;
  const shell = new THREE.Mesh(geometry, holoMaterial(color));
  shell.scale.setScalar(1.002);
  shell.userData.noPick = true;
  group.add(core, shell, edgeLines(geometry, color, 0.45, edgeThreshold));
  return group;
}

// ─── Textures ───

const loader = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();

/** Load (and cache) a texture; on failure it is replaced by a procedural fallback. */
export function texture(url: string, fallback: () => HTMLCanvasElement, srgb = true): THREE.Texture {
  const hit = cache.get(url);
  if (hit) return hit;
  const tex = loader.load(url, undefined, undefined, () => {
    (tex as THREE.Texture<unknown>).image = fallback();
    tex.needsUpdate = true;
  });
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(url, tex);
  return tex;
}

// Value noise + fBm for procedural planet textures.
function hash(x: number, y: number, seed: number) {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise(x: number, y: number, seed: number, wrap: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const w = (n: number) => ((n % wrap) + wrap) % wrap;
  const a = hash(w(xi), yi, seed), b = hash(w(xi + 1), yi, seed);
  const c = hash(w(xi), yi + 1, seed), d = hash(w(xi + 1), yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm(x: number, y: number, seed: number, wrap: number, octaves = 5) {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(x * freq, y * freq, seed + i, wrap * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Equirectangular procedural texture; `shade(u, v, n)` returns [r,g,b] 0..255. */
export function proceduralTexture(width: number, height: number, seed: number, shade: (u: number, v: number, n: number) => [number, number, number]) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(width, height);
  const scale = 8;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width, v = y / height;
      const n = fbm(u * scale, v * scale * 0.5, seed, scale);
      const [r, g, b] = shade(u, v, n);
      const i = (y * width + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function canvasTexture(canvas: HTMLCanvasElement, srgb = true) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export function glowSprite(color: string, size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, color);
  g.addColorStop(0.25, color.replace(/[\d.]+\)$/, "0.35)"));
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvasTexture(c);
}
