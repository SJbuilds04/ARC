import * as THREE from "three";
import type { BuiltObject } from "./types";
import { HOLO_CYAN, glowSprite, holoMaterial } from "../holo";

export function buildAtom(): BuiltObject {
  const group = new THREE.Group();
  const nucleus = new THREE.Group();
  const nucleons: { mesh: THREE.Mesh; dir: THREE.Vector3 }[] = [];
  const protonMat = new THREE.MeshStandardMaterial({ color: 0xff7a5c, emissive: 0x521406, roughness: 0.4, metalness: 0.2 });
  const neutronMat = new THREE.MeshStandardMaterial({ color: 0x9fb6c9, emissive: 0x0c1a26, roughness: 0.4, metalness: 0.3 });
  const geo = new THREE.SphereGeometry(0.11, 24, 16);
  for (let i = 0; i < 12; i++) {
    // Fibonacci sphere packing
    const y = 1 - (i / 11) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = i * 2.399963;
    const dir = new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r);
    const mesh = new THREE.Mesh(geo, i % 2 ? neutronMat : protonMat);
    mesh.position.copy(dir).multiplyScalar(0.14);
    mesh.castShadow = true;
    nucleus.add(mesh);
    nucleons.push({ mesh, dir });
  }
  group.add(nucleus);

  const orbits = new THREE.Group();
  orbits.userData.noPick = true;
  const electrons: { pivot: THREE.Group; speed: number }[] = [];
  const glow = glowSprite("rgba(120,220,255,1)");
  const shells = [
    { radius: 0.62, count: 2, tilt: [0.3, 0] },
    { radius: 1.05, count: 4, tilt: [1.1, 0.6] },
    { radius: 1.05, count: 0, tilt: [-0.9, -0.7] },
  ];
  shells.forEach((s, si) => {
    const plane = new THREE.Group();
    plane.rotation.set(s.tilt[0], s.tilt[1], 0);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(s.radius, 0.006, 8, 160), holoMaterial(HOLO_CYAN, { opacity: 0.8, scan: 0 }));
    ring.rotation.x = Math.PI / 2;
    plane.add(ring);
    orbits.add(plane);
    for (let e = 0; e < s.count; e++) {
      const pivot = new THREE.Group();
      pivot.rotation.y = (e / s.count) * Math.PI * 2;
      const electron = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), new THREE.MeshBasicMaterial({ color: 0xbff3ff }));
      electron.position.x = s.radius;
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, blending: THREE.AdditiveBlending, depthWrite: false }));
      halo.scale.setScalar(0.3);
      electron.add(halo);
      pivot.add(electron);
      plane.add(pivot);
      electrons.push({ pivot, speed: si === 0 ? 2.4 : 1.5 });
    }
  });
  group.add(orbits);

  return {
    content: group,
    radius: 1.15,
    props: { orbits: true },
    setProperty(prop, value) {
      if (prop !== "orbits") return false;
      orbits.visible = value;
      return true;
    },
    explode(amount) {
      for (const n of nucleons) n.mesh.position.copy(n.dir).multiplyScalar(0.14 + amount * 0.45);
    },
    update(dt) {
      for (const e of electrons) e.pivot.rotation.y += dt * e.speed;
      nucleus.rotation.y += dt * 0.3;
    },
  };
}

