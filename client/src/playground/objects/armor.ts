import * as THREE from "three";
import type { BuiltObject, ModelAction } from "./types";
import { at, centerOf, part, type PartAnchor } from "./parts";
import { holoGain } from "../holo";

/**
 * Procedural armoured suits (ARC's own interpretations, not official assets): one articulated
 * humanoid rig, styled per suit. Interactive — faceplate, repulsors, flight, opening the armour,
 * paint schemes — and every moving piece animates toward its target in update().
 */

const TAU = Math.PI * 2;
type Role = "primary" | "secondary" | "dark" | "glow" | "under" | "lens";

interface Scheme {
  name: string;
  primary: number;
  secondary: number;
}

interface SuitStyle {
  kind: "iron" | "hulk" | "spider" | "ironspider";
  schemes: Scheme[];
  /** Which body regions take the secondary colour. */
  gold: Set<string>;
  glow: number;
  reactor: "round" | "triangle" | "hex";
  bulk: number; // torso width / limb thickness multiplier
  slim?: boolean;
}

const lathe = (pts: [number, number][], seg = 36, phiStart = 0, phiLen = TAU) =>
  new THREE.LatheGeometry(
    pts.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
    phiStart,
    phiLen,
  );

/** Spider-suit web pattern (meridians + rings in lathe UV space). */
function webTexture(base: string, line: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = base;
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = line;
  g.lineWidth = 2.2;
  for (let x = 0; x <= 512; x += 32) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, 512);
    g.stroke();
  }
  for (let y = 18; y < 512; y += 40) {
    g.beginPath();
    for (let x = 0; x <= 512; x += 32) {
      const yy = y + 7 * Math.sin((x / 32) * Math.PI);
      if (x === 0) g.moveTo(x, yy);
      else g.quadraticCurveTo(x - 16, yy + 9, x, yy);
    }
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Spider emblem outline (flat, extruded a hair). */
function spiderEmblem(size: number, mat: THREE.Material): THREE.Mesh {
  const s = new THREE.Shape();
  s.ellipse(0, 0.25, 0.16, 0.22, 0, TAU);
  const body = new THREE.Shape();
  body.absellipse(0, -0.25, 0.2, 0.35, 0, TAU, false, 0);
  const group: THREE.Shape[] = [s, body];
  for (const side of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const leg = new THREE.Shape();
      const y0 = 0.15 - i * 0.18;
      const kx = side * (0.55 + (i % 2) * 0.1);
      const ky = y0 + (i < 2 ? 0.35 : -0.3);
      leg.moveTo(side * 0.1, y0);
      leg.lineTo(kx, ky);
      leg.lineTo(side * (0.9 - i * 0.05), y0 + (i < 2 ? 0.05 : -0.6));
      leg.lineTo(kx + side * 0.05, ky + 0.06);
      leg.lineTo(side * 0.12, y0 + 0.06);
      group.push(leg);
    }
  }
  const geo = new THREE.ExtrudeGeometry(group, { depth: 0.02, bevelEnabled: false });
  geo.scale(size, size, size);
  return new THREE.Mesh(geo, mat);
}

interface Built {
  content: THREE.Group;
  parts: PartAnchor[];
  actions: ModelAction[];
  act(id: string, value: boolean | string): void;
  update(dt: number, t: number): void;
  explode(a: number): void;
}

