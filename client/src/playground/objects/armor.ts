import * as THREE from "three";
import type { BuiltObject, ModelAction } from "./types";
import { at, centerOf, part, type PartAnchor } from "./parts";
import { holoGain } from "../holo";
import { anatomy, HEROIC, type Proportions } from "./anatomy";
import {
  type Surface,
  type P2,
  type PlateOpts,
  TAU,
  plateGeometry,
  capGeometry,
  skinGeometry,
  rounded,
  roundChain,
  symmetric,
  mirror,
  ellipse,
  arc,
  rect,
  grow,
  flakeNormalMap,
  smudgeMap,
  mechNormalMap,
  hexNormalMap,
  hudTexture,
} from "./suitkit";

/**
 * Iron Man armours (ARC's own procedural recreations, not official assets).
 *
 * Built on the shared anatomy: every armour plate is cut on the body surfaces with real
 * thickness, bevelled edges and dark panel gaps; candy-red clear-coat paint with metal flake,
 * gold-titanium, a machined arc reactor, glowing eyes and repulsors. Interactive — faceplate,
 * repulsors, flight (thrusters, back flaps), opening the armour, paint schemes.
 */

type Role = "primary" | "secondary" | "under" | "dark" | "steel" | "copper" | "glow";

export interface Scheme {
  name: string;
  primary: number;
  secondary: number;
}

interface SuitStyle {
  schemes: Scheme[];
  /** Regions finished in the secondary (gold-titanium) colour. */
  gold: Set<string>;
  glow: number;
  reactor: "round" | "triangle" | "hex";
  p: Proportions;
  nano?: boolean;
  hulk?: boolean;
}

export interface Built {
  content: THREE.Group;
  parts: PartAnchor[];
  actions: ModelAction[];
  act(id: string, value: boolean | string): void;
  update(dt: number, t: number): void;
  explode(a: number): void;
}

const Z = new THREE.Vector3(0, 0, 1);
const DIRECT: Record<string, Role> = { dark: "dark", steel: "steel", under: "under", copper: "copper", glow: "glow", primary: "primary", secondary: "secondary" };
const DARK_REGIONS = new Set(["belt", "spine", "waist"]);
const ease = (x: number) => x * x * (3 - 2 * x);

function materials(style: SuitStyle): Record<Role, THREE.Material> {
  const s0 = style.schemes[0];
  const flake = flakeNormalMap();
  const nano = style.nano ? hexNormalMap() : null;
  return {
    primary: new THREE.MeshPhysicalMaterial({
      color: s0.primary,
      metalness: 0.38,
      roughness: 0.46,
      roughnessMap: smudgeMap(),
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      clearcoatRoughnessMap: smudgeMap(),
      normalMap: nano ?? flake,
      normalScale: new THREE.Vector2(nano ? 0.22 : 0.16, nano ? 0.22 : 0.16),
      side: THREE.DoubleSide,
    }),
    secondary: new THREE.MeshPhysicalMaterial({
      color: s0.secondary,
      metalness: 1,
      roughness: 0.3,
      roughnessMap: smudgeMap(),
      clearcoat: 0.5,
      clearcoatRoughness: 0.12,
      normalMap: nano ?? flake,
      normalScale: new THREE.Vector2(0.08, 0.08),
      side: THREE.DoubleSide,
    }),
    under: new THREE.MeshStandardMaterial({ color: 0x15181c, metalness: 0.82, roughness: 0.5, normalMap: mechNormalMap(), normalScale: new THREE.Vector2(0.75, 0.75) }),
    dark: new THREE.MeshStandardMaterial({ color: 0x262a30, metalness: 0.92, roughness: 0.32, side: THREE.DoubleSide }),
    steel: new THREE.MeshStandardMaterial({ color: 0xb9c1ca, metalness: 1, roughness: 0.2, side: THREE.DoubleSide }),
    copper: new THREE.MeshStandardMaterial({ color: 0xc27a45, metalness: 1, roughness: 0.3 }),
    glow: new THREE.MeshBasicMaterial({ color: style.glow, toneMapped: false }),
  };
}