export function buildDna(): BuiltObject {
  const group = new THREE.Group();
  const pairs = 26;
  const height = 3;
  const radius = 0.48;
  const strandA: THREE.Vector3[] = [];
  const strandB: THREE.Vector3[] = [];
  const baseColors = [0x5fd8ff, 0x3f7dff, 0x7cffd4, 0x9b8cff];
  const atomGeo = new THREE.SphereGeometry(0.055, 16, 12);
  const matA = new THREE.MeshStandardMaterial({ color: 0x6fe0ff, emissive: 0x0a3b52, roughness: 0.3 });
  const matB = new THREE.MeshStandardMaterial({ color: 0x4d7dff, emissive: 0x0a1f52, roughness: 0.3 });
  for (let i = 0; i < pairs; i++) {
    const y = (i / (pairs - 1) - 0.5) * height;
    const a = (i / 10.5) * Math.PI * 2;
    const pa = new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius);
    const pb = new THREE.Vector3(Math.cos(a + Math.PI) * radius, y, Math.sin(a + Math.PI) * radius);
    strandA.push(pa);
    strandB.push(pb);
    const ma = new THREE.Mesh(atomGeo, matA);
    ma.position.copy(pa);
    const mb = new THREE.Mesh(atomGeo, matB);
    mb.position.copy(pb);
    const len = pa.distanceTo(pb);
    const rung = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.014, len, 8),
      new THREE.MeshStandardMaterial({ color: baseColors[i % 4], emissive: baseColors[i % 4], emissiveIntensity: 0.35 }),
    );
    rung.position.copy(pa).add(pb).multiplyScalar(0.5);
    rung.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), pb.clone().sub(pa).normalize());
    group.add(ma, mb, rung);
  }
  for (const [pts, color] of [
    [strandA, 0x6fe0ff],
    [strandB, 0x4d7dff],
  ] as const) {
    const tube = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 200, 0.022, 8), holoMaterial(color, { opacity: 0.9, scan: 0.3 }));
    tube.userData.noPick = true;
    group.add(tube);
  }
  return {
    content: group,
    radius: 1.6,
    update(dt) {
      group.rotation.y += dt * 0.4;
    },
  };
}

/** Classic heart outline (two cubic lobes), extruded with a soft bevel. */
// ─── Organic modelling helpers ───

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth 3D value noise in [0,1]. */
function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v), l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}

/** Ridged multifractal: sharp crests (gyri) and narrow valleys (sulci). */
function ridged(x: number, y: number, z: number): number {
  let sum = 0, amp = 0.6, freq = 1;
  for (let o = 0; o < 3; o++) {
    const n = 1 - Math.abs(noise3(x * freq, y * freq, z * freq) * 2 - 1);
    sum += n * n * amp;
    amp *= 0.45;
    freq *= 2.1;
  }
  return sum;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const tissue = (color: number, opts: Partial<THREE.MeshPhysicalMaterialParameters> = {}) =>
  new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, metalness: 0, clearcoat: 0.75, clearcoatRoughness: 0.22, sheen: 0.5, sheenColor: new THREE.Color(0xff9a9a), envMapIntensity: 0.8, ...opts });

function vessel(points: [number, number, number][], radius: number, mat: THREE.Material, taper = 1) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  const geo = new THREE.TubeGeometry(curve, 64, radius, 16, false);
  if (taper !== 1) {
    // Taper the tube toward its end.
    const pos = geo.attributes.position;
    const segs = 65;
    const ring = 17;
    for (let i = 0; i < segs; i++) {
      const p = curve.getPointAt(i / (segs - 1));
      const f = 1 + (taper - 1) * (i / (segs - 1));
      for (let j = 0; j < ring; j++) {
        const k = i * ring + j;
        if (k >= pos.count) break;
        pos.setXYZ(k, p.x + (pos.getX(k) - p.x) * f, p.y + (pos.getY(k) - p.y) * f, p.z + (pos.getZ(k) - p.z) * f);
      }
    }
    geo.computeVertexNormals();
  }
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

/** Heart surface: unit-sphere direction → deformed point (shared by muscle and surface vessels). */
function deformHeart(x: number, y: number, z: number, lift = 1): THREE.Vector3 {
  const taper = 0.42 + 0.58 * smooth(-1.05, 0.55, y);
  let nx = x * taper;
  const nz = z * taper * 0.86;
  const ny = y * 1.08;
  const below = Math.max(0, -y);
  nx -= below * below * 0.32;
  const atria = Math.exp(-((x - 0.42) ** 2 + (y - 0.75) ** 2 + (z + 0.15) ** 2) / 0.12) * 0.16 + Math.exp(-((x + 0.48) ** 2 + (y - 0.7) ** 2 + (z + 0.1) ** 2) / 0.12) * 0.14;
  const groove = z > 0 ? Math.exp(-((x * 0.85 + y * 0.45 + 0.05) ** 2) / 0.006) * 0.06 * z : 0;
  const organic = (noise3(x * 4, y * 4, z * 4) - 0.5) * 0.03 + (noise3(x * 14, y * 14, z * 14) - 0.5) * 0.008;
  const r = (1 + atria - groove + organic) * lift;
  return new THREE.Vector3(nx * r, ny * r, nz * r);
}