function buildRig(style: SuitStyle): Built {
  const B = style.bulk;
  const spider = style.kind === "spider" || style.kind === "ironspider";
  const scheme0 = style.schemes[0];

  // ─── materials ───
  const cloth = style.kind === "spider";
  const webRed = cloth ? webTexture("#b3121c", "rgba(40,4,8,0.85)") : null;
  const mats: Record<Role, THREE.Material> = {
    primary: cloth
      ? new THREE.MeshStandardMaterial({ color: 0xffffff, map: webRed, roughness: 0.62, metalness: 0.05 })
      : new THREE.MeshPhysicalMaterial({ color: scheme0.primary, metalness: 0.62, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12 }),
    secondary: cloth
      ? new THREE.MeshStandardMaterial({ color: scheme0.secondary, roughness: 0.7, metalness: 0.05 })
      : new THREE.MeshPhysicalMaterial({ color: scheme0.secondary, metalness: 1, roughness: 0.24, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x23272d, metalness: 0.85, roughness: 0.42 }),
    under: new THREE.MeshStandardMaterial({ color: 0x15181c, metalness: 0.5, roughness: 0.7 }),
    glow: new THREE.MeshBasicMaterial({ color: style.glow, toneMapped: false }),
    lens: new THREE.MeshStandardMaterial({ color: 0xf2f6fa, emissive: 0x8a9aa8, emissiveIntensity: 0.35, roughness: 0.2, metalness: 0.3 }),
  };
  const glowMat = mats.glow as THREE.MeshBasicMaterial;
  const glowBase = new THREE.Color(style.glow);
  const mesh = (geo: THREE.BufferGeometry, role: Role, parent: THREE.Object3D) => {
    const m = new THREE.Mesh(geo, mats[role]);
    m.castShadow = role !== "glow";
    m.receiveShadow = role !== "glow";
    parent.add(m);
    return m;
  };
  const roleOf = (region: string): Role => (style.gold.has(region) ? "secondary" : "primary");

  const content = new THREE.Group();
  const body = new THREE.Group(); // lifts in flight mode
  content.add(body);
  const shells: { obj: THREE.Object3D; home: THREE.Vector3; out: THREE.Vector3 }[] = [];
  const shell = (obj: THREE.Object3D, out: [number, number, number]) => shells.push({ obj, home: obj.position.clone(), out: new THREE.Vector3(...out) });

  // ─── torso ───
  const torso = new THREE.Group();
  body.add(torso);
  const torsoPts: [number, number][] = [[0.001, 0.93], [0.13, 0.94], [0.145, 1.01], [0.138, 1.1], [0.152, 1.2], [0.198, 1.31], [0.212, 1.39], [0.198, 1.46], [0.13, 1.5], [0.05, 1.52]];
  const tx = (spider ? 1.06 : 1.22) * B;
  const tz = (spider ? 0.64 : 0.74) * (style.kind === "hulk" ? 1.35 : 1);
  const back = mesh(lathe(torsoPts, 44), cloth ? "primary" : roleOf("torso"), torso);
  back.scale.set(tx, 1, tz);
  // inner undersuit (visible when the armour opens)
  if (!spider) mesh(lathe(torsoPts.map(([r, y]) => [r * 0.93, y]), 32), "under", torso).scale.set(tx, 1, tz);
  // front chest plate (opens forward)
  const chestPlate = new THREE.Group();
  torso.add(chestPlate);
  if (!cloth) {
    const cp = mesh(lathe(torsoPts.slice(3, 9).map(([r, y]) => [r * 1.03, y]), 40, -1.15, 2.3), roleOf("chest"), chestPlate);
    cp.scale.set(tx, 1, tz);
    shell(chestPlate, [0, 0.04, 0.22]);
    // abdominal bands
    for (let i = 0; i < 3; i++) {
      const y0 = 0.97 + i * 0.065;
      const band = mesh(lathe([[0.15, y0], [0.153, y0 + 0.028], [0.148, y0 + 0.05]], 36, -1.3, 2.6), roleOf("abs"), torso);
      band.scale.set(tx * 1.02, 1, tz * 1.05);
    }
    // seams
    for (const y of [1.2, 1.46]) {
      const seam = new THREE.Mesh(new THREE.TorusGeometry(y === 1.2 ? 0.155 : 0.2, 0.0035, 6, 64), mats.dark);
      seam.rotation.x = Math.PI / 2;
      seam.position.y = y;
      seam.scale.set(tx, tz, 1);
      torso.add(seam);
    }
  } else {
    // spider suit: blue sides/abdomen
    const abs = mesh(lathe(torsoPts.slice(0, 5).map(([r, y]) => [r * 1.01, y]), 36), "secondary", torso);
    abs.scale.set(tx, 1, tz);
  }
  // pelvis
  const pelvis = mesh(lathe([[0.001, 0.84], [0.12, 0.85], [0.15, 0.9], [0.148, 0.97]], 36), spider ? "secondary" : roleOf("pelvis"), torso);
  pelvis.scale.set(tx * 0.95, 1, tz * 1.05);

  // ─── chest emblem: arc reactor or spider ───
  const reactorPos = new THREE.Vector3(0, 1.33, 0.218 * tz); // just proud of the chest plate
  let reactorLight: THREE.PointLight | null = null;
  let reactorGlow: THREE.Mesh | null = null;
  let emblem: THREE.Object3D | null = null;
  if (style.kind === "iron" || style.kind === "hulk") {
    const r = new THREE.Group();
    r.position.copy(reactorPos);
    chestPlate.add(r);
    const size = style.kind === "hulk" ? 1.5 : 1;
    if (style.reactor === "round") {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.042 * size, 0.009 * size, 10, 48), mats.dark);
      r.add(ring);
      reactorGlow = new THREE.Mesh(new THREE.CircleGeometry(0.034 * size, 40), mats.glow);
    } else {
      const sides = style.reactor === "triangle" ? 3 : 6;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.046 * size, 0.008 * size, 6, sides), mats.dark);
      ring.rotation.z = style.reactor === "triangle" ? -Math.PI / 2 : 0;
      r.add(ring);
      reactorGlow = new THREE.Mesh(new THREE.CircleGeometry(0.038 * size, sides), mats.glow);
      reactorGlow.rotation.z = ring.rotation.z;
    }
    reactorGlow.position.z = 0.004;
    r.add(reactorGlow);
    reactorLight = new THREE.PointLight(style.glow, 0.5, 0.7, 2);
    reactorLight.position.z = 0.05;
    r.add(reactorLight);
    emblem = r;
  } else {
    const em = spiderEmblem(style.kind === "ironspider" ? 0.1 : 0.075, style.kind === "ironspider" ? mats.secondary : new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.5 }));
    em.position.set(0, 1.33, 0.205 * tz * 0.99);
    em.rotation.x = -0.12;
    torso.add(em);
    emblem = em;
  }

  // ─── neck + head ───
  mesh(new THREE.CylinderGeometry(0.055, 0.062, 0.09, 24), spider ? "primary" : "dark", torso).position.y = 1.53;
  const head = new THREE.Group();
  head.position.set(0, 1.62, 0.01);
  const hs = style.kind === "hulk" ? 1.05 : 1;
  head.scale.setScalar(hs);
  body.add(head);
  const helmetPts: [number, number][] = [[0.001, -0.065], [0.07, -0.055], [0.098, 0.0], [0.108, 0.06], [0.1, 0.12], [0.07, 0.165], [0.001, 0.182]];
  const helmet = mesh(lathe(helmetPts, 44), cloth ? "primary" : roleOf("helmet"), head);
  helmet.scale.z = 1.12;
  const faceInner = mesh(lathe(helmetPts.map(([r, y]) => [r * 0.92, y]), 32), "under", head);
  faceInner.scale.z = 1.1;

  // Faceplate on a hinge at the crown (Iron Man suits); spider masks have lenses instead.
  const faceHinge = new THREE.Group();
  faceHinge.position.set(0, 0.13, 0.03);
  head.add(faceHinge);
  const eyes: THREE.Mesh[] = [];
  if (!spider) {
    const fp = mesh(lathe(helmetPts.slice(0, 6).map(([r, y]) => [r * 1.035, y]), 40, -1.05, 2.1), roleOf("faceplate"), faceHinge);
    fp.scale.z = 1.12;
    fp.position.set(0, -0.13, -0.03);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.009, 0.006), mats.glow);
      eye.position.set(side * 0.032, -0.1, 0.093);
      eye.rotation.set(0, side * 0.32, side * -0.18);
      faceHinge.add(eye);
      eyes.push(eye);
    }
    // mouth slit
    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.0025, 0.004), mats.dark);
    mouth.position.set(0, -0.17, 0.062);
    faceHinge.add(mouth);
  } else {
    for (const side of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.CircleGeometry(0.03, 32), mats.lens);
      lens.scale.set(1.2, 0.72, 1);
      lens.position.set(side * 0.04, 0.035, 0.112);
      lens.rotation.set(0, side * 0.45, side * -0.5);
      const rim = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.036, 32), new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.5, side: THREE.DoubleSide }));
      rim.position.z = -0.001;
      lens.add(rim);
      head.add(lens);
      eyes.push(lens);
    }
  }

  // ─── shoulders + arms ───
  const arms: { shoulder: THREE.Group; elbow: THREE.Group; hand: THREE.Group; palm: THREE.Mesh | null; side: number }[] = [];
  const AR = (spider ? 0.85 : 1) * (style.kind === "hulk" ? 1.9 : 1);
  for (const side of [-1, 1]) {
    if (!spider) {
      const pd = mesh(new THREE.SphereGeometry(0.088 * AR, 28, 18), roleOf("shoulders"), torso);
      pd.scale.set(1.15, 0.85, 1);
      pd.position.set(side * (0.255 * tx * 0.86), 1.43, 0);
      shell(pd, [side * 0.12, 0.05, 0]);
    }
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.27 * tx * 0.86, 1.4, 0);
    shoulder.rotation.z = side * 0.13;
    body.add(shoulder);
    const ua = mesh(lathe([[0.001, 0.02], [0.068 * AR, 0], [0.074 * AR, -0.05], [0.066 * AR, -0.2], [0.058 * AR, -0.27], [0.001, -0.3]], 28), cloth ? "primary" : roleOf("upperArms"), shoulder);
    if (!spider) {
      mesh(lathe([[0.06 * AR, 0], [0.06 * AR, -0.28]], 20), "under", shoulder);
      shell(ua, [side * 0.07, 0, 0]);
    }
    const elbow = new THREE.Group();
    elbow.position.y = -0.29;
    shoulder.add(elbow);
    mesh(new THREE.SphereGeometry(0.052 * AR, 20, 14), spider ? "primary" : "dark", elbow);
    const fa = mesh(lathe([[0.001, 0.01], [0.055 * AR, 0], [0.064 * AR, -0.06], [0.06 * AR, -0.18], [0.047 * AR, -0.26], [0.001, -0.27]], 28), cloth ? "primary" : roleOf("forearms"), elbow);
    if (!spider) {
      mesh(lathe([[0.048 * AR, 0], [0.042 * AR, -0.26]], 20), "under", elbow);
      shell(fa, [side * 0.07, 0, 0.02]);
      const cuff = mesh(lathe([[0.05 * AR, -0.2], [0.053 * AR, -0.215], [0.05 * AR, -0.23]], 28), roleOf("cuffs"), elbow);
      cuff.position.y = 0;
    } else {
      // web-shooter
      const ws = mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.04, 16), style.kind === "ironspider" ? "secondary" : "dark", elbow);
      ws.position.set(0, -0.22, 0.03);
      ws.rotation.x = Math.PI / 2;
    }
    const hand = new THREE.Group();
    hand.position.y = -0.275;
    elbow.add(hand);
    const HS = style.kind === "hulk" ? 2.1 : 1;
    const palmBox = mesh(new THREE.BoxGeometry(0.035 * HS, 0.085 * HS, 0.075 * HS), cloth ? "primary" : roleOf("hands"), hand);
    palmBox.position.y = -0.045 * HS;
    for (let f = 0; f < 4; f++) {
      const finger = mesh(new THREE.BoxGeometry(0.018 * HS, 0.07 * HS, 0.016 * HS), cloth ? "primary" : "dark", hand);
      finger.position.set(0, -0.12 * HS, (f - 1.5) * 0.019 * HS);
      finger.rotation.z = side * -0.15;
    }
    let palm: THREE.Mesh | null = null;
    if (!spider) {
      palm = new THREE.Mesh(new THREE.CircleGeometry(0.019 * HS, 24), mats.glow);
      palm.position.set(side * -0.0185 * HS, -0.05 * HS, 0);
      palm.rotation.y = side * -Math.PI / 2;
      hand.add(palm);
    }
    arms.push({ shoulder, elbow, hand, palm, side });
  }

  // ─── legs ───
  const LR = (spider ? 0.88 : 1) * (style.kind === "hulk" ? 1.75 : 1);
  const boots: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(side * 0.1 * B, 0.9, 0);
    body.add(hip);
    const th = mesh(lathe([[0.001, 0.02], [0.084 * LR, 0], [0.09 * LR, -0.06], [0.078 * LR, -0.3], [0.062 * LR, -0.39], [0.001, -0.41]], 28), spider ? "secondary" : roleOf("thighs"), hip);
    if (!spider) {
      mesh(lathe([[0.075 * LR, 0], [0.058 * LR, -0.4]], 20), "under", hip);
      shell(th, [side * 0.05, 0, 0.06]);
    }
    const knee = new THREE.Group();
    knee.position.y = -0.41;
    hip.add(knee);
    mesh(new THREE.SphereGeometry(0.056 * LR, 20, 14), spider ? "secondary" : roleOf("knees"), knee).position.z = 0.012;
    const sh = mesh(lathe([[0.001, 0.01], [0.06 * LR, 0], [0.066 * LR, -0.08], [0.058 * LR, -0.3], [0.05 * LR, -0.38], [0.001, -0.4]], 28), cloth ? "primary" : roleOf("shins"), knee);
    if (!spider) shell(sh, [side * 0.04, 0, 0.06]);
    const boot = mesh(new THREE.BoxGeometry(0.1 * LR, 0.08, 0.21 * LR), cloth ? "primary" : roleOf("boots"), knee);
    boot.position.set(0, -0.43, 0.04 * LR);
    boots.push(boot);
    if (!spider) {
      const thr = new THREE.Mesh(new THREE.CircleGeometry(0.03 * LR, 24), mats.glow);
      thr.rotation.x = Math.PI / 2;
      thr.position.set(0, -0.472, 0.0);
      thr.visible = false;
      knee.add(thr);
      boots.push(thr);
    }
  }

  // ─── Iron Spider waldoes (4 mechanical legs from the back) ───
  const waldoes: { root: THREE.Group; seg2: THREE.Group; seg3: THREE.Group; side: number; tier: number }[] = [];
  if (style.kind === "ironspider") {
    for (const side of [-1, 1]) {
      for (const tier of [0, 1]) {
        const root = new THREE.Group();
        root.position.set(side * 0.07, 1.28 - tier * 0.12, -0.12);
        torso.add(root);
        const segGeo = new THREE.CylinderGeometry(0.012, 0.009, 0.3, 10);
        segGeo.translate(0, -0.15, 0);
        mesh(segGeo, "secondary", root);
        const seg2 = new THREE.Group();
        seg2.position.y = -0.3;
        root.add(seg2);
        mesh(new THREE.SphereGeometry(0.016, 12, 8), "dark", seg2);
        mesh(segGeo.clone(), "secondary", seg2);
        const seg3 = new THREE.Group();
        seg3.position.y = -0.3;
        seg2.add(seg3);
        const tip = new THREE.ConeGeometry(0.011, 0.24, 10);
        tip.translate(0, -0.12, 0);
        mesh(tip, "secondary", seg3);
        waldoes.push({ root, seg2, seg3, side, tier });
      }
    }
  }

  content.scale.setScalar(style.kind === "hulk" ? 1.28 : 1);

  // ─── parts (labels) ───
  const parts: PartAnchor[] = [];
  if (!spider) {
    parts.push(part("Helmet & faceplate", "Hinged faceplate with HUD optics; lifts to reveal the face.", 1, at(faceHinge, 0, -0.05, 0.11), faceHinge));
    parts.push(part("Arc reactor", "Chest power source feeding every system in the suit.", 1, at(emblem!, 0, 0, 0.02)));
    parts.push(part("Repulsors", "Palm emitters for flight stabilisation and weapons.", 1, at(arms[1].hand, 0, -0.05, 0)));
    parts.push(part("Chest plate", "Primary armour over the reactor and vital systems.", 2, centerOf(chestPlate, 0.2), chestPlate));
    parts.push(part("Pauldrons", "Shoulder armour that covers the arm actuators.", 2, at(arms[0].shoulder, 0, 0.05, 0)));
    parts.push(part("Gauntlets", "Forearm housings for weapons and micro-servos.", 2, at(arms[0].elbow, 0, -0.14, 0.06)));
    parts.push(part("Boot thrusters", "Main flight thrusters in the soles.", 1, at(boots[0], 0, -0.03, 0.06)));
    parts.push(part("Knee actuators", "Load-bearing joints that absorb landings.", 2, at(boots[0].parent!, 0, 0, 0.06)));
  } else {
    parts.push(part("Mask lenses", "Shutter lenses that widen and narrow like eyes.", 1, at(eyes[1], 0, 0, 0.01)));
    parts.push(part("Spider emblem", style.kind === "ironspider" ? "Gold insignia; the legs deploy from behind it." : "The chest insignia.", 1, at(emblem!, 0, 0.02, 0.02)));
    parts.push(part("Web-shooters", "Wrist launchers for synthetic web fluid.", 1, at(arms[1].elbow, 0, -0.22, 0.05)));
    if (style.kind === "ironspider") parts.push(part("Waldoes", "Four mechanical spider legs for climbing and combat.", 1, at(waldoes[0].seg2, 0, 0, 0)));
    parts.push(part("Suit fabric", cloth ? "Stretch weave with raised web lines." : "Nanotech armour plating.", 2, at(torso, 0.14, 1.1, 0.1)));
  }

  // ─── actions ───
  const state = { faceplate: false, repulsors: false, flight: false, armor: false, legs: false, squint: false, paint: scheme0.name };
  const anim = { face: 0, rep: 0, fly: 0, open: 0, explode: 0, legs: 0, squint: 0 };
  const target = { primary: new THREE.Color(scheme0.primary), secondary: new THREE.Color(scheme0.secondary) };
  const actions: ModelAction[] = [];
  if (!spider) {
    actions.push({ id: "faceplate", label: "Faceplate", kind: "toggle", words: ["faceplate", "face plate", "helmet", "mask", "visor"], value: false, parts: [faceHinge] });
    actions.push({ id: "repulsors", label: "Repulsors", kind: "toggle", words: ["repulsor", "repulsors", "hands", "palms", "weapons"], value: false, parts: arms.map((a) => a.hand) });
    actions.push({ id: "flight", label: "Flight mode", kind: "toggle", words: ["flight", "fly", "thrusters", "hover", "take off"], value: false, parts: boots });
    actions.push({ id: "armor", label: "Armor", kind: "toggle", words: ["armor", "armour", "suit", "plates", "chest"], value: false, parts: [chestPlate] });
  } else {
    actions.push({ id: "squint", label: "Lenses", kind: "toggle", words: ["lenses", "lens", "eyes", "squint", "mask"], value: false, parts: eyes });
    if (style.kind === "ironspider") actions.push({ id: "legs", label: "Waldoes", kind: "toggle", words: ["legs", "spider legs", "waldoes", "arms", "mechanical legs"], value: false, parts: [emblem!, ...waldoes.map((w) => w.root)] });
  }
  if (style.schemes.length > 1) actions.push({ id: "paint", label: "Paint", kind: "choice", options: style.schemes.map((s) => s.name), words: ["paint", "colour", "color", "scheme", "finish"], value: scheme0.name });

  const act = (id: string, value: boolean | string) => {
    if (id === "paint") {
      const s = style.schemes.find((x) => x.name === value) ?? scheme0;
      state.paint = s.name;
      target.primary.set(s.primary);
      target.secondary.set(s.secondary);
      return;
    }
    if (id in state) (state as Record<string, boolean | string>)[id] = value;
  };

  const apply = () => {
    for (const s of shells) s.obj.position.copy(s.home).addScaledVector(s.out, Math.max(anim.open * 0.9, anim.explode * 1.6));
  };
  const step = (k: number, v: number, to: number) => v + (to - v) * k;

  return {
    content,
    parts,
    actions,
    act,
    explode(a) {
      anim.explode = a;
      apply();
    },
    update(dt, t) {
      const k = 1 - Math.exp(-dt * 4);
      anim.face = step(k, anim.face, state.faceplate ? 1 : 0);
      anim.rep = step(k, anim.rep, state.repulsors ? 1 : 0);
      anim.fly = step(k * 0.7, anim.fly, state.flight ? 1 : 0);
      anim.open = step(k, anim.open, state.armor ? 1 : 0);
      anim.legs = step(k * 0.8, anim.legs, state.legs ? 1 : 0);
      anim.squint = step(k * 2, anim.squint, state.squint ? 1 : 0);
      faceHinge.rotation.x = -1.35 * anim.face;
      // repulsors: forearms come up, palms face forward; flight: arms back, body rises
      for (const a of arms) {
        a.shoulder.rotation.x = -0.25 * anim.rep + 0.35 * anim.fly;
        a.shoulder.rotation.z = a.side * (0.13 + 0.12 * anim.fly);
        a.elbow.rotation.x = -1.35 * anim.rep * (1 - anim.fly);
        a.hand.rotation.z = a.side * 1.45 * anim.rep * (1 - anim.fly);
        a.hand.rotation.x = 0.6 * anim.fly;
      }
      body.position.y = anim.fly * (0.18 + Math.sin(t * 2.2) * 0.02);
      for (const b of boots) if (b.material === mats.glow) b.visible = anim.fly > 0.05;
      const pulse = 0.85 + 0.15 * Math.sin(t * 3);
      const g = holoGain.value; // brightness control
      glowMat.color.copy(glowBase).multiplyScalar(pulse * g * (1 + anim.rep * 0.8 + anim.fly * 0.5));
      if (reactorLight) reactorLight.intensity = (0.4 + 0.5 * anim.rep + 0.2 * Math.sin(t * 3)) * g;
      for (const e of eyes) if (spider) e.scale.y = 0.72 * (1 - anim.squint * 0.55);
      for (const w of waldoes) {
        const out = anim.legs;
        w.root.rotation.z = w.side * (0.2 + 1.2 * out);
        w.root.rotation.x = 0.35 + (w.tier ? 0.55 : -0.25) * out;
        w.seg2.rotation.z = w.side * (-2.4 + 1.4 * out);
        w.seg3.rotation.z = w.side * (0.9 - 0.4 * out);
      }
      if (anim.open > 0.001 || anim.explode > 0.001) apply();
      // paint fades between schemes
      const kc = 1 - Math.exp(-dt * 3);
      if (!cloth) {
        (mats.primary as THREE.MeshPhysicalMaterial).color.lerp(target.primary, kc);
        (mats.secondary as THREE.MeshPhysicalMaterial).color.lerp(target.secondary, kc);
      } else {
        (mats.primary as THREE.MeshStandardMaterial).color.lerp(target.primary, kc);
        (mats.secondary as THREE.MeshStandardMaterial).color.lerp(target.secondary, kc);
      }
    },
  };
}

