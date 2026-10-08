import * as THREE from "three";

/**
 * Light theme: glow becomes ink.
 *
 * On a dark stage holograms and effects glow (additive light). On a light one additive light simply
 * vanishes, so in the light theme the same materials draw as coloured ink instead: normal blending, the
 * glow's hue darkened, its brightness turned into opacity. Holograms read as blueprints, beams and
 * particles as strokes; flat glowing rings and lines are tinted darker. Soft textured glows (coronas,
 * flares, sprites) are hidden — on white they'd only smudge.
 *
 * Materials are converted once (when a model is built); switching theme flips one shared uniform and
 * each material's blending — nothing recompiles.
 */
export const ink = { value: 0 };

type Kind = "shader" | "tint" | "hide";
interface Entry {
  kind: Kind;
  blending: THREE.Blending;
  color?: THREE.Color;
}

const entries = new WeakMap<THREE.Material, Entry>();
const live = new Set<WeakRef<THREE.Material>>();

/** Darker tone for tinted ink (orbits, edges, selection rings). */
const TINT_TONE = 0.28;

function track(m: THREE.Material, e: Entry): void {
  entries.set(m, e);
  live.add(new WeakRef(m));
  apply(m, e, ink.value > 0.5);
}

function apply(m: THREE.Material, e: Entry, on: boolean): void {
  if (e.kind === "hide") {
    m.visible = !on;
    return;
  }
  m.blending = on ? THREE.NormalBlending : e.blending;
  if (e.kind === "tint" && e.color) {
    const c = (m as THREE.MeshBasicMaterial).color;
    if (on) c.copy(e.color).multiplyScalar(TINT_TONE);
    else c.copy(e.color);
  }
}

/**
 * Give a shader material an ink look for the light theme. `tone` darkens the hue (lower = darker ink),
 * `alpha` scales how opaque the brightest glow becomes.
 */
export function inkify<T extends THREE.ShaderMaterial>(m: T, tone = 0.45, alpha = 1.25): T {
  if (entries.has(m)) return m;
  const end = m.fragmentShader.lastIndexOf("}");
  if (end < 0 || !m.fragmentShader.includes("gl_FragColor")) return m;
  m.uniforms.uInk = ink;
  m.fragmentShader =
    "uniform float uInk;\n" +
    m.fragmentShader.slice(0, end) +
    `  if (uInk > 0.5) {
    vec3 inkGlow = gl_FragColor.rgb * gl_FragColor.a;
    float inkLum = max(max(inkGlow.r, inkGlow.g), inkGlow.b);
    gl_FragColor = vec4(inkGlow / max(inkLum, 1e-4) * ${tone.toFixed(3)}, clamp(inkLum * ${alpha.toFixed(3)}, 0.0, 0.92));
  }
` +
    m.fragmentShader.slice(end);
  m.needsUpdate = true;
  track(m, { kind: "shader", blending: m.blending });
  return m;
}

/** Every glowing material under `root` (a freshly built model, a stage prop) gets its light-theme look. */
export function inkScan(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (!mat) return;
    for (const m of Array.isArray(mat) ? mat : [mat]) {
      if (entries.has(m) || m.userData.noInk) continue;
      const glow = m.blending === THREE.AdditiveBlending || m.userData.ink === true;
      if (!glow) continue;
      if ((m as THREE.ShaderMaterial).isShaderMaterial) {
        inkify(m as THREE.ShaderMaterial);
        continue;
      }
      // flat colour (lines, points, plain rings): tint darker; textured glows and sprites: hide
      const flat = !(m as THREE.MeshBasicMaterial).map && !(m as THREE.SpriteMaterial).isSpriteMaterial && (m as THREE.MeshBasicMaterial).color;
      if (flat) track(m, { kind: "tint", blending: m.blending, color: (m as THREE.MeshBasicMaterial).color.clone() });
      else track(m, { kind: "hide", blending: m.blending });
    }
  });
}

/** Switch every converted material between glow (dark theme) and ink (light theme). */
export function setInk(on: boolean): void {
  ink.value = on ? 1 : 0;
  for (const ref of live) {
    const m = ref.deref();
    const e = m && entries.get(m);
    if (!m || !e) {
      live.delete(ref);
      continue;
    }
    apply(m, e, on);
  }
}
