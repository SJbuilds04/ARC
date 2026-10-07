import * as THREE from "three";
import type { BuiltObject, ModelAction } from "./types";
import { at, part, type PartAnchor } from "./parts";
import { holoGain } from "../holo";
import { anatomy, HEROIC } from "./anatomy";
import { type Surface, type P2, type PlateOpts, TAU, plateGeometry, skinGeometry, rounded, symmetric, mirror, rect, grow, flakeNormalMap } from "./suitkit";

/**
 * Spider-Man suits (ARC's own procedural recreations, not official assets) on the shared
 * anatomy: stretch fabric with raised web lines that radiate from the chest emblem and the
 * centre of the mask, big framed lenses that narrow, web-shooters — and the Iron Spider in
 * red-and-gold nanotech plating with its four mechanical legs.
 */

interface Built {
  content: THREE.Group;
  parts: PartAnchor[];
  actions: ModelAction[];
  act(id: string, value: boolean | string): void;
  update(dt: number, t: number): void;
  explode(a: number): void;
}

interface SpiderScheme {
  name: string;
  red: number;
  blue: number;
  line: number;
  trim: number;
}

const Z = new THREE.Vector3(0, 0, 1);

// ─── web textures (drawn in each surface's parameter space) ───

/** Limb web: meridians with scalloped rings between them (one cell per tile). */
function webTile(): HTMLCanvasElement {
  const W = 128;
  const H = 128;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const img = g.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d1 = Math.min(x, W - x);
      const yc = 18 + 26 * Math.sin((Math.PI * x) / W);
      const d2 = Math.min(Math.abs(y - yc), Math.abs(y - yc - H), Math.abs(y - yc + H));
      const d = Math.min(d1, d2);
      const v = 255 - Math.round(255 * Math.max(0, Math.min(1, (3.2 - d) / 1.6)));
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Radial web around centres (chest emblem, back, face) for a surface: canvas = (θ, t). */
function webRadial(surf: Surface, centres: P2[], maxR: number): HTMLCanvasElement {
  const W = 2048;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, W, H);
  const R0 = surf.radius(0.5);
  const L = surf.length;
  const sx = W / (TAU * R0);
  const sy = H / L;
  g.strokeStyle = "#000";
  g.lineCap = "round";
  g.lineJoin = "round";
  g.lineWidth = 3.4;
  const toPx = (x: number, y: number): [number, number] => [(x + Math.PI * R0) * sx, H - y * sy];
  const spokes = 16;
  for (const [thc, tc] of centres) {
    for (const wrapShift of [-TAU * R0, 0, TAU * R0]) {
      const cx = thc * R0 + wrapShift;
      const cy = tc * L;
      // spokes
      for (let k = 0; k < spokes; k++) {
        const a = (k / spokes) * TAU + 0.1;
        g.beginPath();
        g.moveTo(...toPx(cx + Math.cos(a) * 0.006, cy + Math.sin(a) * 0.006));
        g.lineTo(...toPx(cx + Math.cos(a) * maxR, cy + Math.sin(a) * maxR));
        g.stroke();
      }
      // rings: straight between spokes, sagging toward the centre
      for (let r = 0.024; r < maxR; r *= 1.32) {
        g.beginPath();
        for (let k = 0; k <= spokes; k++) {
          const a = (k / spokes) * TAU + 0.1;
          const p = toPx(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          if (k === 0) g.moveTo(...p);
          else {
            const am = ((k - 0.5) / spokes) * TAU + 0.1;
            const q = toPx(cx + Math.cos(am) * r * 0.86, cy + Math.sin(am) * r * 0.86);
            g.quadraticCurveTo(q[0], q[1], p[0], p[1]);
          }
        }
        g.stroke();
      }
    }
  }
  return c;
}

const tileCanvas = { c: null as HTMLCanvasElement | null };

function limbWebTexture(surf: Surface, meridians: number, ring = 0.05): THREE.Texture {
  if (!tileCanvas.c) tileCanvas.c = webTile();
  const t = new THREE.CanvasTexture(tileCanvas.c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.repeat.set(meridians / (TAU * surf.radius(0.5)), 1 / ring);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function radialWebTexture(surf: Surface, centres: P2[], maxR: number): THREE.Texture {
  const t = new THREE.CanvasTexture(webRadial(surf, centres, maxR));
  t.wrapS = THREE.RepeatWrapping;
  t.anisotropy = 8;
  const R0 = surf.radius(0.5);
  t.repeat.set(1 / (TAU * R0), 1 / surf.length);
  t.offset.set(0.5, 0);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Spider emblem as plate outlines on a surface (metric layout → (θ, t)). */
function spiderOutlines(surf: Surface, thc: number, tc: number, size: number, bold: boolean): P2[][] {
  const r = surf.r(thc, tc);
  const L = surf.length;
  const P = (x: number, y: number): P2 => [thc + (x * size) / r, tc + (y * size) / L];
  const out: P2[][] = [];
  const ell = (cx: number, cy: number, rx: number, ry: number, n = 20) => {
    const pts: P2[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      pts.push(P(cx + Math.sin(a) * rx, cy + Math.cos(a) * ry));
    }
    return pts;
  };
  out.push(ell(0, 0.2, 0.11, 0.13));
  out.push(ell(0, -0.2, 0.15, 0.3));
  const w = bold ? 0.05 : 0.032;
  const leg = (pts: [number, number][]) => {
    // thick polyline → polygon
    const left: P2[] = [];
    const right: P2[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(pts.length - 1, i + 1)];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l;
      const ny = dx / l;
      const ww = w * (1 - (0.6 * i) / (pts.length - 1));
      left.push(P(pts[i][0] + nx * ww, pts[i][1] + ny * ww));
      right.push(P(pts[i][0] - nx * ww, pts[i][1] - ny * ww));
    }
    out.push([...left, ...right.reverse()]);
  };
  for (const s of [1, -1]) {
    leg([[s * 0.08, 0.25], [s * 0.42, 0.62], [s * 0.5, 1.05]]);
    leg([[s * 0.1, 0.12], [s * 0.55, 0.32], [s * 0.78, 0.62]]);
    leg([[s * 0.12, -0.05], [s * 0.55, -0.2], [s * 0.78, -0.62]]);
    leg([[s * 0.1, -0.22], [s * 0.42, -0.55], [s * 0.5, -1.05]]);
  }
  return out;
}

function buildSpider(iron: boolean, schemes: SpiderScheme[]): Built {
  const an = anatomy(HEROIC, { slim: true });
  const J = an.j;
  const s0 = schemes[0];
  const content = new THREE.Group();
  const body = new THREE.Group();
  content.add(body);

  // ─── materials ───
  const redMats: THREE.MeshPhysicalMaterial[] = [];
  const blueMats: THREE.MeshPhysicalMaterial[] = [];
  const fabric = (color: number, web: THREE.Texture | null, red: boolean) => {
    const m = iron
      ? new THREE.MeshPhysicalMaterial({ color, metalness: red ? 0.55 : 0.6, roughness: red ? 0.34 : 0.4, clearcoat: 1, clearcoatRoughness: 0.05, normalMap: flakeNormalMap(), normalScale: new THREE.Vector2(0.14, 0.14) })
      : new THREE.MeshPhysicalMaterial({
          color,
          roughness: 0.6,
          metalness: 0,
          sheen: 1,
          sheenRoughness: 0.42,
          sheenColor: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.35),
          map: web,
          bumpMap: web,
          bumpScale: web ? -1.6 : 0,
        });
    (red ? redMats : blueMats).push(m);
    return m;
  };
  const lineMat = new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.45, metalness: 0.2, side: THREE.DoubleSide });
  const trimMat = new THREE.MeshPhysicalMaterial({ color: s0.trim, metalness: 1, roughness: 0.3, clearcoat: 0.3, clearcoatRoughness: 0.2, side: THREE.DoubleSide });
  const lensMat = new THREE.MeshPhysicalMaterial({ color: 0xf2f5f8, roughness: 0.18, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05, emissive: 0x8899aa, emissiveIntensity: 0.15, side: THREE.DoubleSide });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1b1e23, metalness: 0.85, roughness: 0.4, side: THREE.DoubleSide });
  const panelRed = iron ? fabric(s0.red, null, true) : null;
  const panelBlue = iron ? fabric(s0.blue, null, false) : null;

  const skin = (surf: Surface, parent: THREE.Object3D, mat: THREE.Material, o: Parameters<typeof skinGeometry>[1] = {}) => {
    const m = new THREE.Mesh(skinGeometry(surf, o), mat);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const FAB: PlateOpts = { thickness: 0.0009, base: 0.0004, gap: 0, bevel: 0.0005, maxEdge: 0.012 };
  const PL: PlateOpts = { thickness: 0.0035, base: 0.0015, gap: 0.0012, bevel: 0.0012, maxEdge: 0.012 };
  const plate = (surf: Surface, parent: THREE.Object3D, outline: P2[], mat: THREE.Material, o: PlateOpts = FAB) => {
    const m = new THREE.Mesh(plateGeometry(surf, outline, o).geometry, mat);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  /** Smooth joint (elbow, knee, wrist, shoulder) so the fabric flows from one segment to the next. */
  const joint = (parent: THREE.Object3D, r: number, mat: THREE.Material, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 28, 20), mat);
    m.scale.set(sx, sy, sz);
    m.castShadow = m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  /** Red fabric (or plating) for a surface, with its web texture. */
  const redFor = (surf: Surface, meridians: number, ring?: number) => (iron ? panelRed! : fabric(s0.red, limbWebTexture(surf, meridians, ring), true));
  const blue = iron ? panelBlue! : fabric(s0.blue, null, false);

  // ─── torso: blue sides, red front and back panels with radial web ───
  const T = an.torso;
  const torsoG = new THREE.Group();
  torsoG.position.y = J.torsoY;
  body.add(torsoG);
  skin(T, torsoG, blue, { segU: 64, segV: 32 });
  const torsoRed = iron ? panelRed! : fabric(s0.red, radialWebTexture(T, [[0, 0.66], [Math.PI, 0.64]], 0.9), true);
  const frontPanel = symmetric(
    rounded(
      [
        [0, 0.99],
        [0.6, 0.985],
        [1.05, 0.93],
        [1.32, 0.8],
        [1.36, 0.64],
        [1.12, 0.52],
        [0.78, 0.4],
        [0.55, 0.22],
        [0.5, 0.0],
        [0, 0.0],
      ],
      [0, 0.2, 0.3, 0.3, 0.3, 0.3, 0.3, 0.2, 0, 0],
    ),
  );
  plate(T, torsoG, frontPanel, torsoRed, iron ? PL : FAB);
  const backHalf: P2[] = rounded(
    [
      [Math.PI, 0.99],
      [Math.PI - 0.62, 0.985],
      [Math.PI - 1.08, 0.92],
      [Math.PI - 1.3, 0.78],
      [Math.PI - 1.3, 0.6],
      [Math.PI - 0.95, 0.46],
      [Math.PI - 0.62, 0.28],
      [Math.PI - 0.55, 0.0],
      [Math.PI, 0.0],
    ],
    [0, 0.2, 0.3, 0.3, 0.3, 0.3, 0.2, 0, 0],
  );
  const backPanel = [...backHalf, ...backHalf.slice(1, -1).map(([th, t]) => [TAU - th, t] as P2).reverse()];
  plate(T, torsoG, backPanel, torsoRed, iron ? PL : FAB);
  // emblems
  const emblemMat = iron ? trimMat : lineMat;
  const EM: PlateOpts = { thickness: iron ? 0.003 : 0.0008, base: iron ? 0.0088 : 0.0012, gap: 0, bevel: iron ? 0.001 : 0.0004, maxEdge: 0.006 };
  const emblem = new THREE.Group();
  torsoG.add(emblem);
  for (const o of spiderOutlines(T, 0, 0.66, iron ? 0.12 : 0.062, iron)) plate(T, emblem, o, emblemMat, EM);
  for (const o of spiderOutlines(T, Math.PI, 0.6, iron ? 0.1 : 0.11, iron)) plate(T, torsoG, o, iron ? trimMat : lineMat, EM);
  if (iron) {
    // armour panels: chest around the emblem, abdominals, collar
    for (const M of [(p: P2[]) => p, mirror]) {
      plate(T, torsoG, M(rounded([[0.05, 0.56], [0.95, 0.54], [1.2, 0.66], [1.1, 0.86], [0.55, 0.93], [0.05, 0.9]], [0.1, 0.3, 0.3, 0.3, 0.3, 0.1])), panelRed!, { ...PL, base: 0.0049 });
      plate(T, torsoG, M(rounded(rect(0.05, 0.6, 0.4, 0.52), 0.2)), panelRed!, { ...PL, base: 0.0049 });
      plate(T, torsoG, M(rounded(rect(0.05, 0.56, 0.27, 0.385), 0.2)), panelRed!, { ...PL, base: 0.0049 });
      plate(T, torsoG, M(rounded(rect(0.05, 0.52, 0.13, 0.255), 0.2)), panelRed!, { ...PL, base: 0.0049 });
    }
    // gold piping along the panel edges + dark sides
    for (const sgn of [1, -1]) {
      plate(T, torsoG, (sgn > 0 ? (p: P2[]) => p : mirror)(rounded([[1.38, 0.02], [1.5, 0.02], [1.5, 0.66], [1.43, 0.66]], 0.2)), trimMat, { ...PL, thickness: 0.0042 });
    }
  }

  // ─── pelvis ───
  const PV = an.pelvis;
  const hips = new THREE.Group();
  hips.position.y = J.pelvisY;
  body.add(hips);
  skin(PV, hips, blue, { segU: 56, segV: 18 });
  plate(PV, hips, rect(-Math.PI, Math.PI, 0.0, 0.1), iron ? trimMat : redFor(PV, 28), iron ? PL : FAB);

  // ─── neck + head ───
  const neckG = new THREE.Group();
  neckG.position.set(0, J.neckY - J.torsoY, -0.004);
  torsoG.add(neckG);
  skin(an.neck, neckG, redFor(an.neck, 18), { segU: 32, segV: 8 }).scale.set(1.14, 1, 1.12);
  const headG = new THREE.Group();
  headG.position.set(0, J.headY - J.neckY, 0.006);
  headG.rotation.set(0.04, -0.08, 0);
  neckG.add(headG);
  const Hd = an.head;
  const headRed = iron ? panelRed! : fabric(s0.red, radialWebTexture(Hd, [[0, 0.56]], 0.42), true);
  skin(Hd, headG, headRed, { segU: 72, segV: 44 });
  const lensR = rounded(
    [
      [0.075, 0.598],
      [0.2, 0.664],
      [0.47, 0.672],
      [0.64, 0.612],
      [0.6, 0.522],
      [0.42, 0.49],
      [0.17, 0.53],
    ],
    0.3,
  );
  const eyes: THREE.Group[] = [];
  for (const sgn of [1, -1]) {
    const lens = sgn > 0 ? lensR : mirror(lensR);
    const c = lens.reduce((a, p) => [a[0] + p[0] / lens.length, a[1] + p[1] / lens.length] as P2, [0, 0] as P2);
    const centre = Hd.point(c[0], c[1]);
    const g = new THREE.Group();
    g.position.copy(centre);
    const inner = new THREE.Group();
    inner.position.copy(centre).negate();
    g.add(inner);
    headG.add(g);
    plate(Hd, inner, lens, lensMat, { thickness: 0.0015, base: 0.0016, gap: 0, bevel: 0.0008, maxEdge: 0.006 });
    plate(Hd, inner, grow(lens, 1.14, 1.2), lineMat, { thickness: 0.0026, base: 0.0008, gap: 0, bevel: 0.0009, maxEdge: 0.006, holes: [grow(lens, 0.98, 0.97)] });
    eyes.push(g);
  }

  // ─── arms ───
  interface Arm {
    s: number;
    sh: THREE.Group;
    el: THREE.Group;
    wr: THREE.Group;
    home: THREE.Vector3;
    joints: { g: THREE.Group; base: number }[];
  }
  const arms: Arm[] = [];
  const shooters: THREE.Object3D[] = [];
  for (const s of [1, -1]) {
    const sh = new THREE.Group();
    sh.position.set(s * J.shoulderX * 0.97, J.shoulderY - J.torsoY - 0.005, -0.008);
    sh.scale.x = s;
    torsoG.add(sh);
    const UA = an.upperArm;
    skin(UA, sh, blue, { segU: 40, segV: 20 });
    const uaRed = redFor(UA, 14);
    plate(UA, sh, rounded([[-1.25, 0.0], [1.95, 0.0], [1.9, 0.98], [-1.2, 0.98]], 0.1), uaRed, iron ? PL : FAB);
    joint(sh, 0.056, uaRed, 1, 1.05, 1);
    const el = new THREE.Group();
    el.position.y = -J.upperLen;
    sh.add(el);
    const FA = an.forearm;
    const faRed = redFor(FA, 14);
    skin(FA, el, faRed, { segU: 40, segV: 20 });
    joint(el, 0.046, faRed, 1, 1.1, 1.05);
    if (iron) {
      plate(FA, el, rounded(rect(0.2, 1.3, 0.12, 0.8), 0.25), panelRed!, PL);
      plate(FA, el, rounded(rect(1.85, 2.95, 0.12, 0.8), 0.25), panelRed!, PL);
    }
    if (iron) plate(FA, el, rounded(rect(1.38, 1.76, 0.08, 0.86), 0.3), trimMat, PL);
    // web-shooter on the inner wrist
    const ws = new THREE.Group();
    const wp = FA.point(-Math.PI / 2, 0.86);
    ws.position.copy(wp);
    ws.quaternion.setFromUnitVectors(Z, FA.normal(-Math.PI / 2, 0.86));
    const body1 = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.012, 0.006, 24), iron ? trimMat : darkMat);
    body1.rotation.x = Math.PI / 2;
    const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, 0.008, 12), darkMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.z = 0.004;
    ws.add(body1, nozzle);
    el.add(ws);
    shooters.push(ws);
    const wr = new THREE.Group();
    wr.position.y = -J.foreLen;
    el.add(wr);
    const PM = an.palm;
    const palmRed = redFor(PM, 10, 0.03);
    skin(PM, wr, palmRed, { segU: 32, segV: 12 });
    joint(wr, 0.032, palmRed, 0.75, 1, 1.05);
    const joints: Arm["joints"] = [];
    for (const f of an.fingers) {
      const knuckle = new THREE.Group();
      knuckle.position.set(0.0012, -J.palmLen + 0.005, f.z);
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
        skin(S, jg, redFor(S, 6, 0.02), { segU: 16, segV: 10 });
        parent = jg;
      });
    }
    const thumb = new THREE.Group();
    thumb.position.set(-0.006, -0.026, 0.03);
    thumb.rotation.set(-0.5, 0.35, -0.42);
    wr.add(thumb);
    let parent: THREE.Group = thumb;
    an.thumb.forEach((S, i) => {
      const jg = i === 0 ? thumb : new THREE.Group();
      if (i > 0) {
        jg.position.y = -an.thumb[i - 1].length * 0.9;
        jg.rotation.z = -0.18;
        parent.add(jg);
      }
      skin(S, jg, redFor(S, 6, 0.02), { segU: 16, segV: 10 });
      parent = jg;
    });
    sh.rotation.set(-0.04, 0, s * 0.17);
    el.rotation.x = -0.22;
    wr.rotation.set(0.06, 0, -0.04);
    arms.push({ s, sh, el, wr, home: sh.position.clone(), joints });
  }

  // ─── legs ───
  const legs: { s: number; hip: THREE.Group; home: THREE.Vector3 }[] = [];
  for (const s of [1, -1]) {
    const hip = new THREE.Group();
    hip.position.set(s * J.hipX, J.hipY - J.pelvisY, 0.004);
    hip.scale.x = s;
    hip.rotation.z = s * 0.03;
    hips.add(hip);
    const TH = an.thigh;
    skin(TH, hip, blue, { segU: 48, segV: 24 });
    if (iron) plate(TH, hip, rounded([[-0.95, 0.1], [0.95, 0.1], [0.9, 0.9], [-0.9, 0.9]], 0.2), panelRed!, PL);
    else plate(TH, hip, rounded(rect(1.25, 1.95, 0.02, 0.98), 0.3), redFor(TH, 20), FAB);
    const kn = new THREE.Group();
    kn.position.y = -J.thighLen;
    kn.rotation.x = 0.04;
    hip.add(kn);
    const SH = an.shin;
    const shinRed = redFor(SH, 16);
    skin(SH, kn, shinRed, { segU: 44, segV: 24 });
    joint(kn, 0.056, shinRed, 1, 1.15, 1.05);
    if (iron) {
      plate(SH, kn, rounded(rect(-0.16, 0.16, 0.06, 0.9), 0.3), trimMat, PL);
      plate(SH, kn, rounded(rect(0.24, 1.2, 0.08, 0.84), 0.25), panelRed!, PL);
      plate(SH, kn, rounded(rect(-1.2, -0.24, 0.08, 0.84), 0.25), panelRed!, PL);
    }
    const ank = new THREE.Group();
    ank.position.y = -J.shinLen;
    ank.rotation.set(-0.04, 0.08, -0.03);
    kn.add(ank);
    const ft = new THREE.Group();
    ft.position.z = -J.footBack;
    ank.add(ft);
    skin(an.foot, ft, redFor(an.foot, 16, 0.04), { segU: 40, segV: 24 });
    legs.push({ s, hip, home: hip.position.clone() });
  }

  // ─── Iron Spider: four mechanical legs from the back ───
  const waldoes: { root: THREE.Group; seg2: THREE.Group; seg3: THREE.Group; side: number; tier: number }[] = [];
  if (iron) {
    const segment = (len: number, r0: number, r1: number) => {
      const pts = [new THREE.Vector2(0.0001, 0.006), new THREE.Vector2(r0 * 0.8, 0.004), new THREE.Vector2(r0, -0.004), new THREE.Vector2(r1, -len + 0.004), new THREE.Vector2(r1 * 0.7, -len - 0.002), new THREE.Vector2(0.0001, -len - 0.004)];
      return new THREE.LatheGeometry(pts, 20);
    };
    for (const side of [-1, 1]) {
      for (const tier of [0, 1]) {
        const root = new THREE.Group();
        const bp = T.point(Math.PI + side * 0.32, 0.66 - tier * 0.1);
        root.position.copy(bp);
        torsoG.add(root);
        const hub = new THREE.Mesh(new THREE.SphereGeometry(0.016, 16, 12), darkMat);
        root.add(hub);
        root.add(new THREE.Mesh(segment(0.32, 0.012, 0.009), trimMat));
        const seg2 = new THREE.Group();
        seg2.position.y = -0.32;
        root.add(seg2);
        seg2.add(new THREE.Mesh(new THREE.SphereGeometry(0.013, 14, 10), darkMat));
        seg2.add(new THREE.Mesh(segment(0.32, 0.01, 0.008), trimMat));
        const seg3 = new THREE.Group();
        seg3.position.y = -0.32;
        seg2.add(seg3);
        seg3.add(new THREE.Mesh(new THREE.SphereGeometry(0.011, 12, 8), darkMat));
        const tip = new THREE.ConeGeometry(0.009, 0.26, 12);
        tip.translate(0, -0.13, 0);
        seg3.add(new THREE.Mesh(tip, trimMat));
        waldoes.push({ root, seg2, seg3, side, tier });
      }
    }
  }

  // ─── labels ───
  const parts: PartAnchor[] = [
    part("Mask lenses", "Shutter lenses that widen and narrow like eyes.", 1, at(eyes[0], 0, 0, 0.01), eyes[0]),
    part("Spider emblem", iron ? "Gold insignia; the mechanical legs deploy from behind it." : "The chest insignia; the web radiates out from it.", 1, at(emblem, 0, T.length * 0.66, T.r(0, 0.66) + 0.01), emblem),
    part("Web-shooters", "Wrist launchers for synthetic web fluid.", 1, at(shooters[0], 0, 0, 0.01), shooters[0]),
    part("Suit fabric", iron ? "Nanotech plating that flows over the body." : "Stretch weave with raised web lines.", 2, at(torsoG, 0.16, 0.25, 0.1)),
  ];
  if (iron) parts.push(part("Waldoes", "Four mechanical spider legs for climbing and combat.", 1, at(waldoes[0].seg2, 0, 0, 0)));

  // ─── actions ───
  const state = { squint: false, legs: false };
  const anim = { squint: 0, legs: 0, explode: 0 };
  const target = { red: new THREE.Color(s0.red), blue: new THREE.Color(s0.blue) };
  const actions: ModelAction[] = [{ id: "squint", label: "Lenses", kind: "toggle", words: ["lenses", "lens", "eyes", "squint", "mask"], value: false, parts: eyes }];
  if (iron) actions.push({ id: "legs", label: "Waldoes", kind: "toggle", words: ["legs", "spider legs", "waldoes", "arms", "mechanical legs"], value: false, parts: [emblem, ...waldoes.map((w) => w.root)] });
  if (schemes.length > 1) actions.push({ id: "paint", label: "Paint", kind: "choice", options: schemes.map((s) => s.name), words: ["paint", "colour", "color", "scheme", "suit"], value: s0.name });
  const headHome = headG.position.clone();

  return {
    content,
    parts,
    actions,
    act(id, value) {
      if (id === "paint") {
        const s = schemes.find((x) => x.name === value) ?? s0;
        target.red.set(s.red);
        target.blue.set(s.blue);
        return;
      }
      if (id in state) (state as Record<string, boolean>)[id] = Boolean(value);
    },
    explode(a) {
      anim.explode = a;
      for (const arm of arms) arm.sh.position.copy(arm.home).add(new THREE.Vector3(arm.s * 0.22 * a, 0.02 * a, 0));
      for (const l of legs) l.hip.position.copy(l.home).add(new THREE.Vector3(l.s * 0.06 * a, -0.1 * a, 0));
      headG.position.copy(headHome).add(new THREE.Vector3(0, 0.16 * a, 0));
    },
    update(dt) {
      const k = 1 - Math.exp(-dt * 4);
      anim.squint += ((state.squint ? 1 : 0) - anim.squint) * k * 2;
      anim.legs += ((state.legs ? 1 : 0) - anim.legs) * k * 0.8;
      for (const e of eyes) e.scale.set(1 + 0.04 * anim.squint, 1 - 0.5 * anim.squint, 1);
      // folded flat against the back ↔ the four-legged stance
      const o = anim.legs * anim.legs * (3 - 2 * anim.legs);
      const mix = (a: number, b: number) => a + (b - a) * o;
      for (const w of waldoes) {
        w.root.rotation.set(mix(Math.PI * 0.92, 0.45 + w.tier * 0.35), 0, w.side * mix(0.22, 1.2 + w.tier * 0.4));
        w.seg2.rotation.set(mix(Math.PI * 0.9, 0), 0, w.side * mix(0, -1.15));
        w.seg3.rotation.set(mix(Math.PI * 0.86, 0), 0, w.side * mix(0, -0.5));
      }
      const kc = 1 - Math.exp(-dt * 3);
      for (const m of redMats) m.color.lerp(target.red, kc);
      for (const m of blueMats) m.color.lerp(target.blue, kc);
      void holoGain;
    },
  };
}

const wrap = (b: Built, radius: number): BuiltObject => {
  b.content.position.y = -0.95;
  const g = new THREE.Group();
  g.add(b.content);
  return { content: g, radius, parts: b.parts, actions: b.actions, act: b.act, update: b.update, explode: b.explode };
};

export const buildSpiderClassic = () =>
  wrap(
    buildSpider(false, [
      { name: "Classic", red: 0xb5141e, blue: 0x1c3d93, line: 0x0b0b0d, trim: 0x0b0b0d },
      { name: "Black suit", red: 0x24262b, blue: 0x111215, line: 0x050506, trim: 0xd8dde3 },
      { name: "Stealth", red: 0x4f545c, blue: 0x24282e, line: 0x0b0b0d, trim: 0x0b0b0d },
    ]),
    1.05,
  );

export const buildIronSpider = () =>
  wrap(
    buildSpider(true, [
      { name: "Classic", red: 0xa3141c, blue: 0x15233f, line: 0x0b0b0d, trim: 0xd6a33e },
      { name: "Stealth", red: 0x24272d, blue: 0x101216, line: 0x0b0b0d, trim: 0x8a9099 },
    ]),
    1.05,
  );