/** The chest arc reactor: machined housing, copper coils / new-element core, glass lens. */
function chestReactor(kind: SuitStyle["reactor"], m: Record<Role, THREE.Material>, dimGlow: THREE.Material): { group: THREE.Group; light: THREE.PointLight } {
  const g = new THREE.Group();
  const hex = kind === "hex";
  const seg = hex ? 6 : 72;
  const prof: [number, number][] = [
    [0.039, -0.016],
    [0.043, -0.004],
    [0.046, 0.003],
    [0.051, 0.0062],
    [0.0562, 0.006],
    [0.0596, 0.0026],
    [0.0604, -0.006],
    [0.058, -0.016],
  ];
  const housing = new THREE.Mesh(new THREE.LatheGeometry(prof.map(([r, z]) => new THREE.Vector2(r, z)), seg, hex ? Math.PI / 6 : 0), m.steel);
  housing.rotation.x = Math.PI / 2;
  g.add(housing);
  const well = new THREE.Mesh(new THREE.CylinderGeometry(0.0405, 0.0405, 0.016, seg, 1, true, hex ? Math.PI / 6 : 0), m.dark);
  well.rotation.x = Math.PI / 2;
  well.position.z = -0.008;
  g.add(well);
  const back = new THREE.Mesh(new THREE.CircleGeometry(0.041, seg), dimGlow);
  back.position.z = -0.0155;
  g.add(back);
  if (kind === "round") {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * TAU;
      const coil = new THREE.Mesh(new THREE.BoxGeometry(0.0152, 0.019, 0.008), m.copper);
      coil.position.set(Math.cos(a) * 0.0302, Math.sin(a) * 0.0302, -0.0085);
      coil.rotation.z = a - Math.PI / 2;
      g.add(coil);
      const spacer = new THREE.Mesh(new THREE.BoxGeometry(0.0016, 0.02, 0.009), m.dark);
      const b = a + Math.PI / 10;
      spacer.position.set(Math.cos(b) * 0.0302, Math.sin(b) * 0.0302, -0.0085);
      spacer.rotation.z = b - Math.PI / 2;
      g.add(spacer);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0195, 0.0028, 10, 48), m.steel);
    ring.position.z = -0.004;
    g.add(ring);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.0145, 0.0145, 0.008, 40), m.glow);
    core.rotation.x = Math.PI / 2;
    core.position.z = -0.006;
    g.add(core);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.0062, 0.007, 0.004, 24), m.steel);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = -0.0015;
    g.add(hub);
  } else if (kind === "triangle") {
    const tri = (R: number, rr: number) => {
      const pts = [-90, 30, 150].map((d) => new THREE.Vector2(Math.cos((d * Math.PI) / 180) * R, Math.sin((d * Math.PI) / 180) * R));
      const s = new THREE.Shape();
      for (let i = 0; i < 3; i++) {
        const p = pts[i];
        const a = pts[(i + 2) % 3];
        const b = pts[(i + 1) % 3];
        const s0 = p.clone().lerp(a, rr);
        const e0 = p.clone().lerp(b, rr);
        if (i === 0) s.moveTo(s0.x, s0.y);
        else s.lineTo(s0.x, s0.y);
        s.quadraticCurveTo(p.x, p.y, e0.x, e0.y);
      }
      s.closePath();
      return s;
    };
    const glowTri = tri(0.034, 0.22);
    glowTri.holes.push(new THREE.Path(tri(0.018, 0.25).getPoints(6)));
    const core = new THREE.Mesh(new THREE.ExtrudeGeometry(glowTri, { depth: 0.006, bevelEnabled: true, bevelSize: 0.001, bevelThickness: 0.001, bevelSegments: 2, curveSegments: 8 }), m.glow);
    core.position.z = -0.012;
    g.add(core);
    const frame = tri(0.0385, 0.2);
    frame.holes.push(new THREE.Path(tri(0.0345, 0.22).getPoints(8)));
    const fr = new THREE.Mesh(new THREE.ExtrudeGeometry(frame, { depth: 0.008, bevelEnabled: false, curveSegments: 8 }), m.steel);
    fr.position.z = -0.012;
    g.add(fr);
    for (let i = 0; i < 30; i++) {
      const a = (i / 30) * TAU;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.0016, 0.006, 0.006), m.dark);
      fin.position.set(Math.cos(a) * 0.0385, Math.sin(a) * 0.0385, -0.009);
      fin.rotation.z = a - Math.PI / 2;
      g.add(fin);
    }
  } else {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU + Math.PI / 6;
      const s = new THREE.Shape();
      const w0 = 0.007;
      const w1 = 0.016;
      s.moveTo(0.019, -w0);
      s.lineTo(0.035, -w1);
      s.lineTo(0.035, w1);
      s.lineTo(0.019, w0);
      s.closePath();
      const blade = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.005, bevelEnabled: false }), m.dark);
      blade.rotation.z = a;
      blade.position.z = -0.01;
      g.add(blade);
    }
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0165, 0.0022, 8, 6), m.steel);
    ring.rotation.z = Math.PI / 6;
    ring.position.z = -0.005;
    g.add(ring);
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.007, 6, 1, false, Math.PI / 6), m.glow);
    core.rotation.x = Math.PI / 2;
    core.position.z = -0.006;
    g.add(core);
  }
  const light = new THREE.PointLight(0xbfefff, 0.5, 0.7, 2);
  light.position.z = 0.09;
  g.add(light);
  return { group: g, light };
}

/** Palm repulsor: steel ring, glowing emitter, grille bars. Faces +z. */
function repulsor(m: Record<Role, THREE.Material>, scale: number): THREE.Group {
  const g = new THREE.Group();
  g.scale.setScalar(scale);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.0165, 0.0026, 10, 40), m.steel);
  g.add(ring);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.0148, 40), m.glow);
  disc.position.z = -0.0012;
  g.add(disc);
  for (let i = -1; i <= 1; i++) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.0011, 0.0012), m.dark);
    bar.position.set(0, i * 0.0058, 0.0004);
    g.add(bar);
  }
  return g;
}