const IRON_SCHEMES = (main: Scheme): Scheme[] => [
  main,
  { name: "Stealth", primary: 0x2a2e35, secondary: 0x5d646d },
  { name: "Gold", primary: 0xb98a2e, secondary: 0xe0b85a },
  { name: "Silver", primary: 0xaab1b9, secondary: 0x737a83 },
];

const wrap = (b: Built, radius: number): BuiltObject => {
  // stand on the floor: content origin at the feet → centre it
  b.content.position.y = -0.95 * b.content.scale.y;
  const g = new THREE.Group();
  g.add(b.content);
  return { content: g, radius, parts: b.parts, actions: b.actions, act: b.act, update: b.update, explode: b.explode };
};

export const buildMark3 = () =>
  wrap(buildRig({ kind: "iron", schemes: IRON_SCHEMES({ name: "Classic", primary: 0x9e1219, secondary: 0xd9a441 }), gold: new Set(["faceplate", "abs", "upperArms", "thighs", "cuffs"]), glow: 0xcdf3ff, reactor: "round", bulk: 1 }), 1.05);

export const buildMark42 = () =>
  wrap(buildRig({ kind: "iron", schemes: IRON_SCHEMES({ name: "Classic", primary: 0x8f1319, secondary: 0xd7a43c }), gold: new Set(["faceplate", "chest", "upperArms", "forearms", "thighs", "shins", "hands", "knees"]), glow: 0xd2f5ff, reactor: "round", bulk: 1 }), 1.05);