/** A vessel that hugs the heart surface: path given as unit-sphere directions. */
function surfaceVessel(dirs: [number, number, number][], radius: number, mat: THREE.Material, taper = 1) {
  const pts = dirs.map(([x, y, z]) => {
    const d = new THREE.Vector3(x, y, z).normalize();
    const p = deformHeart(d.x, d.y, d.z, 1.012);
    return [p.x, p.y, p.z] as [number, number, number];
  });
  return vessel(pts, radius, mat, taper);
}

/** Anatomical-ish heart: tapered ventricles with apex, atria, great vessels, coronary arteries. */
export function buildHeart(): BuiltObject {
  const geo = new THREE.SphereGeometry(1, 160, 120);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const p = deformHeart(v.x, v.y, v.z);
    pos.setXYZ(i, p.x, p.y, p.z);
  }
  geo.computeVertexNormals();

  const heart = new THREE.Group();
  const muscle = new THREE.Mesh(geo, tissue(0x6e1016, { roughness: 0.38, clearcoat: 0.85, clearcoatRoughness: 0.18, sheen: 0.25, envMapIntensity: 0.5 }));
  muscle.castShadow = true;
  muscle.receiveShadow = true;
  heart.add(muscle);

  const artery = tissue(0x921a22, { roughness: 0.32, envMapIntensity: 0.5 });
  const vein = tissue(0x2c467f, { sheenColor: new THREE.Color(0x9ab0ff), envMapIntensity: 0.5 });
  const coronary = tissue(0xa82a30, { roughness: 0.3, envMapIntensity: 0.5 });
  const fat = tissue(0xc9a25e, { roughness: 0.55, clearcoat: 0.5, envMapIntensity: 0.4 });
  // Aortic arch with its three branches
  heart.add(vessel([[0.05, 0.75, 0.05], [0.12, 1.25, 0.05], [-0.08, 1.55, -0.12], [-0.5, 1.5, -0.3], [-0.68, 1.05, -0.38]], 0.17, artery));
  for (const [x0, h] of [[0.0, 0.5], [-0.22, 0.45], [-0.42, 0.42]] as [number, number][]) {
    heart.add(vessel([[x0, 1.52, -0.15], [x0 + 0.02, 1.52 + h * 0.6, -0.15], [x0 + 0.05, 1.52 + h, -0.12]], 0.055, artery, 0.7));
  }
  // Pulmonary trunk and branches
  heart.add(vessel([[-0.15, 0.6, 0.35], [-0.25, 1.1, 0.35], [-0.5, 1.28, 0.15]], 0.15, vein));
  heart.add(vessel([[-0.32, 1.18, 0.3], [0.1, 1.3, 0.25], [0.45, 1.22, 0.1]], 0.08, vein, 0.8));
  // Superior vena cava
  heart.add(vessel([[0.55, 0.7, -0.15], [0.6, 1.2, -0.15], [0.58, 1.6, -0.12]], 0.12, vein));
  // Coronary arteries and epicardial fat, following the surface
  heart.add(surfaceVessel([[0.05, 0.55, 0.8], [-0.12, 0.25, 0.95], [-0.3, -0.15, 0.94], [-0.45, -0.55, 0.7], [-0.4, -0.85, 0.35]], 0.03, coronary, 0.45));
  heart.add(surfaceVessel([[0.05, 0.55, 0.8], [-0.12, 0.25, 0.95], [-0.3, -0.15, 0.94]], 0.05, fat, 0.7));
  heart.add(surfaceVessel([[0.3, 0.5, 0.8], [0.7, 0.3, 0.62], [0.95, 0.0, 0.2], [0.85, -0.2, -0.45]], 0.03, coronary, 0.55));
  heart.add(surfaceVessel([[-0.2, 0.45, 0.85], [-0.6, 0.2, 0.75], [-0.85, -0.2, 0.45]], 0.022, coronary, 0.5));

  const group = new THREE.Group();
  heart.rotation.set(0.1, -0.35, -0.25);
  heart.scale.setScalar(0.72);
  group.add(heart);
  group.position.y = -0.15;
  return {
    content: group,
    radius: 1.25,
    update(_dt, t) {
      const phase = (t * 1.2) % 1;
      const beat = phase < 0.14 ? Math.sin((phase / 0.14) * Math.PI) : phase > 0.24 && phase < 0.36 ? 0.45 * Math.sin(((phase - 0.24) / 0.12) * Math.PI) : 0;
      const sc = 0.72 * (1 + beat * 0.045);
      heart.scale.set(sc, sc * (1 - beat * 0.02), sc);
    },
  };
}