/** Thruster exhaust: an additive cone, bright at the nozzle, flickering. */
function exhaust(len: number, r: number, color: number): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const geo = new THREE.ConeGeometry(r, len, 24, 1, true);
  geo.rotateX(Math.PI);
  geo.translate(0, -len / 2, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uGain: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `uniform vec3 uColor; uniform float uGain; uniform float uTime; varying vec2 vUv;
      void main(){
        float a = pow(1.0 - vUv.y, 1.7) * (0.8 + 0.2 * sin(uTime * 55.0 + vUv.y * 24.0));
        gl_FragColor = vec4(uColor * a * uGain * 2.2, a * uGain);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.noPick = true;
  mesh.userData.keepMaterial = true;
  mesh.visible = false;
  return { mesh, mat };
}

interface PlateRec {
  obj: THREE.Object3D;
  home: THREE.Vector3;
  dir: THREE.Vector3;
  k: number;
}

interface Arm {
  s: number;
  sh: THREE.Group;
  el: THREE.Group;
  wr: THREE.Group;
  home: THREE.Vector3;
  joints: { g: THREE.Group; base: number }[];
  thumb: THREE.Group;
}

interface Leg {
  s: number;
  hip: THREE.Group;
  kn: THREE.Group;
  ank: THREE.Group;
  home: THREE.Vector3;
}

function buildIronSuit(style: SuitStyle): Built {
  const an = anatomy(style.p);
  const J = an.j;
  const pk = style.hulk ? 1.5 : 1;
  const mats = materials(style);
  const glowMat = mats.glow as THREE.MeshBasicMaterial;
  const glowBase = new THREE.Color(style.glow);
  const roleOf = (region: string): Role => DIRECT[region] ?? (style.gold.has(region) ? "secondary" : DARK_REGIONS.has(region) ? "dark" : "primary");

  const content = new THREE.Group();
  const body = new THREE.Group();
  content.add(body);
  const plates: PlateRec[] = [];
  const P: PlateOpts = { thickness: 0.0045 * pk, base: 0.0025 * pk, gap: 0.0013 * pk, bevel: 0.0011 * pk, maxEdge: 0.012 };
  const SMALL: PlateOpts = { thickness: 0.0022, base: 0.0012, gap: 0.0007, bevel: 0.0008, maxEdge: 0.006 };
  const TINY: PlateOpts = { thickness: 0.0016, base: 0.0009, gap: 0.0006, bevel: 0.0006, maxEdge: 0.005 };
  /** Stacked detail panel on top of a plate. */
  const onTop = (o: PlateOpts, extra = 0.0024): PlateOpts => ({ ...o, base: (o.base ?? 0) + (o.thickness ?? 0) - 0.0004, thickness: extra * pk, bevel: Math.min(o.bevel ?? 0.0015, extra * pk * 0.7) });

  const plate = (surf: Surface, parent: THREE.Object3D, outline: P2[], region: string, o: PlateOpts = P, k = 1): THREE.Mesh => {
    const { geometry, normal } = plateGeometry(surf, outline, o);
    const m = new THREE.Mesh(geometry, mats[roleOf(region)]);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.region = region;
    parent.add(m);
    plates.push({ obj: m, home: m.position.clone(), dir: normal, k });
    return m;
  };
  const skin = (surf: Surface, parent: THREE.Object3D, o: Parameters<typeof skinGeometry>[1] = {}, role: Role = "under"): THREE.Mesh => {
    const m = new THREE.Mesh(skinGeometry(surf, o), mats[role]);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const both = (fn: (M: (pts: P2[]) => P2[], side: number) => void) => {
    fn((p) => p, 1);
    fn(mirror, -1);
  };

  // ─── torso ───
  const T = an.torso;
  const torsoG = new THREE.Group();
  torsoG.position.y = J.torsoY;
  body.add(torsoG);
  const chestG = new THREE.Group();
  torsoG.add(chestG);
  skin(T, torsoG, { segU: 72, segV: 36 });
  const tR = J.reactorT;
  const reactorScale = style.hulk ? 1.3 : 1;
  const RR = 0.0605 * reactorScale;
  const rth = (RR + 0.0075) / T.r(0, tR);
  const rtt = (RR + 0.0075) / T.length;
  const flaps: { g: THREE.Group; axis: THREE.Vector3; sign: number }[] = [];
  both((M, side) => {
    // pectoral plate, cut round the reactor
    const pec = roundChain([[0.04, 0.8], [0.32, 0.838], [0.64, 0.858], [0.93, 0.838], [1.13, 0.79], [1.25, 0.71], [1.24, 0.62], [1.1, 0.565], [0.82, 0.528], [0.52, 0.52], [0.24, 0.538]], 0.3).concat(
      arc(0, tR, rth, rtt, Math.PI - 0.33, 0.36, 18),
    );
    plate(T, chestG, M(pec), "chest");
    // raised inner pec panel
    plate(T, chestG, M(rounded([[0.36, 0.6], [0.86, 0.585], [1.06, 0.66], [0.98, 0.79], [0.62, 0.815], [0.38, 0.77]], 0.3)), "chest", onTop(P, 0.0026));
    // abdominals (3 rows)
    plate(T, torsoG, M(rounded([[0.015, 0.42], [0.53, 0.42], [0.53, 0.52], [0.24, 0.538], [0.163, 0.556], [0.015, 0.551]], [0.15, 0.15, 0, 0, 0, 0.15])), "abs");
    plate(T, torsoG, M(rounded(rect(0.015, 0.53, 0.305, 0.42), 0.12)), "abs");
    plate(T, torsoG, M(rounded([[0.015, 0.19], [0.5, 0.19], [0.53, 0.305], [0.015, 0.305]], 0.14)), "abs");
    plate(T, torsoG, M(rounded([[0.015, 0.122], [0.46, 0.122], [0.5, 0.19], [0.015, 0.19]], [0.1, 0.2, 0, 0.1])), "abs");
    // obliques
    plate(T, torsoG, M([[0.53, 0.42], [1.3, 0.46], [1.3, 0.62], [1.24, 0.62], [1.1, 0.565], [0.82, 0.528], [0.53, 0.52]]), "sides");
    plate(T, torsoG, M([[0.53, 0.305], [1.3, 0.335], [1.3, 0.46], [0.53, 0.42]]), "sides");
    plate(T, torsoG, M([[0.5, 0.19], [1.3, 0.21], [1.3, 0.335], [0.53, 0.305]]), "sides");
    plate(T, torsoG, M([[0.46, 0.122], [1.3, 0.122], [1.3, 0.21], [0.5, 0.19]]), "sides");
    // flank plates under the arm
    plate(T, torsoG, M(rounded([[1.3, 0.46], [1.97, 0.46], [1.97, 0.73], [1.62, 0.765], [1.25, 0.71], [1.24, 0.62], [1.3, 0.62]], [0, 0, 0.2, 0.3, 0.2, 0, 0])), "sides");
    plate(T, torsoG, M(rect(1.3, 1.97, 0.21, 0.46)), "sides");
    plate(T, torsoG, M(rect(1.3, 1.97, 0.122, 0.21)), "sides");
    // back: flight flap (hinged at its top edge), three bands, upper back
    const flapOutline = M(rounded([[1.97, 0.6], [1.97, 0.8], [2.22, 0.885], [2.95, 0.87], [Math.PI - 0.06, 0.8], [Math.PI - 0.06, 0.6]], [0, 0.25, 0.25, 0.25, 0.2, 0]));
    const thc = side * 2.55;
    const pivot = T.point(thc, 0.875).addScaledVector(T.normal(thc, 0.875), 0.005);
    const hinge = new THREE.Group();
    hinge.position.copy(pivot);
    const inner = new THREE.Group();
    inner.position.copy(pivot).negate();
    hinge.add(inner);
    torsoG.add(hinge);
    plate(T, inner, flapOutline, "flaps");
    plate(T, inner, M(rounded([[2.2, 0.66], [2.85, 0.66], [2.9, 0.8], [2.3, 0.81]], 0.25)), "flaps", onTop(P, 0.002));
    const tangent = T.point(thc + 0.01, 0.875).sub(T.point(thc - 0.01, 0.875)).normalize();
    const lower = T.point(thc, 0.62).sub(pivot);
    const sign = Math.sign(new THREE.Vector3().crossVectors(tangent, lower).dot(T.normal(thc, 0.7))) || 1;
    flaps.push({ g: hinge, axis: tangent, sign });
    for (const [t0, t1] of [
      [0.46, 0.6],
      [0.33, 0.46],
      [0.21, 0.33],
      [0.122, 0.21],
    ])
      plate(T, torsoG, M(rect(1.97, Math.PI - 0.06, t0, t1)), "back");
    plate(T, torsoG, M([[2.22, 0.885], [2.95, 0.87], [Math.PI - 0.06, 0.88], [Math.PI - 0.06, 0.99], [2.3, 0.99]]), "back");
    // shoulder yoke (under the pauldron)
    plate(T, torsoG, M(rounded([[1.13, 0.79], [1.25, 0.71], [1.62, 0.765], [1.97, 0.73], [2.22, 0.885], [2.3, 0.99], [1.6, 0.99], [1.13, 0.985]], [0, 0.2, 0.2, 0.2, 0.2, 0, 0, 0])), "shoulders");
  });
  plate(T, chestG, symmetric([[0, 0.988], [0.4, 0.988], [0.8, 0.987], [1.13, 0.985], [1.13, 0.79], [0.93, 0.838], [0.64, 0.858], [0.32, 0.838], [0.04, 0.8], [0, 0.797]]), "collar");
  plate(T, chestG, symmetric(rounded([[0, 0.93], [0.42, 0.925], [0.78, 0.9], [0.66, 0.885], [0.3, 0.875], [0, 0.865]], [0, 0.2, 0.3, 0.2, 0.2, 0])), "collar", onTop(P, 0.0022));
  plate(T, torsoG, rect(Math.PI - 0.06, Math.PI + 0.06, 0.122, 0.99), "spine", { ...P, thickness: 0.006 * pk });

  // arc reactor
  const dimGlow = new THREE.MeshBasicMaterial({ color: style.glow, toneMapped: false });
  const reactor = chestReactor(style.reactor, mats, dimGlow);
  reactor.group.scale.setScalar(reactorScale);
  reactor.group.position.copy(T.point(0, tR)).addScaledVector(T.normal(0, tR), 0.0045 * pk);
  reactor.group.quaternion.setFromUnitVectors(Z, T.normal(0, tR));
  chestG.add(reactor.group);

  // ─── pelvis ───
  const PV = an.pelvis;
  const hips = new THREE.Group();
  hips.position.y = J.pelvisY;
  body.add(hips);
  skin(PV, hips, { segU: 64, segV: 20 });
  plate(PV, hips, rect(-1.5, 1.5, 0.0, 0.08), "belt", { ...P, thickness: 0.005 * pk });
  plate(PV, hips, rect(1.5, TAU - 1.5, 0.0, 0.08), "belt", { ...P, thickness: 0.005 * pk });
  plate(PV, hips, symmetric(roundChain([[0, 0.08], [0.3, 0.08], [0.45, 0.14], [0.47, 0.33], [0.36, 0.58], [0.18, 0.85], [0, 0.95]], 0.25)), "pelvis");
  plate(PV, hips, symmetric(rounded([[0, 0.18], [0.2, 0.2], [0.24, 0.42], [0.14, 0.62], [0, 0.7]], [0, 0.3, 0.3, 0.3, 0])), "pelvis", onTop(P, 0.0025));
  both((M) => {
    plate(PV, hips, M(rounded([[0.3, 0.08], [1.72, 0.08], [1.7, 0.52], [1.25, 0.64], [0.6, 0.47], [0.47, 0.33], [0.45, 0.14]], [0, 0, 0.2, 0.3, 0.3, 0, 0])), "hips");
    plate(PV, hips, M(rounded([[1.72, 0.08], [Math.PI - 0.03, 0.08], [Math.PI - 0.03, 0.7], [2.5, 0.78], [1.88, 0.58], [1.7, 0.52]], [0, 0, 0.2, 0.3, 0.3, 0])), "hips");
  });

  // ─── neck + helmet ───
  const neckG = new THREE.Group();
  neckG.position.set(0, J.neckY - J.torsoY, -0.004);
  torsoG.add(neckG);
  skin(an.neck, neckG, { segU: 36, segV: 10 });
  const headG = new THREE.Group();
  headG.position.set(0, J.headY - J.neckY, 0.008);
  headG.rotation.set(0.03, 0.06, 0);
  neckG.add(headG);
  const Hd = an.head;
  skin(Hd, headG, { segU: 72, segV: 44 });
  const eyeR: P2[] = [[0.115, 0.536], [0.2, 0.575], [0.53, 0.594], [0.605, 0.574], [0.56, 0.545], [0.22, 0.528]];
  const pivot = new THREE.Vector3(0, Hd.length * 0.53, -0.006);
  const faceHinge = new THREE.Group();
  faceHinge.position.copy(pivot);
  headG.add(faceHinge);
  const face = new THREE.Group();
  face.position.copy(pivot).negate();
  faceHinge.add(face);
  const eyeMat = new THREE.MeshBasicMaterial({ color: style.glow, toneMapped: false });
  const HP: PlateOpts = { thickness: 0.004 * pk, base: 0.0022 * pk, gap: 0.001 * pk, bevel: 0.001 * pk, maxEdge: 0.007 };
  // upper face (forehead, eyes, nose)
  plate(
    Hd,
    face,
    symmetric([[0, 0.83], [0.1, 0.838], [0.26, 0.852], [0.58, 0.836], [0.86, 0.77], [0.95, 0.64], [0.945, 0.515], [0.6, 0.506], [0.16, 0.5], [0.135, 0.38], [0.12, 0.258], [0, 0.254]]),
    "faceplate",
    { ...HP, holes: [eyeR, mirror(eyeR)] },
  );
  both((M) => {
    plate(Hd, face, M([[0.16, 0.5], [0.6, 0.506], [0.34, 0.262], [0.12, 0.258], [0.135, 0.38]]), "faceplate", HP);
    plate(Hd, face, M([[0.6, 0.506], [0.945, 0.515], [0.95, 0.47], [0.865, 0.41], [0.7, 0.29], [0.67, 0.264], [0.34, 0.262]]), "faceplate", HP);
    plate(Hd, face, M(roundChain([[0.012, 0.248], [0.665, 0.258], [0.56, 0.17], [0.42, 0.115], [0.2, 0.098], [0.012, 0.094]], 0.2)), "faceplate", HP);
    // eye lenses: just under the faceplate surface so the slits read as light
    plate(Hd, face, M(grow(eyeR, 1.16, 1.45)), "glow", { thickness: 0.0004, base: (HP.base ?? 0) + (HP.thickness ?? 0) - 0.0016 * pk, gap: 0, bevel: 0.0001, maxEdge: 0.006 }).material = eyeMat;
  });
  // HUD on the inside (visible when the faceplate lifts)
  const hudMat = new THREE.MeshStandardMaterial({ color: 0x030405, roughness: 0.6, metalness: 0.2, emissive: 0x7fdcff, emissiveMap: hudTexture(), emissiveIntensity: 0 });
  const hud = new THREE.Mesh(skinGeometry(Hd, { th0: -0.82, th1: 0.82, t0: 0.3, t1: 0.76, offset: 0.0012, segU: 24, segV: 12, unitUV: true }), hudMat);
  hud.userData.noPick = true;
  headG.add(hud);
  // helmet shell
  both((M) => {
    plate(Hd, headG, M([[0.86, 0.77], [0.95, 0.64], [0.945, 0.515], [0.95, 0.47], [0.865, 0.41], [0.7, 0.29], [0.56, 0.17], [0.42, 0.115], [0.44, 0.06], [1.4, 0.035], [2.62, 0.04], [2.62, 0.7], [2.2, 0.76], [1.5, 0.785]]), "helmet", HP);
    plate(Hd, headG, M([[0.115, 0.84], [0.26, 0.852], [0.58, 0.836], [0.86, 0.77], [1.5, 0.785], [2.2, 0.76], [2.62, 0.7], [3.02, 0.69], [3.02, 0.94], [0.115, 0.94]]), "helmet", HP);
    // ear piece: ring + raised centre
    const ring = M(ellipse(1.72, 0.46, 0.3, 0.092, 36));
    const hole = M(ellipse(1.72, 0.46, 0.18, 0.055, 28));
    plate(Hd, headG, ring, "ears", { ...onTop(HP, 0.003), holes: [hole] });
    plate(Hd, headG, M(ellipse(1.72, 0.46, 0.16, 0.049, 28)), "ears", onTop(HP, 0.005));
  });
  plate(Hd, headG, [[0.2, 0.098], [0.42, 0.115], [0.44, 0.06], [0.3, 0.035], [-0.3, 0.035], [-0.44, 0.06], [-0.42, 0.115], [-0.2, 0.098], [0, 0.094]], "helmet", HP);
  plate(Hd, headG, [[0, 0.83], [0.115, 0.84], [0.115, 0.94], [-0.115, 0.94], [-0.115, 0.84]], "crest", HP);
  plate(Hd, headG, rect(3.02, TAU - 3.02, 0.69, 0.94), "crest", HP);
  plate(Hd, headG, rect(2.62, TAU - 2.62, 0.04, 0.7), "helmet", HP);
  {
    const { geometry, normal } = capGeometry(Hd, 0.94, HP);
    const cap = new THREE.Mesh(geometry, mats[roleOf("helmet")]);
    cap.castShadow = cap.receiveShadow = true;
    headG.add(cap);
    plates.push({ obj: cap, home: cap.position.clone(), dir: normal, k: 1 });
  }

  // ─── arms ───
  const arms: Arm[] = [];
  const repulsors: THREE.Object3D[] = [];
  const palmExhaust: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }[] = [];
  for (const s of [1, -1]) {
    const sh = new THREE.Group();
    sh.position.set(s * J.shoulderX, J.shoulderY - J.torsoY, -0.008);
    sh.scale.x = s;
    torsoG.add(sh);
    const UA = an.upperArm;
    skin(UA, sh, { segU: 40, segV: 22 });
    for (const [t0, t1] of [
      [0.16, 0.48],
      [0.48, 0.86],
    ]) {
      plate(UA, sh, rounded(rect(-1.5, 1.5, t0, t1), 0.1), "upperArms");
      plate(UA, sh, rounded(rect(1.5, TAU - 1.5, t0, t1), 0.1), "upperArms");
      // raised outer panel with a chamfered top (biceps / deltoid housings)
      plate(UA, sh, rounded([[0.15, t0 + 0.06], [1.35, t0 + 0.05], [1.4, t1 - 0.06], [0.2, t1 - 0.05]], [0.3, 0.2, 0.2, 0.3]), "upperArms", onTop(P, 0.0024));
    }
    // pauldron: shingled bands under a cap
    const pg = new THREE.Group();
    pg.position.set(0.012, 0.084 * an.p.arm, 0);
    sh.add(pg);
    const PD = an.pauldron;
    skin(PD, pg, { segU: 40, segV: 14 });
    {
      const { geometry, normal } = capGeometry(PD, 0.36, { ...P, base: 0.0095 * pk, start: true });
      const cap = new THREE.Mesh(geometry, mats[roleOf("shoulders")]);
      cap.castShadow = cap.receiveShadow = true;
      pg.add(cap);
      plates.push({ obj: cap, home: cap.position.clone(), dir: normal, k: 1.4 });
    }
    plate(PD, pg, rounded(rect(-1.15, 4.29, 0.36, 0.66), 0.08), "shoulders", { ...P, base: 0.0062 * pk }, 1.2);
    plate(PD, pg, rounded(rect(-1.15, 4.29, 0.66, 0.97), 0.08), "shoulders", { ...P, base: 0.003 * pk }, 1.1);
    // elbow + gauntlet
    const el = new THREE.Group();
    el.position.y = -J.upperLen;
    sh.add(el);
    const FA = an.forearm;
    skin(FA, el, { segU: 40, segV: 22 });
    plate(FA, el, rounded(rect(0.3, 2.84, 0.08, 0.84), 0.1), "forearms");
    plate(FA, el, rounded([[0.85, 0.22], [2.3, 0.2], [2.25, 0.62], [0.9, 0.66]], 0.2), "forearmPanels", onTop(P, 0.0028));
    plate(FA, el, rounded(rect(-2.84, -0.3, 0.1, 0.84), 0.1), "forearms");
    plate(FA, el, rect(-0.3, 0.3, 0.1, 0.84), "forearms");
    plate(FA, el, rect(2.84, TAU - 2.84, 0.1, 0.84), "forearms");
    plate(FA, el, rect(-1.57, 1.57, 0.84, 0.965), "cuffs", { ...P, thickness: 0.0055 * pk });
    plate(FA, el, rect(1.57, 4.71, 0.84, 0.965), "cuffs", { ...P, thickness: 0.0055 * pk });
    // hand
    const wr = new THREE.Group();
    wr.position.y = -J.foreLen;
    el.add(wr);
    const PM = an.palm;
    skin(PM, wr, { segU: 32, segV: 14 });
    plate(PM, wr, rounded(rect(0.3, 2.84, 0.1, 0.9), 0.2), "hands", SMALL);
    plate(PM, wr, rounded(rect(0.75, 2.4, 0.3, 0.7), 0.25), "hands", onTop(SMALL, 0.0015));
    const rep = repulsor(mats, an.p.hand);
    rep.position.copy(PM.point(-Math.PI / 2, 0.5)).addScaledVector(PM.normal(-Math.PI / 2, 0.5), 0.0004);
    rep.quaternion.setFromUnitVectors(Z, PM.normal(-Math.PI / 2, 0.5));
    wr.add(rep);
    repulsors.push(rep);
    const ex = exhaust(0.16 * an.p.hand, 0.016 * an.p.hand, style.glow);
    ex.mesh.rotation.x = -Math.PI / 2;
    rep.add(ex.mesh);
    palmExhaust.push(ex);
    const joints: Arm["joints"] = [];
    for (const f of an.fingers) {
      const knuckle = new THREE.Group();
      knuckle.position.set(0.0015, -J.palmLen + 0.005, f.z);
      knuckle.rotation.x = f.splay;
      wr.add(knuckle);
      let parent: THREE.Group = knuckle;
      f.segs.forEach((S, i) => {
        const jg = i === 0 ? knuckle : new THREE.Group();
        if (i > 0) {
          jg.position.y = -f.segs[i - 1].length * 0.9;
          parent.add(jg);
        }
        jg.rotation.z = f.curl[i];
        joints.push({ g: jg, base: f.curl[i] });
        skin(S, jg, { segU: 16, segV: 10 });
        plate(S, jg, rect(0.42, 2.72, 0.2, 0.8), "hands", i === 2 ? TINY : SMALL);
        parent = jg;
      });
    }
    const thumb = new THREE.Group();
    thumb.position.set(-0.006 * an.p.hand, -0.026 * an.p.hand, 0.03 * an.p.hand);
    thumb.rotation.set(-0.5, 0.35, -0.42);
    wr.add(thumb);
    {
      let parent: THREE.Group = thumb;
      an.thumb.forEach((S, i) => {
        const jg = i === 0 ? thumb : new THREE.Group();
        if (i > 0) {
          jg.position.y = -an.thumb[i - 1].length * 0.9;
          jg.rotation.z = -0.18;
          joints.push({ g: jg, base: -0.18 });
          parent.add(jg);
        }
        skin(S, jg, { segU: 16, segV: 10 });
        plate(S, jg, rect(0.2, 2.6, 0.18, 0.82), "hands", i === 2 ? TINY : SMALL);
        parent = jg;
      });
    }
    sh.rotation.set(-0.06, 0, s * 0.19);
    el.rotation.x = -0.28;
    wr.rotation.set(0.08, 0, -0.05);
    arms.push({ s, sh, el, wr, home: sh.position.clone(), joints, thumb });
  }

  // ─── legs ───
  const legs: Leg[] = [];
  const boots: THREE.Object3D[] = [];
  const bootExhaust: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial }[] = [];
  let kneeG: THREE.Group | null = null;
  let footG: THREE.Group | null = null;
  for (const s of [1, -1]) {
    const hip = new THREE.Group();
    hip.position.set(s * J.hipX, J.hipY - J.pelvisY, 0.004);
    hip.scale.x = s;
    hip.rotation.z = s * 0.035;
    hips.add(hip);
    const TH = an.thigh;
    skin(TH, hip, { segU: 48, segV: 26 });
    plate(TH, hip, rounded([[-0.9, 0.12], [0.02, 0.085], [0.95, 0.12], [0.95, 0.86], [-0.9, 0.86]], [0.2, 0, 0.2, 0.12, 0.12]), "thighs");
    plate(TH, hip, rounded([[-0.42, 0.27], [0.52, 0.25], [0.58, 0.72], [-0.36, 0.74]], 0.22), "thighs", onTop(P, 0.0025));
    plate(TH, hip, rounded([[0.95, 0.12], [2.2, 0.08], [2.2, 0.84], [0.95, 0.86]], 0.1), "thighSides");
    plate(TH, hip, rounded([[2.2, 0.08], [TAU - 2.2, 0.14], [TAU - 2.2, 0.84], [2.2, 0.84]], 0.1), "thighs");
    plate(TH, hip, rounded([[-2.2, 0.14], [-0.9, 0.12], [-0.9, 0.86], [-2.2, 0.84]], 0.1), "thighSides");
    const kn = new THREE.Group();
    kn.position.y = -J.thighLen;
    kn.rotation.x = 0.05;
    hip.add(kn);
    const kp = new THREE.Group();
    kp.position.set(0, 0.058 * an.p.leg, 0.027 * an.p.leg);
    kn.add(kp);
    const KN = an.knee;
    plate(KN, kp, rounded(rect(-1.25, 1.25, 0.1, 0.9), 0.3), "knees", P, 1.3);
    plate(KN, kp, [[0, 0.24], [0.55, 0.5], [0, 0.76], [-0.55, 0.5]], "knees", onTop(P, 0.0032), 1.3);
    const SH = an.shin;
    skin(SH, kn, { segU: 44, segV: 26 });
    plate(SH, kn, rounded([[-1.08, 0.07], [0, 0.055], [1.08, 0.07], [1.05, 0.55], [0.8, 0.86], [0, 0.885], [-0.8, 0.86], [-1.05, 0.55]], [0.15, 0, 0.15, 0, 0.2, 0, 0.2, 0]), "shins");
    plate(SH, kn, rounded([[1.08, 0.07], [Math.PI - 0.025, 0.07], [Math.PI - 0.025, 0.86], [0.8, 0.86], [1.05, 0.55]], [0, 0.15, 0.15, 0, 0]), "calves");
    plate(SH, kn, mirror(rounded([[1.08, 0.07], [Math.PI - 0.025, 0.07], [Math.PI - 0.025, 0.86], [0.8, 0.86], [1.05, 0.55]], [0, 0.15, 0.15, 0, 0])), "calves");
    plate(SH, kn, [[-1.57, 0.86], [-0.8, 0.86], [0, 0.885], [0.8, 0.86], [1.57, 0.86], [1.57, 0.975], [-1.57, 0.975]], "ankles");
    plate(SH, kn, rect(1.57, 4.71, 0.86, 0.975), "ankles");
    const ank = new THREE.Group();
    ank.position.y = -J.shinLen;
    ank.rotation.set(-0.05, 0.1, -0.035);
    kn.add(ank);
    const ft = new THREE.Group();
    ft.position.z = -J.footBack;
    ank.add(ft);
    const FT = an.foot;
    skin(FT, ft, { segU: 44, segV: 28 });
    plate(FT, ft, rounded([[-1.18, 0.32], [1.18, 0.32], [1.22, 0.74], [-1.22, 0.74]], 0.12), "boots");
    plate(FT, ft, rounded([[-1.65, 0.74], [1.65, 0.74], [1.72, 0.92], [0.95, 0.982], [-0.95, 0.982], [-1.72, 0.92]], [0, 0, 0.3, 0.3, 0.3, 0.3]), "boots");
    plate(FT, ft, rounded([[1.18, 0.05], [2.42, 0.05], [2.42, 0.74], [1.22, 0.74], [1.18, 0.32]], [0.25, 0.2, 0.1, 0, 0]), "boots");
    plate(FT, ft, mirror(rounded([[1.18, 0.05], [2.42, 0.05], [2.42, 0.74], [1.22, 0.74], [1.18, 0.32]], [0.25, 0.2, 0.1, 0, 0])), "boots");
    plate(FT, ft, ellipse(Math.PI / 2, 0.2, 0.36, 0.09, 30), "ankles", onTop(P, 0.003));
    // sole thrusters
    for (const tz of [0.24, 0.66]) {
      const thr = new THREE.Group();
      const sp = FT.point(Math.PI, tz);
      thr.position.set(0, sp.y - 0.0008, sp.z);
      thr.rotation.x = Math.PI / 2;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.019 * an.p.leg, 0.0028, 8, 36), mats.steel);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.0175 * an.p.leg, 36), mats.glow);
      disc.position.z = 0.0005;
      thr.add(ring, disc);
      const ex2 = exhaust(0.34 * an.p.leg, 0.024 * an.p.leg, style.glow);
      ex2.mesh.rotation.x = -Math.PI / 2;
      thr.add(ex2.mesh);
      bootExhaust.push(ex2);
      ft.add(thr);
      boots.push(thr);
    }
    if (!kneeG) kneeG = kp;
    if (!footG) footG = ft;
    legs.push({ s, hip, kn, ank, home: hip.position.clone() });
  }

  if (style.hulk) content.scale.setScalar(1.45);

  // ─── labels ───
  const fp = Hd.point(0, 0.5).add(Hd.normal(0, 0.5).multiplyScalar(0.012));
  const parts: PartAnchor[] = [
    part("Helmet & faceplate", "Hinged faceplate with HUD optics; lifts to reveal the display inside.", 1, at(face, fp.x, fp.y, fp.z), faceHinge),
    part("Arc reactor", style.reactor === "round" ? "Chest reactor with ten copper coils; powers every system." : style.reactor === "triangle" ? "New-element reactor: triangular core, far higher output." : "Nanotech housing: the suit flows out of it on command.", 1, at(reactor.group, 0, 0, 0.02)),
    part("Repulsors", "Palm emitters for flight stabilisation and weapons.", 1, at(repulsors[0], 0, 0, 0.01)),
    part("Chest plate", "Layered armour over the reactor and vital systems.", 2, centerOf(chestG, 0.15), chestG),
    part("Pauldrons", "Shingled shoulder plates over the arm actuators.", 2, at(arms[0].sh, 0.03, 0.06, 0)),
    part("Gauntlets", "Forearm housings for micro-missiles and servos.", 2, at(arms[0].el, 0.06, -0.12, 0.0)),
    part("Boot thrusters", "Main flight thrusters in the soles.", 1, at(footG!, 0, -0.09, 0.12)),
    part("Knee actuators", "Load-bearing joints that absorb landings.", 2, at(kneeG!, 0, 0, 0.06)),
    part("Flight flaps", "Back flaps that open for stability and cooling.", 2, at(flaps[0].g, 0, -0.08, -0.02), flaps[0].g),
  ];

  // ─── actions ───
  const s0 = style.schemes[0];
  const state = { faceplate: false, repulsors: false, flight: false, armor: false };
  const anim = { face: 0, rep: 0, fly: 0, open: 0, explode: 0 };
  const target = { primary: new THREE.Color(s0.primary), secondary: new THREE.Color(s0.secondary) };
  const actions: ModelAction[] = [
    { id: "faceplate", label: "Faceplate", kind: "toggle", words: ["faceplate", "face plate", "helmet", "mask", "visor"], value: false, parts: [faceHinge] },
    { id: "repulsors", label: "Repulsors", kind: "toggle", words: ["repulsor", "repulsors", "hands", "palms", "weapons"], value: false, parts: arms.map((a) => a.wr) },
    { id: "flight", label: "Flight mode", kind: "toggle", words: ["flight", "fly", "thrusters", "hover", "take off"], value: false, parts: [...boots, ...flaps.map((f) => f.g)] },
    { id: "armor", label: "Armor", kind: "toggle", words: ["armor", "armour", "suit", "plates", "chest"], value: false, parts: [chestG] },
  ];
  if (style.schemes.length > 1) actions.push({ id: "paint", label: "Paint", kind: "choice", options: style.schemes.map((s) => s.name), words: ["paint", "colour", "color", "scheme", "finish"], value: s0.name });

  const act = (id: string, value: boolean | string) => {
    if (id === "paint") {
      const s = style.schemes.find((x) => x.name === value) ?? s0;
      target.primary.set(s.primary);
      target.secondary.set(s.secondary);
      return;
    }
    if (id in state) (state as Record<string, boolean>)[id] = Boolean(value);
  };

  const headHome = headG.position.clone();
  const applyPlates = () => {
    const o = ease(anim.open);
    for (const p of plates) p.obj.position.copy(p.home).addScaledVector(p.dir, (0.026 * o * p.k + 0.12 * anim.explode) * pk);
    for (const a of arms) a.sh.position.copy(a.home).add(new THREE.Vector3(a.s * 0.2 * anim.explode, 0.02 * anim.explode, 0));
    for (const l of legs) l.hip.position.copy(l.home).add(new THREE.Vector3(l.s * 0.06 * anim.explode, -0.1 * anim.explode, 0));
    headG.position.copy(headHome).add(new THREE.Vector3(0, 0.16 * anim.explode, 0));
  };
  const primaryMat = mats.primary as THREE.MeshPhysicalMaterial;
  const secondaryMat = mats.secondary as THREE.MeshPhysicalMaterial;
  let lastOpen = -1;
  let lastExplode = -1;

  return {
    content,
    parts,
    actions,
    act,
    explode(a) {
      anim.explode = a;
    },
    update(dt, t) {
      const k = 1 - Math.exp(-dt * 4);
      anim.face += ((state.faceplate ? 1 : 0) - anim.face) * k;
      anim.rep += ((state.repulsors ? 1 : 0) - anim.rep) * k;
      anim.fly += ((state.flight ? 1 : 0) - anim.fly) * k * 0.7;
      anim.open += ((state.armor ? 1 : 0) - anim.open) * k;
      const face = ease(anim.face);
      faceHinge.rotation.x = -1.5 * face;
      faceHinge.position.set(pivot.x, pivot.y + 0.022 * face, pivot.z + 0.03 * face);
      faceHinge.scale.setScalar(1 + 0.06 * face);
      const g = holoGain.value;
      hudMat.emissiveIntensity = face * 1.1 * g;
      // arms: relaxed · repulsors (arm forward, palm out) · flight (arms back, palms behind)
      const f = ease(anim.fly);
      const r = ease(anim.rep) * (1 - f);
      const rest = 1 - r - f;
      for (const a of arms) {
        a.sh.rotation.x = -0.06 * rest - 1.42 * r + 0.36 * f;
        a.sh.rotation.z = a.s * (0.19 * rest + 0.1 * r + 0.24 * f);
        a.el.rotation.x = -0.28 * rest - 0.06 * r - 0.08 * f;
        a.wr.rotation.set(0.08 * rest, -1.5708 * (r + f), -0.05 * rest + 1.38 * r + 0.55 * f);
        const curl = 1 - 0.95 * r - 0.55 * f;
        for (const j of a.joints) j.g.rotation.z = j.base * curl + 0.08 * r;
      }
      for (const l of legs) {
        l.hip.rotation.x = 0.08 * f;
        l.hip.rotation.z = l.s * (0.035 - 0.03 * f);
        l.ank.rotation.x = -0.05 + 0.5 * f;
      }
      body.position.y = f * (0.2 + 0.015 * Math.sin(t * 2.2));
      for (const fl of flaps) fl.g.quaternion.setFromAxisAngle(fl.axis, fl.sign * 0.5 * f);
      for (const e of bootExhaust) {
        e.mesh.visible = f > 0.02;
        e.mat.uniforms.uGain.value = f * g;
        e.mat.uniforms.uTime.value = t;
        e.mesh.scale.set(1, 0.85 + 0.15 * Math.sin(t * 31), 1);
      }
      for (const e of palmExhaust) {
        e.mesh.visible = f > 0.02;
        e.mat.uniforms.uGain.value = f * g * 0.6;
        e.mat.uniforms.uTime.value = t;
      }
      // glow follows the brightness control (low by default)
      const pulse = 0.9 + 0.1 * Math.sin(t * 3);
      glowMat.color.copy(glowBase).multiplyScalar(1.6 * g * pulse * (1 + 0.7 * anim.rep + 0.4 * f));
      dimGlow.color.copy(glowBase).multiplyScalar(0.55 * g * pulse * (1 + 0.5 * anim.rep));
      eyeMat.color.copy(glowBase).multiplyScalar(2.7 * g * (0.96 + 0.04 * Math.sin(t * 2.3)));
      reactor.light.intensity = (0.35 + 0.35 * anim.rep) * g;
      if (Math.abs(anim.open - lastOpen) > 1e-4 || Math.abs(anim.explode - lastExplode) > 1e-4) {
        lastOpen = anim.open;
        lastExplode = anim.explode;
        applyPlates();
      }
      const kc = 1 - Math.exp(-dt * 3);
      primaryMat.color.lerp(target.primary, kc);
      secondaryMat.color.lerp(target.secondary, kc);
    },
  };
}

const IRON_SCHEMES = (main: Scheme): Scheme[] => [
  main,
  { name: "Stealth", primary: 0x23272d, secondary: 0x5b626b },
  { name: "Gold", primary: 0xb88a2c, secondary: 0xe3bf62 },
  { name: "Silver", primary: 0xaab1b9, secondary: 0x6e757e },
];

const wrap = (b: Built, radius: number): BuiltObject => {
  b.content.position.y = -0.95 * b.content.scale.y;
  const g = new THREE.Group();
  g.add(b.content);
  g.userData.grounded = true; // Deep Dive: stands on a soft floor shadow
  return { content: g, radius, parts: b.parts, actions: b.actions, act: b.act, update: b.update, explode: b.explode };
};

const regions = (...r: string[]) => new Set(r);
/** Iron Man proportions: broad chest and shoulders, compact helmet. */
const IRON: Proportions = { ...HEROIC, tw: 1.07, td: 1.03, arm: 1.04, leg: 1.06, head: 0.93 };

export const buildMark3 = () =>
  wrap(
    buildIronSuit({
      schemes: IRON_SCHEMES({ name: "Classic", primary: 0x9a1016, secondary: 0xd6a548 }),
      gold: regions("faceplate", "abs", "upperArms", "thighSides", "ankles", "forearmPanels"),
      glow: 0xd4f4ff,
      reactor: "round",
      p: IRON,
    }),
    0.97,
  );

export const buildMark42 = () =>
  wrap(
    buildIronSuit({
      schemes: IRON_SCHEMES({ name: "Classic", primary: 0x8e1218, secondary: 0xd8a83e }),
      gold: regions("faceplate", "chest", "collar", "abs", "upperArms", "forearms", "forearmPanels", "cuffs", "hands", "thighs", "knees", "shins", "boots"),
      glow: 0xd8f6ff,
      reactor: "round",
      p: IRON,
    }),
    0.97,
  );

export const buildMark50 = () =>
  wrap(
    buildIronSuit({
      schemes: IRON_SCHEMES({ name: "Nanotech", primary: 0x700a10, secondary: 0xcf9c3c }),
      gold: regions("faceplate", "abs", "forearmPanels", "knees", "ears", "cuffs", "ankles"),
      glow: 0xc4f1ff,
      reactor: "hex",
      p: { ...IRON, tw: 1.04, arm: 1.0 },
      nano: true,
    }),
    0.97,
  );

export const buildMark85 = () =>
  wrap(
    buildIronSuit({
      schemes: IRON_SCHEMES({ name: "Classic", primary: 0x8a0f15, secondary: 0xd9aa4a }),
      gold: regions("faceplate", "abs", "upperArms", "forearms", "thighSides", "knees", "shoulders", "ears", "ankles", "pelvis"),
      glow: 0xdaf7ff,
      reactor: "triangle",
      p: { ...IRON, tw: 1.08 },
      nano: true,
    }),
    0.97,
  );

export const buildHulkbuster = () =>
  wrap(
    buildIronSuit({
      schemes: IRON_SCHEMES({ name: "Classic", primary: 0x98141a, secondary: 0xd4a531 }),
      gold: regions("faceplate", "abs", "forearms", "forearmPanels", "shins", "knees", "cuffs", "ears"),
      glow: 0xd2f5ff,
      reactor: "round",
      p: { tw: 1.6, td: 1.5, arm: 1.9, leg: 1.6, hand: 1.9, head: 0.95 },
      hulk: true,
    }),
    1.45,
  );

export { buildSpiderClassic, buildIronSpider } from "./spider";