export const buildMark50 = () =>
  wrap(buildRig({ kind: "iron", schemes: IRON_SCHEMES({ name: "Nanotech", primary: 0x6e0b11, secondary: 0xc9963a }), gold: new Set(["faceplate", "abs", "cuffs", "knees", "hands"]), glow: 0xbff0ff, reactor: "hex", bulk: 0.96 }), 1.05);

export const buildMark85 = () =>
  wrap(buildRig({ kind: "iron", schemes: IRON_SCHEMES({ name: "Classic", primary: 0x8a1016, secondary: 0xd8a948 }), gold: new Set(["faceplate", "abs", "upperArms", "forearms", "thighs", "knees", "pelvis", "shoulders"]), glow: 0xd6f6ff, reactor: "triangle", bulk: 1.02 }), 1.05);

export const buildHulkbuster = () =>
  wrap(buildRig({ kind: "hulk", schemes: IRON_SCHEMES({ name: "Classic", primary: 0x9a1418, secondary: 0xd4a531 }), gold: new Set(["faceplate", "abs", "forearms", "shins", "knees", "cuffs"]), glow: 0xcff4ff, reactor: "round", bulk: 1.75 }), 1.45);

export const buildSpiderClassic = () =>
  wrap(buildRig({ kind: "spider", schemes: [{ name: "Classic", primary: 0xffffff, secondary: 0x1b3f9e }, { name: "Black suit", primary: 0x2b2d33, secondary: 0x0d0e11 }, { name: "Stealth", primary: 0x5b6068, secondary: 0x22262c }], gold: new Set(), glow: 0xffffff, reactor: "round", bulk: 1, slim: true }), 1.05);

export const buildIronSpider = () =>
  wrap(buildRig({ kind: "ironspider", schemes: [{ name: "Classic", primary: 0xa3141c, secondary: 0xd6a33e }, { name: "Stealth", primary: 0x24272d, secondary: 0x8a9099 }], gold: new Set(["cuffs", "knees"]), glow: 0xffffff, reactor: "round", bulk: 1, slim: true }), 1.05);
