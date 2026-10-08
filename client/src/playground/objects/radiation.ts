import * as THREE from "three";
import type { BuiltObject, ModelAction } from "./types";
import { part } from "./parts";
import { holoGain, holoMaterial } from "../holo";
import { beamMaterial, flash, glowLineMaterial, glowPoints, HotMaterial, marker, photonGeometry, PhotonPool, rng } from "./fx";

/**
 * Radiation and light, animated: an X-ray machine imaging a hand, radioactive decay against
 * paper / aluminium / lead, a photon as an electromagnetic wave across the spectrum, and a
 * ruby laser. ARC's own procedural models; they play continuously.
 */

const TAU = Math.PI * 2;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** Lathe (profile = [radius, along]) turned so its axis runs along +x. */
function latheX(profile: [number, number][], seg = 48): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
  );
  g.rotateZ(-Math.PI / 2);
  return g;
}

/** Capsule between two points. */
function capsule(a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material, radial = 10): THREE.Mesh {
  const d = b.clone().sub(a);
  const len = d.length();
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.0001, len), 4, radial), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(V(0, 1, 0), d.normalize());
  return m;
}

/** Canvas text label lying on the floor (for the shields). */
function floorLabel(text: string, w = 0.36): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(160,220,255,0.95)";
  g.font = "600 34px Rajdhani, sans-serif";
  g.textAlign = "center";
  g.fillText(text, 128, 44);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, toneMapped: false }));
  m.rotation.x = -Math.PI / 2;
  m.userData.noPick = true;
  m.userData.keepMaterial = true;
  return m;
}

const wrap = (content: THREE.Group, radius: number, extra: Omit<BuiltObject, "content" | "radius">): BuiltObject => {
  const g = new THREE.Group();
  g.add(content);
  return { content: g, radius, ...extra };
};

// ─────────────────────────────────────────────────────────────────────────────
// X-ray machine
// ─────────────────────────────────────────────────────────────────────────────

interface Bone {
  a: THREE.Vector3;
  b: THREE.Vector3;
  r: number;
}

/** A hand lying palm-down (fingers toward −z): bones + the skin around them. */
function handLayout(): { bones: Bone[]; carpals: THREE.Vector3[]; skin: Bone[] } {
  const bones: Bone[] = [];
  const skin: Bone[] = [];
  // forearm: ulna (−x) and radius (+x)
  bones.push({ a: V(-0.03, 0, 0.17), b: V(-0.04, 0, 0.5), r: 0.014 });
  bones.push({ a: V(0.026, 0, 0.165), b: V(0.04, 0, 0.5), r: 0.017 });
  skin.push({ a: V(0, 0, 0.16), b: V(0, 0, 0.52), r: 0.05 });
  const carpals = [V(-0.03, 0, 0.13), V(-0.01, 0, 0.135), V(0.012, 0, 0.135), V(0.032, 0, 0.13), V(-0.028, 0, 0.105), V(-0.008, 0, 0.11), V(0.014, 0, 0.11), V(0.034, 0, 0.1)];
  // fingers: index (+x side) … little finger (−x); [x at the knuckle, metacarpal length, phalanges, fan angle]
  const fingers: [number, number, number[], number][] = [
    [0.036, 0.075, [0.044, 0.026, 0.02], -0.1],
    [0.012, 0.078, [0.048, 0.03, 0.021], -0.02],
    [-0.012, 0.072, [0.045, 0.028, 0.02], 0.07],
    [-0.035, 0.064, [0.036, 0.021, 0.018], 0.17],
  ];
  for (const [x, meta, phal, fan] of fingers) {
    const base = V(x * 0.8, 0, 0.098);
    const dir = V(Math.sin(fan), 0, -Math.cos(fan));
    const knuckle = base.clone().addScaledVector(dir, meta);
    bones.push({ a: base, b: knuckle, r: 0.0085 });
    let p = knuckle.clone().addScaledVector(dir, 0.006);
    phal.forEach((len, i) => {
      const q = p.clone().addScaledVector(dir, len);
      bones.push({ a: p.clone(), b: q.clone(), r: 0.0075 - i * 0.0012 });
      p = q.addScaledVector(dir, 0.004);
    });
    skin.push({ a: knuckle.clone().addScaledVector(dir, -0.01), b: p.clone(), r: 0.0125 });
  }
  // thumb
  const tBase = V(0.05, 0, 0.11);
  const tDir = V(0.62, 0, -0.78).normalize();
  const tKnuckle = tBase.clone().addScaledVector(tDir, 0.05);
  bones.push({ a: tBase, b: tKnuckle, r: 0.0095 });
  const tMid = tKnuckle.clone().addScaledVector(tDir, 0.036);
  bones.push({ a: tKnuckle.clone().addScaledVector(tDir, 0.005), b: tMid, r: 0.0085 });
  const tTip = tMid.clone().addScaledVector(tDir, 0.03);
  bones.push({ a: tMid.clone().addScaledVector(tDir, 0.004), b: tTip, r: 0.0072 });
  skin.push({ a: tBase.clone().addScaledVector(tDir, 0.02), b: tTip.clone().addScaledVector(tDir, 0.008), r: 0.015 });
  return { bones, carpals, skin };
}