/** Brain: ridged-noise gyri/sulci (darker in the folds), fissure, temporal lobes, cerebellum, stem. */
export function buildBrain(): BuiltObject {
  const geo = new THREE.SphereGeometry(1, 260, 190);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color(0xc4908f);
  const deep = new THREE.Color(0x4a2329);
  const c = new THREE.Color();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const { x, y, z } = v;
    // Folds: domain-warped ridged noise
    const wx = x + (noise3(x * 2, y * 2, z * 2) - 0.5) * 0.6;
    const wy = y + (noise3(x * 2 + 7, y * 2, z * 2) - 0.5) * 0.6;
    const wz = z + (noise3(x * 2, y * 2 + 3, z * 2) - 0.5) * 0.6;
    const fold = ridged(wx * 5.4, wy * 5.4, wz * 5.4);
    let r = 1 + (fold - 0.45) * 0.15;
    // Longitudinal fissure between hemispheres
    const fissure = Math.exp(-(x * x) / 0.0035) * smooth(-0.35, 0.2, y);
    r *= 1 - fissure * 0.2;
    // Flattened underside, temporal lobes
    if (y < -0.3) r *= 1 - (-0.3 - y) * 0.45;
    const temporal = Math.exp(-((Math.abs(x) - 0.75) ** 2 + (y + 0.35) ** 2 + (z - 0.15) ** 2) / 0.1) * 0.08;
    r += temporal;
    v.multiplyScalar(r);
    v.set(v.x * 0.8, v.y * 0.68, v.z * 1.04);
    pos.setXYZ(i, v.x, v.y, v.z);
    c.copy(deep).lerp(base, Math.pow(Math.min(1, Math.max(0, fold * 1.35 - 0.12)), 0.8) * (1 - fissure * 0.7));
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const group = new THREE.Group();
  const cortex = new THREE.Mesh(geo, tissue(0xffffff, { vertexColors: true, roughness: 0.48, clearcoat: 0.55, clearcoatRoughness: 0.3, sheen: 0.35, sheenColor: new THREE.Color(0xffb0b0), envMapIntensity: 0.45 }));
  cortex.castShadow = true;
  cortex.receiveShadow = true;

  // Cerebellum with fine horizontal folia
  const cg = new THREE.SphereGeometry(0.34, 96, 64);
  const cp = cg.attributes.position;
  for (let i = 0; i < cp.count; i++) {
    v.fromBufferAttribute(cp, i);
    const f = 1 + Math.sin(v.y * 70) * 0.025 + (noise3(v.x * 8, v.y * 8, v.z * 8) - 0.5) * 0.03;
    cp.setXYZ(i, v.x * f * 1.35, v.y * f * 0.72, v.z * f * 0.95);
  }
  cg.computeVertexNormals();
  const cerebellum = new THREE.Mesh(cg, tissue(0xc79098, { roughness: 0.5 }));
  cerebellum.position.set(0, -0.44, -0.62);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.075, 0.6, 32), tissue(0xc99aa0, { roughness: 0.5 }));
  stem.position.set(0, -0.62, -0.28);
  stem.rotation.x = 0.35;
  group.add(cortex, cerebellum, stem);
  return { content: group, radius: 1.2 };
}