/** The radiograph: bones white (they stop X-rays), soft tissue grey only at low voltage. */
function radiograph(bones: Bone[], carpals: THREE.Vector3[], skin: Bone[], kv: "60 kV" | "120 kV"): THREE.CanvasTexture {
  const W = 640;
  const H = 460;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const bg = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.7);
  bg.addColorStop(0, "#152434");
  bg.addColorStop(1, "#04080e");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // hand coords → image: fingers point up
  const S = 1500;
  const P = (v: THREE.Vector3): [number, number] => [W / 2 + v.x * S, H * 0.46 + (v.z - 0.02) * S];
  const stroke = (a: THREE.Vector3, b: THREE.Vector3, w: number, col: string, blur = 0) => {
    g.strokeStyle = col;
    g.lineWidth = w;
    g.lineCap = "round";
    g.shadowColor = col;
    g.shadowBlur = blur;
    g.beginPath();
    g.moveTo(...P(a));
    g.lineTo(...P(b));
    g.stroke();
    g.shadowBlur = 0;
  };
  if (kv === "60 kV") for (const s of skin) stroke(s.a, s.b, s.r * 2 * S, "rgba(120,146,166,0.42)", 18);
  for (const b of bones) {
    stroke(b.a, b.b, b.r * 2 * S, "rgba(238,244,250,0.95)", 10);
    stroke(b.a, b.b, b.r * 0.9 * S, kv === "60 kV" ? "rgba(170,186,200,0.8)" : "rgba(200,214,226,0.85)");
  }
  for (const p of carpals) {
    const [x, y] = P(p);
    g.fillStyle = "rgba(236,242,248,0.92)";
    g.shadowColor = "rgba(236,242,248,0.9)";
    g.shadowBlur = 8;
    g.beginPath();
    g.arc(x, y, 0.0115 * S, 0, TAU);
    g.fill();
    g.shadowBlur = 0;
  }
  g.fillStyle = "rgba(160,220,255,0.85)";
  g.font = "600 20px Rajdhani, sans-serif";
  g.fillText("ARC · RADIOGRAPHY", 18, 30);
  g.fillText(`${kv} · 2.5 mAs`, 18, H - 18);
  g.font = "700 34px Rajdhani, sans-serif";
  g.fillText("L", W - 44, 46);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildXRayMachine(): BuiltObject {
  const R = rng(7);
  const content = new THREE.Group();
  const cream = new THREE.MeshStandardMaterial({ color: 0xaeb5bd, metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide });
  const steel = new THREE.MeshStandardMaterial({ color: 0xa9b1ba, metalness: 1, roughness: 0.28 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x262b32, metalness: 0.8, roughness: 0.42 });
  const copper = new THREE.MeshStandardMaterial({ color: 0xc27a45, metalness: 1, roughness: 0.32 });
  const tungsten = new THREE.MeshStandardMaterial({ color: 0x8f969e, metalness: 1, roughness: 0.2 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xd6ecff, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.2, clearcoat: 1, depthWrite: false, side: THREE.DoubleSide });

  // ── tube head (axis along x), housing cut open at the front ──
  const head = new THREE.Group();
  head.position.set(0.1, 0.72, 0);
  content.add(head);
  const housingGeo = new THREE.CylinderGeometry(0.29, 0.29, 1.46, 64, 1, true, Math.PI * 0.25, Math.PI * 1.5);
  housingGeo.rotateZ(Math.PI / 2);
  const housing = new THREE.Mesh(housingGeo, cream);
  head.add(housing);
  for (const sx of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.CircleGeometry(0.29, 64), cream);
    cap.rotation.y = (sx * Math.PI) / 2;
    cap.position.x = sx * 0.73;
    head.add(cap);
  }
  const insert = new THREE.Mesh(
    latheX([
      [0.001, -0.6],
      [0.07, -0.6],
      [0.11, -0.54],
      [0.12, -0.3],
      [0.19, -0.14],
      [0.215, 0.04],
      [0.19, 0.2],
      [0.13, 0.34],
      [0.115, 0.58],
      [0.06, 0.64],
      [0.001, 0.64],
    ]),
    glass,
  );
  insert.userData.noPick = true;
  head.add(insert);

  // cathode: focusing cup + glowing tungsten filament
  const beamY = -0.14;
  const cathode = new THREE.Group();
  cathode.position.set(-0.4, beamY, 0);
  head.add(cathode);
  cathode.add(
    new THREE.Mesh(
      latheX([
        [0.001, -0.05],
        [0.06, -0.05],
        [0.066, 0.02],
        [0.046, 0.025],
        [0.042, -0.012],
        [0.001, -0.012],
      ]),
      steel,
    ),
  );
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.25, 16), dark);
  stem.rotation.z = Math.PI / 2;
  stem.position.x = -0.17;
  cathode.add(stem);
  class Helix extends THREE.Curve<THREE.Vector3> {
    constructor() {
      super();
    }
    getPoint(t: number, out = new THREE.Vector3()) {
      const a = t * TAU * 7;
      return out.set(0.014 + 0.006 * Math.cos(a), 0.006 * Math.sin(a), -0.024 + 0.048 * t);
    }
  }
  const filamentMat = new HotMaterial(0xffa85a);
  const filament = new THREE.Mesh(new THREE.TubeGeometry(new Helix(), 160, 0.0018, 5, false), filamentMat);
  filament.userData.keepMaterial = true;
  cathode.add(filament);

  // rotating tungsten anode on its induction rotor
  const anode = new THREE.Group();
  anode.position.set(0.36, 0, 0);
  head.add(anode);
  const anodeSpin = new THREE.Group();
  anode.add(anodeSpin);
  const disk = new THREE.Mesh(
    latheX(
      [
        [0.028, -0.026],
        [0.13, -0.026],
        [0.162, 0.0],
        [0.152, 0.014],
        [0.028, 0.018],
      ],
      64,
    ),
    tungsten,
  );
  anodeSpin.add(disk);
  for (let i = 0; i < 12; i++) {
    // radial slots so you can see it spin
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.05, 0.008), dark);
    const a = (i / 12) * TAU;
    slot.position.set(0.019, Math.cos(a) * 0.08, Math.sin(a) * 0.08);
    slot.rotation.x = -a;
    anodeSpin.add(slot);
  }
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.3, 20), steel);
  shaft.rotation.z = Math.PI / 2;
  shaft.position.x = 0.16;
  anode.add(shaft);
  const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.062, 0.16, 32), copper);
  rotor.rotation.z = Math.PI / 2;
  rotor.position.x = 0.23;
  anode.add(rotor);

  // focal spot where the electrons hit (it glows white-hot)
  const focalLocal = V(0.348, beamY, 0);
  const focal = flash(0xffd7a0, 0.16);
  focal.position.copy(focalLocal);
  head.add(focal);

  // beryllium window and collimator under it
  const windowDisc = new THREE.Mesh(new THREE.CircleGeometry(0.05, 32), new THREE.MeshStandardMaterial({ color: 0x55606e, metalness: 0.9, roughness: 0.3 }));
  windowDisc.rotation.x = Math.PI / 2;
  windowDisc.position.set(0.348, -0.291, 0);
  head.add(windowDisc);
  const collimator = new THREE.Group();
  collimator.position.set(0.348, -0.37, 0);
  head.add(collimator);
  collimator.add(new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.14, 0.27), cream));
  const aperture = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.012, 0.2), dark);
  aperture.position.y = -0.074;
  collimator.add(aperture);
  const lampMat = new HotMaterial(0xffc84a);
  const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.014, 20), lampMat);
  lamp.position.set(0.08, 0.02, 0.1355);
  lamp.userData.keepMaterial = true;
  collimator.add(lamp);

  // stand
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 1.85, 32), cream);
  column.position.set(-0.52, -0.06, -0.42);
  content.add(column);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.44), cream);
  arm.position.set(-0.52, 0.78, -0.21);
  content.add(arm);

  // patient table with the detector panel
  const focalWorld = focalLocal.clone().add(head.position);
  const table = new THREE.Group();
  table.position.set(focalWorld.x, -0.45, 0);
  content.add(table);
  table.add(new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.05, 0.95), cream));
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.006, 0.72), new THREE.MeshStandardMaterial({ color: 0x3b4450, metalness: 0.6, roughness: 0.35 }));
  panel.position.y = 0.028;
  table.add(panel);
  const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.78, 0.004, 0.72)), glowLineMaterial(0x6fd8ff, 0.5));
  frame.position.y = 0.032;
  table.add(frame);
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.42, 0.55), cream);
  base.position.y = -0.235;
  table.add(base);

  // the hand: bones inside a softly glowing skin
  const { bones, carpals, skin } = handLayout();
  const hand = new THREE.Group();
  hand.position.set(0, 0.052, -0.06);
  table.add(hand);
  const boneMat = new THREE.MeshStandardMaterial({ color: 0xf1ead8, roughness: 0.45, emissive: 0x4a4436 });
  for (const b of bones) hand.add(capsule(b.a, b.b, b.r, boneMat));
  for (const p of carpals) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.0115, 14, 10), boneMat);
    m.position.copy(p);
    hand.add(m);
  }
  const skinMat = holoMaterial(0x9fd8ff, { opacity: 0.6, fresnel: 2.2, scan: 0 });
  for (const s of skin) {
    hand.add(capsule(s.a, s.b, s.r, skinMat, 14));
  }
  const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), skinMat);
  palm.scale.set(0.068, 0.022, 0.07);
  palm.position.set(0.004, 0, 0.06);
  hand.add(palm);

  // monitor showing the radiograph
  const monitor = new THREE.Group();
  monitor.position.set(1.32, 0.12, 0.02);
  monitor.rotation.y = -0.5;
  content.add(monitor);
  monitor.add(new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.62, 0.04), dark));
  const images = { "60 kV": radiograph(bones, carpals, skin, "60 kV"), "120 kV": radiograph(bones, carpals, skin, "120 kV") };
  const screenMat = new THREE.MeshBasicMaterial({ map: images["60 kV"], toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 0.56), screenMat);
  screen.position.z = 0.021;
  screen.userData.keepMaterial = true;
  monitor.add(screen);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.85, 16), steel);
  pole.position.y = -0.72;
  monitor.add(pole);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.03, 32), dark);
  foot.position.y = -1.13;
  monitor.add(foot);

  // the X-ray field: a pyramid from the focal spot down to the table
  const fieldH = focalWorld.y - (-0.42);
  const fieldGeo = new THREE.ConeGeometry(0.34, fieldH, 4, 1, true);
  fieldGeo.rotateY(Math.PI / 4);
  const fieldMat = beamMaterial(0xb7a6ff, { intensity: 0.34, falloff: 0.65, pulse: 0.35, speed: 9 });
  const field = new THREE.Mesh(fieldGeo, fieldMat);
  field.position.set(focalWorld.x, focalWorld.y - fieldH / 2, 0);
  field.userData.keepMaterial = true;
  field.userData.noPick = true;
  content.add(field);

  // electrons: cathode → anode
  const E = glowPoints(240, 0.016, 0x9ae8ff);
  head.add(E.points);
  const ePhase = Array.from({ length: E.count }, () => R());
  const eJit = Array.from({ length: E.count }, () => [(R() - 0.5) * 0.05, (R() - 0.5) * 0.05]);

  // X-ray photons: focal spot → through the hand → detector
  const photons = new PhotonPool(26, photonGeometry(0.2, 5, 0.018, 0.0042), 0xc7b8ff, 2.2);
  content.add(photons.group);

  // ── actions ──
  const state = { power: true, voltage: "60 kV" as "60 kV" | "120 kV", anode: true };
  const anim = { power: 1, spin: 1, exposure: 1 };
  let spawnT = 0;
  const actions: ModelAction[] = [
    { id: "power", label: "Power", kind: "toggle", words: ["power", "beam", "x rays", "xrays", "exposure", "tube"], value: true, parts: [cathode, collimator] },
    { id: "voltage", label: "Tube voltage", kind: "choice", options: ["60 kV", "120 kV"], words: ["voltage", "kv", "kilovolts", "energy"], value: "60 kV" },
    { id: "anode", label: "Rotating anode", kind: "toggle", words: ["anode", "rotor", "spin", "target"], value: true, parts: [anode] },
  ];
  const parts = [
    part("Cathode filament", "A heated tungsten coil boils off electrons.", 1, marker(cathode, 0.02, 0.03, 0.03), cathode),
    part("Electron beam", "Electrons are accelerated by the tube voltage straight at the anode.", 2, marker(head, -0.02, beamY + 0.03, 0.03)),
    part("Rotating anode", "The tungsten target spins so the white-hot focal spot never melts it.", 1, marker(anode, 0, 0.14, 0.03), anode),
    part("X-ray photons", "Electrons slamming into tungsten give off X-rays (bremsstrahlung).", 1, marker(content, focalWorld.x + 0.12, 0.08, 0.1)),
    part("Collimator", "Lead shutters shape the beam to the area being imaged.", 2, marker(collimator, 0, 0, 0.14), collimator),
    part("Hand", "Soft tissue lets X-rays through; dense bone absorbs them.", 1, marker(hand, 0, 0.03, 0.05), hand),
    part("Detector", "Where the X-rays land: behind bone it stays dark, so bones show white.", 2, marker(table, 0.3, 0.04, 0.3)),
    part("Radiograph", "The image: bones white, soft tissue grey at low voltage.", 1, marker(monitor, 0, 0.18, 0.03), monitor),
  ];

  const homes = { head: head.position.clone(), monitor: monitor.position.clone(), hand: hand.position.clone() };
  const tmpFrom = V();
  const tmpTo = V();

  return wrap(content, 1.3, {
    parts,
    actions,
    act(id, value) {
      if (id === "power") state.power = Boolean(value);
      if (id === "anode") state.anode = Boolean(value);
      if (id === "voltage") {
        state.voltage = value === "120 kV" ? "120 kV" : "60 kV";
        screenMat.map = images[state.voltage];
        screenMat.needsUpdate = true;
      }
    },
    explode(a) {
      head.position.copy(homes.head).add(V(0, 0.35 * a, 0));
      insert.position.z = 0.45 * a;
      monitor.position.copy(homes.monitor).add(V(0.3 * a, 0, 0));
      hand.position.copy(homes.hand).add(V(0, 0.22 * a, 0));
    },
    update(dt, t) {
      const k = 1 - Math.exp(-dt * 4);
      anim.power += ((state.power ? 1 : 0) - anim.power) * k;
      anim.spin += ((state.anode ? 1 : 0) - anim.spin) * k * 0.5;
      const hi = state.voltage === "120 kV";
      const p = anim.power;
      filamentMat.level(0.25 + 2.2 * p);
      lampMat.level(p > 0.5 ? 1.6 + 0.4 * Math.sin(t * 10) : 0.1);
      anodeSpin.rotation.x += dt * 9 * anim.spin;
      (focal.material as THREE.SpriteMaterial).opacity = p * (0.75 + 0.25 * Math.sin(t * 37));
      focal.scale.setScalar(0.12 + 0.08 * p);
      fieldMat.uniforms.uI.value = 0.34 * p * (hi ? 1.25 : 1);
      // electrons stream from the filament and converge on the focal spot
      for (let i = 0; i < E.count; i++) {
        ePhase[i] = (ePhase[i] + dt * (hi ? 2.4 : 1.7)) % 1;
        const u = ePhase[i];
        const conv = 1 - u * 0.85;
        E.pos[i * 3] = -0.386 + u * (focalLocal.x - 0.012 + 0.386);
        E.pos[i * 3 + 1] = beamY + eJit[i][0] * conv;
        E.pos[i * 3 + 2] = eJit[i][1] * conv;
        E.alpha[i] = p * Math.sin(Math.PI * u) * 0.9;
      }
      E.commit();
      // photons
      spawnT -= dt;
      if (p > 0.3 && spawnT <= 0) {
        spawnT = hi ? 0.035 : 0.06;
        tmpFrom.copy(focalWorld);
        tmpTo.set(focalWorld.x + (R() - 0.5) * 0.62, -0.42, (R() - 0.5) * 0.6);
        const dir = tmpTo.clone().sub(tmpFrom);
        photons.emit(tmpFrom, dir, dir.length(), hi ? 2.6 : 2.0);
      }
      photons.update(dt, p);
      // the image builds up while the beam is on
      anim.exposure += ((state.power ? 1 : 0.22) - anim.exposure) * (1 - Math.exp(-dt * 2));
      screenMat.color.setScalar(0.25 + 0.75 * anim.exposure * (0.97 + 0.03 * Math.sin(t * 50)));
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Gamma radiation: decay against paper / aluminium / lead
// ─────────────────────────────────────────────────────────────────────────────

export function buildGammaRadiation(): BuiltObject {
  const R = rng(11);
  const content = new THREE.Group();
  const protonMat = new THREE.MeshStandardMaterial({ color: 0xe0473c, roughness: 0.32, metalness: 0.1, emissive: 0x3a0806 });
  const neutronMat = new THREE.MeshStandardMaterial({ color: 0x8fa6be, roughness: 0.32, metalness: 0.1, emissive: 0x0c1520 });

  // the unstable nucleus
  const NX = -0.88;
  const nucleus = new THREE.Group();
  nucleus.position.set(NX, 0.02, 0);
  content.add(nucleus);
  const ball = new THREE.SphereGeometry(0.047, 22, 16);
  const nucleons: { mesh: THREE.Mesh; home: THREE.Vector3; proton: boolean }[] = [];
  const pts: THREE.Vector3[] = [];
  for (let tries = 0; pts.length < 46 && tries < 20000; tries++) {
    const p = V(R() * 2 - 1, R() * 2 - 1, R() * 2 - 1).multiplyScalar(0.19);
    if (p.length() > 0.19) continue;
    if (pts.every((q) => q.distanceTo(p) > 0.074)) pts.push(p);
  }
  pts.sort((a, b) => a.length() - b.length());
  pts.forEach((p, i) => {
    const proton = i % 2 === 0;
    const m = new THREE.Mesh(ball, proton ? protonMat : neutronMat);
    m.position.copy(p);
    nucleus.add(m);
    nucleons.push({ mesh: m, home: p.clone(), proton });
  });
  const halo = flash(0x9fd8ff, 0.9);
  nucleus.add(halo);

  // shields
  const shields = new THREE.Group();
  content.add(shields);
  const paper = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.62, 0.5), new THREE.MeshStandardMaterial({ color: 0xf3f0e6, roughness: 0.9, transparent: true, opacity: 0.88, side: THREE.DoubleSide }));
  paper.position.x = -0.08;
  const alu = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.62, 0.5), new THREE.MeshStandardMaterial({ color: 0xb7bec6, metalness: 1, roughness: 0.48 }));
  alu.position.x = 0.32;
  const lead = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.62, 0.5), new THREE.MeshStandardMaterial({ color: 0x4a5059, metalness: 0.7, roughness: 0.55 }));
  lead.position.x = 0.86;
  shields.add(paper, alu, lead);
  const labels: [string, number][] = [
    ["PAPER", -0.08],
    ["ALUMINIUM", 0.32],
    ["LEAD", 0.86],
  ];
  for (const [text, x] of labels) {
    const l = floorLabel(text, 0.4);
    l.position.set(x, -0.336, 0.33);
    shields.add(l);
  }
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.04, 0.8), new THREE.MeshStandardMaterial({ color: 0x1a1f26, metalness: 0.6, roughness: 0.5 }));
  slab.position.set(0, -0.36, 0);
  content.add(slab);

  // radiation
  const gammas = new PhotonPool(10, photonGeometry(0.3, 10, 0.028, 0.006), 0xdcd0ff, 2.6);
  content.add(gammas.group);
  const ELEC = 6;
  const TRAIL = 10;
  const electrons = glowPoints(ELEC * TRAIL, 0.03, 0x7fe6ff);
  content.add(electrons.points);
  const eState = Array.from({ length: ELEC }, () => ({ alive: false, x: 0, y: 0, z: 0, vy: 0, stop: 0.3, trail: [] as THREE.Vector3[] }));
  const alphas: { g: THREE.Group; alive: boolean; x: number; y: number; z: number; stop: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const g = new THREE.Group();
    const small = new THREE.SphereGeometry(0.024, 14, 10);
    [V(0.018, 0.012, 0), V(-0.018, -0.012, 0), V(0, -0.012, 0.018), V(0, 0.012, -0.018)].forEach((p, j) => {
      const m = new THREE.Mesh(small, j < 2 ? protonMat : neutronMat);
      m.position.copy(p);
      g.add(m);
    });
    g.add(flash(0xffb070, 0.18));
    g.visible = false;
    content.add(g);
    alphas.push({ g, alive: false, x: 0, y: 0, z: 0, stop: 0 });
  }
  const sparks: { s: THREE.Sprite; life: number }[] = [];
  for (let i = 0; i < 8; i++) {
    const s = flash(0xffffff, 0.2);
    s.visible = false;
    content.add(s);
    sparks.push({ s, life: 0 });
  }
  const spark = (x: number, y: number, z: number, color: number) => {
    const sp = sparks.find((q) => q.life <= 0) ?? sparks[0];
    sp.s.position.set(x, y, z);
    (sp.s.material as THREE.SpriteMaterial).color.set(color);
    sp.s.visible = true;
    sp.life = 1;
  };

  // ── actions ──
  type Mode = "Gamma" | "Beta" | "Alpha" | "All three";
  const state = { mode: "Gamma" as Mode, shields: true };
  const anim = { excite: 0, shields: 1 };
  let next = 0.4;
  let cycle = 0;
  let betaFlip: { n: (typeof nucleons)[number]; t: number } | null = null;
  let alphaHidden: { list: (typeof nucleons)[number][]; t: number } | null = null;
  const actions: ModelAction[] = [
    { id: "decay", label: "Decay", kind: "choice", options: ["Gamma", "Beta", "Alpha", "All three"], words: ["decay", "radiation", "emit", "type"], value: "Gamma" },
    { id: "shields", label: "Shields", kind: "toggle", words: ["shields", "shielding", "paper", "aluminium", "aluminum", "lead"], value: true, parts: [paper, alu, lead] },
  ];
  const parts = [
    part("Unstable nucleus", "Too much energy: it settles down by shooting out radiation.", 1, marker(nucleus, 0, 0.21, 0), nucleus),
    part("Gamma ray", "A very high-energy photon: no mass, no charge, very penetrating.", 1, marker(content, 0.1, 0.12, 0)),
    part("Paper", "Stops alpha particles (helium nuclei).", 2, marker(paper, 0, 0.33, 0), paper),
    part("Aluminium", "A few millimetres stop beta particles (fast electrons).", 2, marker(alu, 0, 0.33, 0), alu),
    part("Lead", "Thick lead (or concrete) is needed to soak up gamma rays.", 1, marker(lead, 0, 0.33, 0), lead),
  ];

  const emit = (kind: "Gamma" | "Beta" | "Alpha") => {
    anim.excite = 1;
    const y = (R() - 0.5) * 0.22;
    const z = (R() - 0.5) * 0.2;
    const shieldsOn = state.shields;
    if (kind === "Gamma") {
      const absorbed = shieldsOn && R() < 0.55;
      const stopX = absorbed ? 0.75 + R() * 0.16 : 1.5;
      const from = V(NX + 0.2, 0.02 + y, z);
      const p = gammas.emit(from, V(1, (R() - 0.5) * 0.08, (R() - 0.5) * 0.08), stopX - from.x, 2.3, absorbed ? 1 : 0);
      if (p) p.tag = absorbed ? 1 : 0;
    } else if (kind === "Beta") {
      const e = eState.find((q) => !q.alive);
      if (e) {
        Object.assign(e, { alive: true, x: NX + 0.2, y: 0.02 + y, z, vy: (R() - 0.5) * 0.3, stop: shieldsOn ? 0.3 : 1.5, trail: [] });
      }
      const n = nucleons.find((q) => !q.proton && q.mesh.visible);
      if (n) {
        n.mesh.material = protonMat;
        betaFlip = { n, t: 1.4 };
      }
    } else {
      const a = alphas.find((q) => !q.alive);
      if (a) Object.assign(a, { alive: true, x: NX + 0.2, y: 0.02 + y * 0.6, z: z * 0.6, stop: shieldsOn ? -0.11 : 1.5 });
      if (a) a.g.visible = true;
      const outer = nucleons.slice(-4);
      outer.forEach((q) => (q.mesh.visible = false));
      alphaHidden = { list: outer, t: 1.6 };
    }
  };

  return wrap(content, 1.25, {
    parts,
    actions,
    act(id, value) {
      if (id === "decay") state.mode = (["Gamma", "Beta", "Alpha", "All three"].includes(String(value)) ? value : "Gamma") as Mode;
      if (id === "shields") state.shields = Boolean(value);
    },
    explode(a) {
      shields.position.x = 0.35 * a;
      nucleus.position.x = NX - 0.25 * a;
      for (const n of nucleons) n.mesh.position.copy(n.home).multiplyScalar(1 + 1.6 * a);
    },
    update(dt, t) {
      const k = 1 - Math.exp(-dt * 3);
      anim.shields += ((state.shields ? 1 : 0) - anim.shields) * k;
      shields.visible = anim.shields > 0.02;
      shields.scale.y = Math.max(0.001, anim.shields);
      next -= dt;
      if (next <= 0) {
        const kind = state.mode === "All three" ? (["Alpha", "Beta", "Gamma"] as const)[cycle++ % 3] : state.mode;
        emit(kind);
        next = kind === "Alpha" ? 1.9 : 1.25;
      }
      // excited nucleus jitters and glows, then relaxes
      anim.excite = Math.max(0, anim.excite - dt * 1.4);
      const jit = 0.004 + 0.012 * anim.excite;
      for (let i = 0; i < nucleons.length; i++) {
        const n = nucleons[i];
        n.mesh.position.x = n.home.x + Math.sin(t * 31 + i * 1.7) * jit;
        n.mesh.position.y = n.home.y + Math.sin(t * 27 + i * 2.3) * jit;
        n.mesh.position.z = n.home.z + Math.sin(t * 23 + i * 3.1) * jit;
      }
      (halo.material as THREE.SpriteMaterial).opacity = 0.25 + 0.75 * anim.excite;
      halo.scale.setScalar(0.6 + 0.6 * anim.excite);
      if (betaFlip && (betaFlip.t -= dt) <= 0) {
        betaFlip.n.mesh.material = neutronMat;
        betaFlip = null;
      }
      if (alphaHidden && (alphaHidden.t -= dt) <= 0) {
        alphaHidden.list.forEach((q) => (q.mesh.visible = true));
        alphaHidden = null;
      }
      // gamma photons; absorbed ones spark in the lead
      for (const p of gammas.items) {
        if (p.alive && p.tag === 1 && p.s + dt * p.speed > p.len) {
          const end = p.from.clone().addScaledVector(p.dir, p.len);
          spark(end.x, end.y, end.z, 0xcab8ff);
        }
      }
      gammas.update(dt);
      // beta electrons with short trails
      electrons.alpha.fill(0);
      eState.forEach((e, i) => {
        if (!e.alive) return;
        e.x += dt * 1.5;
        e.vy += (Math.sin(t * 9 + i) * 0.6 - e.vy) * dt;
        e.y += e.vy * dt * 0.3;
        e.trail.unshift(V(e.x, e.y, e.z));
        if (e.trail.length > TRAIL) e.trail.pop();
        if (e.x >= e.stop) {
          e.alive = false;
          if (e.stop < 1) spark(e.stop, e.y, e.z, 0x7fe6ff);
        }
        e.trail.forEach((q, j) => {
          const idx = i * TRAIL + j;
          electrons.pos.set([q.x, q.y, q.z], idx * 3);
          electrons.alpha[idx] = (1 - j / TRAIL) * (e.alive ? 1 : 0);
          electrons.size[idx] = 1 - j / (TRAIL * 1.4);
        });
      });
      electrons.commit();
      // alpha particles are slow and heavy; paper stops them
      for (const a of alphas) {
        if (!a.alive) continue;
        a.x += dt * 0.75;
        a.g.position.set(a.x, a.y, a.z);
        a.g.rotation.y += dt * 3;
        if (a.x >= a.stop) {
          a.alive = false;
          a.g.visible = false;
          if (a.stop < 1) spark(a.stop, a.y, a.z, 0xffb070);
        }
      }
      for (const sp of sparks) {
        if (sp.life <= 0) continue;
        sp.life -= dt * 2.2;
        const m = sp.s.material as THREE.SpriteMaterial;
        m.opacity = Math.max(0, sp.life);
        sp.s.scale.setScalar(0.12 + (1 - sp.life) * 0.25);
        if (sp.life <= 0) sp.s.visible = false;
      }
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Photon: an electromagnetic wave across the spectrum
// ─────────────────────────────────────────────────────────────────────────────

const BANDS = [
  { name: "Radio", lambda: 2.3, color: 0xff7a45, pos: 0.05 },
  { name: "Microwave", lambda: 1.25, color: 0xffa040, pos: 0.19 },
  { name: "Infrared", lambda: 0.72, color: 0xff4b4b, pos: 0.34 },
  { name: "Visible", lambda: 0.42, color: 0x7dff9a, pos: 0.49 },
  { name: "Ultraviolet", lambda: 0.25, color: 0xa96dff, pos: 0.64 },
  { name: "X-ray", lambda: 0.14, color: 0x9fd8ff, pos: 0.79 },
  { name: "Gamma", lambda: 0.075, color: 0xece6ff, pos: 0.94 },
];

function spectrumTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 1024;
  c.height = 96;
  const g = c.getContext("2d")!;
  const gr = g.createLinearGradient(0, 0, 1024, 0);
  gr.addColorStop(0, "#5a1408");
  gr.addColorStop(0.2, "#8a3a10");
  gr.addColorStop(0.36, "#b0202a");
  gr.addColorStop(0.42, "#ff2a2a");
  gr.addColorStop(0.46, "#ffd23a");
  gr.addColorStop(0.5, "#3aff6a");
  gr.addColorStop(0.54, "#3a8dff");
  gr.addColorStop(0.58, "#8a3aff");
  gr.addColorStop(0.7, "#5a2aa0");
  gr.addColorStop(0.82, "#3a6a9a");
  gr.addColorStop(1, "#d8e4ff");
  g.fillStyle = gr;
  g.fillRect(0, 0, 1024, 40);
  g.fillStyle = "rgba(190,225,255,0.95)";
  g.font = "600 22px Rajdhani, sans-serif";
  g.textAlign = "center";
  for (const b of BANDS) g.fillText(b.name.toUpperCase(), b.pos * 1024, 76);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function buildPhoton(): BuiltObject {
  const content = new THREE.Group();
  const L = 2.4;
  const AMP = 0.3;
  const waveGeo = new THREE.CylinderGeometry(0.017, 0.017, L, 8, 520, true);
  waveGeo.rotateZ(Math.PI / 2);
  const shared = { uK: { value: TAU / 0.42 }, uPhase: { value: 0 }, uAmp: { value: AMP }, uPacket: { value: 0 }, uPX: { value: -1.4 } };
  const waveMat = (color: number, axis: "y" | "z") =>
    new THREE.ShaderMaterial({
      uniforms: { ...shared, uColor: { value: new THREE.Color(color) }, uGain: holoGain },
      vertexShader: /* glsl */ `
        uniform float uK; uniform float uPhase; uniform float uAmp; uniform float uPacket; uniform float uPX;
        varying float vEnv;
        void main() {
          vec3 p = position;
          float x = p.x;
          float edge = smoothstep(-1.2, -1.0, x) * (1.0 - smoothstep(1.0, 1.2, x));
          float pk = exp(-pow((x - uPX) / 0.3, 2.0));
          float env = mix(edge, pk * edge, uPacket);
          p.${axis} += uAmp * sin(uK * x - uPhase) * env;
          vEnv = mix(1.0, pk, uPacket) * edge;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uGain; varying float vEnv;
        void main() { float a = 0.18 + 0.82 * vEnv; gl_FragColor = vec4(uColor * a * (0.6 + 0.9 * uGain) * 1.4, a); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  const eMat = waveMat(0xff4d5a, "y");
  const bMat = waveMat(0x4d8dff, "z");
  const eWave = new THREE.Mesh(waveGeo, eMat);
  const bWave = new THREE.Mesh(waveGeo, bMat);
  eWave.userData.keepMaterial = bWave.userData.keepMaterial = true;
  eWave.userData.noPick = bWave.userData.noPick = true;
  const eGroup = new THREE.Group();
  const bGroup = new THREE.Group();
  eGroup.add(eWave);
  bGroup.add(bWave);
  content.add(eGroup, bGroup);
  // field vectors (axis → curve)
  const N = 56;
  const vecGeo = (n: number) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 6), 3).setUsage(THREE.DynamicDrawUsage));
    return g;
  };
  const eVec = new THREE.LineSegments(vecGeo(N), glowLineMaterial(0xff4d5a, 0.55));
  const bVec = new THREE.LineSegments(vecGeo(N), glowLineMaterial(0x4d8dff, 0.55));
  eVec.frustumCulled = bVec.frustumCulled = false;
  eGroup.add(eVec);
  bGroup.add(bVec);
  // propagation axis + arrow
  const axisMat = glowLineMaterial(0xdfefff, 0.35);
  const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(-1.25, 0, 0), V(1.25, 0, 0)]), axisMat);
  content.add(axis);
  const arrowMat = beamMaterial(0xdfefff, { intensity: 0.9, falloff: 0.2 });
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, 20), arrowMat);
  arrow.rotation.z = -Math.PI / 2;
  arrow.position.x = 1.3;
  arrow.userData.keepMaterial = true;
  content.add(arrow);
  // the photon itself (packet mode)
  const photonGlow = flash(0x7dff9a, 0.35);
  content.add(photonGlow);
  const core = glowPoints(1, 0.06, 0xffffff);
  content.add(core.points);
  // spectrum bar with a marker
  const bar = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.215), new THREE.MeshBasicMaterial({ map: spectrumTexture(), transparent: true, toneMapped: false }));
  bar.position.set(0, -0.62, 0);
  bar.userData.keepMaterial = true;
  content.add(bar);
  const markerMat = beamMaterial(0x7dff9a, { intensity: 1.2, falloff: 0.2 });
  const pointer = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.11, 3), markerMat);
  pointer.rotation.z = Math.PI;
  pointer.position.set(0, -0.47, 0.01);
  pointer.userData.keepMaterial = true;
  content.add(pointer);

  // ── actions ──
  const state = { band: "Visible", packet: false, vectors: true };
  const anim = { k: TAU / 0.42, color: new THREE.Color(0x7dff9a), pos: 0.49, packet: 0, vectors: 1 };
  let px = -1.4;
  const actions: ModelAction[] = [
    { id: "band", label: "Band", kind: "choice", options: BANDS.map((b) => b.name), words: ["band", "spectrum", "wavelength", "frequency", "colour", "color"], value: "Visible" },
    { id: "packet", label: "Photon packet", kind: "toggle", words: ["packet", "photon", "particle", "single photon"], value: false },
    { id: "vectors", label: "Field vectors", kind: "toggle", words: ["vectors", "arrows", "fields", "field lines"], value: true },
  ];
  const parts = [
    part("Electric field", "Oscillates up and down, at right angles to the magnetic field.", 1, marker(content, -0.35, 0.34, 0)),
    part("Magnetic field", "Oscillates side to side; each field keeps the other going.", 1, marker(content, -0.6, 0, 0.32)),
    part("Wavelength", "Crest to crest: radio waves are metres long, gamma rays smaller than an atom.", 2, marker(content, 0.4, 0.33, 0)),
    part("Propagation", "Every band travels at the speed of light: 299,792 km/s.", 2, marker(arrow, 0, 0, 0)),
    part("Spectrum", "Shorter wavelength = higher frequency = more energy per photon.", 1, marker(bar, 0, 0.12, 0), bar),
  ];

  return wrap(content, 1.3, {
    parts,
    actions,
    act(id, value) {
      if (id === "band" && BANDS.some((b) => b.name === value)) state.band = String(value);
      if (id === "packet") state.packet = Boolean(value);
      if (id === "vectors") state.vectors = Boolean(value);
    },
    explode(a) {
      eGroup.position.y = 0.25 * a;
      bGroup.position.z = 0.35 * a;
      bar.position.y = -0.62 - 0.25 * a;
    },
    update(dt, t) {
      const band = BANDS.find((b) => b.name === state.band) ?? BANDS[3];
      const k = 1 - Math.exp(-dt * 3);
      // smooth in log space so the wavelength glides between bands
      anim.k = Math.exp(Math.log(anim.k) + (Math.log(TAU / band.lambda) - Math.log(anim.k)) * k);
      anim.pos += (band.pos - anim.pos) * k;
      const target = new THREE.Color(band.color);
      if (band.name === "Visible") target.setHSL((t * 0.08) % 1, 0.85, 0.6);
      anim.color.lerp(target, k);
      anim.packet += ((state.packet ? 1 : 0) - anim.packet) * k;
      anim.vectors += ((state.vectors ? 1 : 0) - anim.vectors) * k;
      // all bands move at the speed of light: ω = c·k
      shared.uK.value = anim.k;
      shared.uPhase.value += dt * anim.k * 0.55;
      shared.uPacket.value = anim.packet;
      px += dt * 0.55;
      if (px > 1.45) px = -1.45;
      shared.uPX.value = px;
      // field vectors from the same formula
      const ePos = (eVec.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
      const bPos = (bVec.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array;
      for (let i = 0; i < N; i++) {
        const x = -1.1 + (2.2 * i) / (N - 1);
        const edge = THREE.MathUtils.smoothstep(x, -1.2, -1.0) * (1 - THREE.MathUtils.smoothstep(x, 1.0, 1.2));
        const pk = Math.exp(-Math.pow((x - px) / 0.3, 2));
        const env = (1 - anim.packet) * edge + anim.packet * pk * edge;
        const off = AMP * Math.sin(anim.k * x - shared.uPhase.value) * env * anim.vectors;
        ePos.set([x, 0, 0, x, off, 0], i * 6);
        bPos.set([x, 0, 0, x, 0, off], i * 6);
      }
      eVec.geometry.attributes.position.needsUpdate = true;
      bVec.geometry.attributes.position.needsUpdate = true;
      // photon glow rides the packet; marker shows the band
      photonGlow.position.set(px, 0, 0);
      (photonGlow.material as THREE.SpriteMaterial).color.copy(anim.color);
      (photonGlow.material as THREE.SpriteMaterial).opacity = anim.packet;
      core.pos.set([px, 0, 0], 0);
      core.alpha[0] = anim.packet;
      core.commit();
      pointer.position.x = -1.15 + anim.pos * 2.3;
      markerMat.uniforms.uColor.value.copy(anim.color);
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Laser
// ─────────────────────────────────────────────────────────────────────────────

const LASER_COLORS: Record<string, { rod: number; beam: number }> = {
  Red: { rod: 0xd84a6a, beam: 0xff2d2d },
  Green: { rod: 0x5ad08a, beam: 0x37ff6a },
  Blue: { rod: 0x6a8dff, beam: 0x3d7bff },
};

export function buildLaser(): BuiltObject {
  const R = rng(5);
  const content = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xa9b1ba, metalness: 1, roughness: 0.28 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23282f, metalness: 0.85, roughness: 0.42 });
  const X0 = -0.72;
  const X1 = 0.72;

  // optical bench
  const bench = new THREE.Group();
  content.add(bench);
  const rail = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.05, 0.16), dark);
  rail.position.set(0.45, -0.28, 0);
  bench.add(rail);
  for (const x of [X0 - 0.02, -0.25, 0.25, X1 + 0.02, 1.7]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.2, 16), steel);
    post.position.set(x, -0.16, 0);
    bench.add(post);
  }

  // gain medium (ruby rod)
  const rodMat = new THREE.MeshPhysicalMaterial({ color: 0xd84a6a, emissive: 0xd84a6a, emissiveIntensity: 0.15, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.6, clearcoat: 1 });
  const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 1.2, 48), rodMat);
  rod.rotation.z = Math.PI / 2;
  content.add(rod);

  // flash lamp coiled round it
  class Coil extends THREE.Curve<THREE.Vector3> {
    constructor() {
      super();
    }
    getPoint(t: number, out = new THREE.Vector3()) {
      const a = t * TAU * 9;
      return out.set(-0.56 + 1.12 * t, Math.cos(a) * 0.115, Math.sin(a) * 0.115);
    }
  }
  const lampMat = new HotMaterial(0xdfe9ff);
  const lamp = new THREE.Mesh(new THREE.TubeGeometry(new Coil(), 600, 0.011, 8, false), lampMat);
  lamp.userData.keepMaterial = true;
  content.add(lamp);

  // mirrors
  const mirror = (x: number, partial: boolean) => {
    const g = new THREE.Group();
    g.position.x = x;
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.11, 0.02, 48),
      partial
        ? new THREE.MeshPhysicalMaterial({ color: 0x9fc8ff, metalness: 0.3, roughness: 0.05, transparent: true, opacity: 0.45, clearcoat: 1 })
        : new THREE.MeshStandardMaterial({ color: 0xe6edf4, metalness: 1, roughness: 0.04 }),
    );
    disc.rotation.z = Math.PI / 2;
    g.add(disc);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.016, 12, 48), dark);
    ring.rotation.y = Math.PI / 2;
    g.add(ring);
    content.add(g);
    return g;
  };
  const backMirror = mirror(X0, false);
  const coupler = mirror(X1, true);

  // excited atoms and the photons bouncing between the mirrors
  const ATOMS = 70;
  const atoms = glowPoints(ATOMS, 0.016, 0xff8aa0);
  content.add(atoms.points);
  const atomExc = new Float32Array(ATOMS);
  for (let i = 0; i < ATOMS; i++) {
    const a = R() * TAU;
    const r = Math.sqrt(R()) * 0.065;
    atoms.pos.set([-0.58 + R() * 1.16, Math.cos(a) * r, Math.sin(a) * r], i * 3);
  }
  const PH = 160;
  const cav = glowPoints(PH, 0.022, 0xff3a3a);
  content.add(cav.points);
  const ph = Array.from({ length: PH }, () => ({ alive: false, x: 0, y: 0, z: 0, dir: 1 }));

  // output beam and target
  const beamMat = beamMaterial(0xff2d2d, { intensity: 1, falloff: 0.15, pulse: 0.25, speed: 30 });
  const beamGeo = new THREE.CylinderGeometry(0.045, 0.045, 1.0, 20, 1, true);
  beamGeo.rotateZ(-Math.PI / 2);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.x = X1 + 0.52;
  beam.userData.keepMaterial = true;
  beam.userData.noPick = true;
  content.add(beam);
  const coreMat = new HotMaterial(0xffd0d0);
  const beamCore = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 1.0, 8), coreMat);
  beamCore.rotation.z = Math.PI / 2;
  beamCore.position.x = X1 + 0.52;
  beamCore.userData.keepMaterial = true;
  content.add(beamCore);
  const target = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.36, 0.36), dark);
  target.position.x = X1 + 1.06;
  content.add(target);
  const hit = flash(0xff5040, 0.28);
  hit.position.set(X1 + 1.03, 0, 0);
  content.add(hit);

  // ── actions ──
  const state = { pump: true, color: "Red" };
  const anim = { pump: 1, power: 0, rod: new THREE.Color(0xd84a6a), beam: new THREE.Color(0xff2d2d) };
  let flashT = 0;
  const actions: ModelAction[] = [
    { id: "pump", label: "Pump", kind: "toggle", words: ["pump", "flash", "flash lamp", "power", "laser"], value: true, parts: [lamp] },
    { id: "color", label: "Colour", kind: "choice", options: ["Red", "Green", "Blue"], words: ["colour", "color", "wavelength"], value: "Red" },
  ];
  const parts = [
    part("Gain medium", "A ruby crystal: pumped atoms release identical photons (stimulated emission).", 1, marker(rod, 0, 0.09, 0), rod),
    part("Flash lamp", "Bright flashes kick the atoms into an excited state.", 2, marker(lamp, 0.3, 0.13, 0.05), lamp),
    part("Full mirror", "Bounces every photon back through the crystal.", 2, marker(backMirror, 0, 0.14, 0), backMirror),
    part("Output coupler", "A partial mirror: lets a little of the light out as the beam.", 2, marker(coupler, 0, 0.14, 0), coupler),
    part("Laser beam", "Coherent light: one colour, one direction, all in step.", 1, marker(beam, 0, 0.05, 0), beam),
  ];

  return wrap(content, 1.25, {
    parts,
    actions,
    act(id, value) {
      if (id === "pump") state.pump = Boolean(value);
      if (id === "color" && String(value) in LASER_COLORS) state.color = String(value);
    },
    explode(a) {
      backMirror.position.x = X0 - 0.35 * a;
      coupler.position.x = X1 + 0.35 * a;
      lamp.position.y = 0.28 * a;
      bench.position.y = -0.2 * a;
    },
    update(dt, t) {
      const k = 1 - Math.exp(-dt * 3);
      anim.pump += ((state.pump ? 1 : 0) - anim.pump) * k;
      const col = LASER_COLORS[state.color];
      anim.rod.lerp(new THREE.Color(col.rod), k);
      anim.beam.lerp(new THREE.Color(col.beam), k);
      rodMat.color.copy(anim.rod);
      rodMat.emissive.copy(anim.rod);
      // flash lamp pulses; each flash excites atoms
      flashT -= dt;
      let flashing = 0;
      if (anim.pump > 0.5 && flashT <= 0) {
        flashT = 0.9;
        for (let i = 0; i < ATOMS; i++) if (R() < 0.75) atomExc[i] = 1;
      }
      if (flashT > 0.7) flashing = (flashT - 0.7) / 0.2;
      lampMat.level(0.15 + 3.2 * flashing * anim.pump);
      // excited atoms decay by emitting a photon along the rod (stimulated emission)
      for (let i = 0; i < ATOMS; i++) {
        atomExc[i] = Math.max(0, atomExc[i] - dt * (0.6 + R() * 0.8));
        if (atomExc[i] > 0.05 && R() < dt * 3) {
          const p = ph.find((q) => !q.alive);
          if (p) {
            Object.assign(p, { alive: true, x: atoms.pos[i * 3], y: atoms.pos[i * 3 + 1], z: atoms.pos[i * 3 + 2], dir: R() < 0.5 ? -1 : 1 });
            atomExc[i] = 0;
          }
        }
        atoms.alpha[i] = 0.15 + 0.85 * atomExc[i];
        atoms.color.set([anim.rod.r, anim.rod.g, anim.rod.b], i * 3);
      }
      atoms.commit();
      // photons bounce between the mirrors; some leak out of the coupler as the beam
      let alive = 0;
      for (let i = 0; i < PH; i++) {
        const p = ph[i];
        if (p.alive) {
          p.x += p.dir * dt * 1.8;
          if (p.x < X0 + 0.01) p.dir = 1;
          if (p.x > X1 - 0.01) {
            if (R() < 0.12) p.alive = false;
            else p.dir = -1;
          }
          if (anim.pump < 0.2 && R() < dt * 0.8) p.alive = false;
        }
        if (p.alive) alive++;
        cav.pos.set([p.x, p.y, p.z], i * 3);
        cav.alpha[i] = p.alive ? 0.9 : 0;
        cav.color.set([anim.beam.r, anim.beam.g, anim.beam.b], i * 3);
      }
      cav.commit();
      anim.power += (Math.min(1, alive / 60) - anim.power) * (1 - Math.exp(-dt * 5));
      beamMat.uniforms.uColor.value.copy(anim.beam);
      beamMat.uniforms.uI.value = anim.power * 1.1;
      coreMat.setBase(anim.beam.clone().lerp(new THREE.Color(0xffffff), 0.6));
      coreMat.level(anim.power * 2.2);
      beam.visible = beamCore.visible = anim.power > 0.02;
      (hit.material as THREE.SpriteMaterial).color.copy(anim.beam);
      (hit.material as THREE.SpriteMaterial).opacity = anim.power * (0.8 + 0.2 * Math.sin(t * 40));
      hit.scale.setScalar(0.14 + 0.16 * anim.power);
    },
  });
}
