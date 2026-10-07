import * as THREE from "three";
import type { BuiltObject } from "./types";
import { centerOf, part } from "./parts";

interface Part {
  obj: THREE.Object3D;
  home: THREE.Vector3;
  out: THREE.Vector3;
}

function explodeParts(parts: Part[], amount: number) {
  for (const p of parts) p.obj.position.copy(p.home).addScaledVector(p.out, amount);
}

const shadowed = <T extends THREE.Object3D>(o: T): T => {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  return o;
};

// ─── Materials (physically based; reflections come from the scene environment) ───

const paint = () =>
  new THREE.MeshPhysicalMaterial({ color: 0x8c0a12, metalness: 0.6, roughness: 0.34, clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1 });
const carbon = () => new THREE.MeshPhysicalMaterial({ color: 0x0d0f12, metalness: 0.4, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.2 });
const glass = () =>
  new THREE.MeshPhysicalMaterial({ color: 0x03070c, metalness: 0.2, roughness: 0.06, transparent: true, opacity: 0.92, clearcoat: 1, envMapIntensity: 0.9 });
const chrome = () => new THREE.MeshStandardMaterial({ color: 0xd7dde4, metalness: 1, roughness: 0.14, envMapIntensity: 1.6 });
const rubber = () => new THREE.MeshStandardMaterial({ color: 0x111214, metalness: 0, roughness: 0.92 });
const aluminium = () => new THREE.MeshStandardMaterial({ color: 0xb9c0c8, metalness: 1, roughness: 0.34, envMapIntensity: 1.2 });
const steel = () => new THREE.MeshStandardMaterial({ color: 0x8a8f96, metalness: 1, roughness: 0.28, envMapIntensity: 1.2 });

function wheel(): THREE.Group {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.12, 24, 64), rubber());
  const sidewall = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.2, 48, 1, true), rubber());
  sidewall.rotation.x = Math.PI / 2;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, 0.2, 48), chrome());
  rim.rotation.x = Math.PI / 2;
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.04, 40), steel());
  disc.rotation.x = Math.PI / 2;
  disc.position.z = -0.02;
  const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.08), new THREE.MeshStandardMaterial({ color: 0xd8b31a, metalness: 0.3, roughness: 0.4 }));
  caliper.position.set(0.17, 0.08, 0.02);
  g.add(tire, sidewall, disc, caliper, rim);
  // Five split spokes on the outer face
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.27, 0.03), new THREE.MeshStandardMaterial({ color: 0x23272d, metalness: 0.9, roughness: 0.3 }));
    spoke.position.set(0, 0.135, 0.105);
    const pivot = new THREE.Group();
    pivot.rotation.z = (i / 5) * Math.PI * 2;
    pivot.add(spoke);
    g.add(pivot);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.24, 16), chrome());
  hub.rotation.x = Math.PI / 2;
  g.add(hub);
  return shadowed(g);
}

/** Low supercar coupé: extruded body with wheel arches, glass cabin, real-ish details. */
export function buildCar(): BuiltObject {
  const car = new THREE.Group();
  const W = 1.82;
  const wheelY = 0.45;

  // Side profile up to the belt line, wheel arches cut into the sill.
  const s = new THREE.Shape();
  s.moveTo(-2.25, 0.36);
  s.lineTo(-2.33, 0.6);
  s.quadraticCurveTo(-2.36, 0.88, -2.08, 0.93);
  s.lineTo(-1.25, 0.97);
  s.lineTo(1.3, 0.97);
  s.quadraticCurveTo(1.9, 0.9, 2.2, 0.76);
  s.quadraticCurveTo(2.38, 0.66, 2.32, 0.46);
  s.lineTo(2.2, 0.34);
  s.lineTo(1.35 + 0.47, 0.34);
  s.absarc(1.35, wheelY, 0.47, -0.23, Math.PI + 0.23, false);
  s.lineTo(-1.35 + 0.47, 0.34);
  s.absarc(-1.35, wheelY, 0.47, -0.23, Math.PI + 0.23, false);
  s.lineTo(-2.25, 0.34);
  const bodyGeo = new THREE.ExtrudeGeometry(s, { depth: W, bevelEnabled: true, bevelThickness: 0.16, bevelSize: 0.13, bevelSegments: 8, curveSegments: 40 });
  bodyGeo.translate(0, 0, -W / 2);
  const body = new THREE.Mesh(bodyGeo, paint());

  // Cabin (greenhouse): narrower, rounded, glass with a body-colour roof strip.
  const c = new THREE.Shape();
  c.moveTo(-1.32, 0.95);
  c.quadraticCurveTo(-0.85, 1.05, -0.5, 1.3);
  c.quadraticCurveTo(-0.05, 1.42, 0.45, 1.38);
  c.quadraticCurveTo(0.95, 1.3, 1.34, 0.95);
  c.lineTo(-1.32, 0.95);
  const cabinGeo = new THREE.ExtrudeGeometry(c, { depth: 1.22, bevelEnabled: true, bevelThickness: 0.14, bevelSize: 0.12, bevelSegments: 8, curveSegments: 32 });
  cabinGeo.translate(0, 0, -0.61);
  const cabin = new THREE.Group();
  cabin.add(new THREE.Mesh(cabinGeo, glass()));
  const roof = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.04, 1.2), paint());
  roof.position.set(-0.02, 1.47, 0);
  roof.rotation.z = 0.03;
  cabin.add(roof);

  // Details
  const lights = new THREE.Group();
  const head = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xdff4ff, emissiveIntensity: 3 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x330000, emissive: 0xff1a2a, emissiveIntensity: 2.6 });
  for (const z of [0.62, -0.62]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.035, 0.42), head);
    h.position.set(2.27, 0.74, z);
    h.rotation.z = -0.35;
    lights.add(h);
  }
  const tailBar = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, W + 0.1), tail);
  tailBar.position.set(-2.37, 0.82, 0);
  lights.add(tailBar);

  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 1.1), carbon());
  grille.position.set(2.32, 0.5, 0);
  const diffuser = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 1.4), carbon());
  diffuser.position.set(-2.25, 0.42, 0);
  const splitter = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 1.7), carbon());
  splitter.position.set(2.1, 0.33, 0);
  const sideIntakeL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.06), carbon());
  sideIntakeL.position.set(-0.55, 0.62, W / 2 + 0.13);
  const sideIntakeR = sideIntakeL.clone();
  sideIntakeR.position.z = -(W / 2 + 0.13);
  const exhaust = new THREE.Group();
  for (const z of [0.32, 0.18, -0.18, -0.32]) {
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.12, 20), chrome());
    tip.rotation.z = Math.PI / 2;
    tip.position.set(-2.38, 0.44, z);
    exhaust.add(tip);
  }
  const mirrors = new THREE.Group();
  for (const z of [1, -1]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.14), paint());
    m.position.set(1.0, 1.04, z * (W / 2 + 0.12));
    mirrors.add(m);
  }
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.03, W - 0.1), carbon());
  spoiler.position.set(-2.05, 1.0, 0);

  car.add(shadowed(body), shadowed(cabin), lights, shadowed(grille), shadowed(diffuser), shadowed(splitter), sideIntakeL, sideIntakeR, exhaust, shadowed(mirrors), shadowed(spoiler));

  const parts: Part[] = [];
  for (const [x, z] of [
    [1.35, W / 2 + 0.02],
    [1.35, -(W / 2 + 0.02)],
    [-1.35, W / 2 + 0.02],
    [-1.35, -(W / 2 + 0.02)],
  ]) {
    const w = wheel();
    if (z < 0) w.rotation.y = Math.PI; // spokes face outward on both sides
    w.position.set(x, wheelY, z);
    car.add(w);
    parts.push({ obj: w, home: w.position.clone(), out: new THREE.Vector3(x * 0.12, -0.05, Math.sign(z) * 0.9) });
  }
  parts.push({ obj: cabin, home: cabin.position.clone(), out: new THREE.Vector3(0, 0.8, 0) });
  parts.push({ obj: spoiler, home: spoiler.position.clone(), out: new THREE.Vector3(-0.3, 0.6, 0) });
  parts.push({ obj: lights, home: lights.position.clone(), out: new THREE.Vector3(0, 0.25, 0) });

  car.position.y = -0.72;
  const wrapper = new THREE.Group();
  wrapper.add(car);
  wrapper.scale.setScalar(0.6);
  wrapper.rotation.y = -0.55;
  const wheels = parts.slice(0, 4).map((p) => p.obj);
  const carParts = [
    part("Body", "Aerodynamic shell that shapes airflow and protects the chassis.", 1, centerOf(body, 0.3), body),
    part("Cabin", "Passenger cell with the glasshouse and roof.", 1, centerOf(cabin, 0.2), cabin),
    part("Wheels", "Alloy wheels and tyres: grip, braking and steering.", 1, centerOf(wheels[0]), wheels[0]),
    part("Headlights", "Light the road ahead and signal the car's presence.", 2, centerOf(lights), lights),
    part("Grille", "Feeds cooling air to the radiator and engine bay.", 2, centerOf(grille), grille),
    part("Rear spoiler", "Presses the rear down at speed for stability.", 2, centerOf(spoiler), spoiler),
    part("Diffuser", "Speeds up air under the car to reduce lift.", 2, centerOf(diffuser), diffuser),
    part("Side mirrors", "Rear view for the driver.", 2, centerOf(mirrors), mirrors),
    part("Exhaust", "Carries burnt gases out of the engine.", 2, centerOf(exhaust), exhaust),
    part("Splitter", "Front lip that manages air under the nose.", 2, centerOf(splitter), splitter),
  ];
  return { content: wrapper, radius: 1.45, parts: carParts, explode: (a) => explodeParts(parts, a) };
}

/** V8: aluminium block/heads, crinkle-red valve covers, steel headers, belt drive. */
export function buildEngine(): BuiltObject {
  let firstBank: { head: THREE.Object3D; cover: THREE.Object3D; piston: THREE.Object3D | null; pipe: THREE.Object3D } | null = null;
  const chromeMat = chrome();
  const engine = new THREE.Group();
  const parts: Part[] = [];
  const add = (obj: THREE.Object3D, out: THREE.Vector3) => {
    engine.add(shadowed(obj));
    parts.push({ obj, home: obj.position.clone(), out });
  };

  const block = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.7, 0.9, 1, 1, 1), aluminium());
  block.position.y = -0.1;
  engine.add(shadowed(block));
  const oilPan = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.25, 0.7), new THREE.MeshStandardMaterial({ color: 0x2b2f35, metalness: 0.8, roughness: 0.4 }));
  oilPan.position.y = -0.58;
  add(oilPan, new THREE.Vector3(0, -0.6, 0));

  const valveRed = new THREE.MeshPhysicalMaterial({ color: 0x9b1018, metalness: 0.35, roughness: 0.55, clearcoat: 0.5 });
  for (const side of [1, -1]) {
    const bank = new THREE.Group();
    bank.position.set(0, 0.35, side * 0.32);
    bank.rotation.x = side * (Math.PI / 4);
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.2, 0.5), aluminium());
    head.position.y = 0.6;
    const cover = new THREE.Group();
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.12, 0.44), valveRed);
    cover.add(lid);
    for (let i = 0; i < 8; i++) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.36), valveRed);
      rib.position.set(-0.7 + i * 0.2, 0.08, 0);
      cover.add(rib);
    }
    cover.position.y = 0.76;
    bank.add(head, cover);
    for (let i = 0; i < 4; i++) {
      const x = -0.6 + i * 0.4;
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.6, 32), steel());
      cyl.position.set(x, 0.25, 0);
      bank.add(cyl);
      const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.135, 0.16, 28), chromeMat);
      piston.position.set(x, 0.2, 0);
      bank.add(piston);
      parts.push({ obj: piston, home: piston.position.clone(), out: new THREE.Vector3(0, 0.5, 0) });
      // Exhaust header pipe from the outer face, sweeping down
      const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x, 0.45, 0.25), new THREE.Vector3(x, 0.35, 0.5), new THREE.Vector3(x + 0.05, -0.05, 0.62), new THREE.Vector3(0.3, -0.35, 0.62)]);
      const pipe = new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.045, 10), new THREE.MeshStandardMaterial({ color: 0x9a7d62, metalness: 1, roughness: 0.32 }));
      bank.add(pipe);
    }
    add(bank, new THREE.Vector3(0, 0.45, side * 0.55));
    parts.push({ obj: cover, home: cover.position.clone(), out: new THREE.Vector3(0, 0.55, 0) });
    if (side === 1) firstBank = { head, cover, piston: bank.children.find((c) => (c as THREE.Mesh).isMesh && (c as THREE.Mesh).material === chromeMat) ?? null, pipe: bank.children[bank.children.length - 1] };
  }

  const intake = new THREE.Group();
  const plenum = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.16, 0.32), new THREE.MeshStandardMaterial({ color: 0x1b1e23, metalness: 0.6, roughness: 0.38 }));
  const throttle = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.2, 28), aluminium());
  throttle.rotation.z = Math.PI / 2;
  throttle.position.set(0.75, 0.02, 0);
  intake.add(plenum, throttle);
  intake.position.y = 0.74;
  add(intake, new THREE.Vector3(0, 0.95, 0));

  const crank = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.1, 20), steel());
  crank.rotation.z = Math.PI / 2;
  crank.position.y = -0.5;
  add(crank, new THREE.Vector3(0, -0.5, 0));

  const front = new THREE.Group();
  const pulley = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.08, 48), steel());
  pulley.rotation.z = Math.PI / 2;
  pulley.position.set(0, -0.35, 0);
  const alt = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.18, 32), aluminium());
  alt.rotation.z = Math.PI / 2;
  alt.position.set(0, 0.25, 0.42);
  const belt = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.02, 8, 64), new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.9 }));
  belt.rotation.y = Math.PI / 2;
  belt.scale.set(1, 1.15, 0.8);
  belt.position.set(0, -0.02, 0.12);
  front.add(pulley, alt, belt);
  front.position.x = 0.92;
  add(front, new THREE.Vector3(0.7, 0, 0));

  const flywheel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 64), steel());
  flywheel.rotation.z = Math.PI / 2;
  flywheel.position.set(-0.92, -0.35, 0);
  add(flywheel, new THREE.Vector3(-0.7, 0, 0));

  engine.scale.setScalar(0.9);
  const fb = firstBank as { head: THREE.Object3D; cover: THREE.Object3D; piston: THREE.Object3D | null; pipe: THREE.Object3D } | null;
  const engineParts = [
    part("Engine block", "Houses the cylinders: the engine's main structure.", 1, centerOf(block, 0.2), block),
    part("Crankshaft", "Turns the pistons' up-and-down motion into rotation.", 1, centerOf(crank), crank),
    part("Intake manifold", "Delivers air to every cylinder.", 1, centerOf(intake, 0.3), intake),
    ...(fb ? [part("Valve covers", "Seal the valvetrain on top of the cylinder heads.", 1, centerOf(fb.cover, 0.4), fb.cover)] : []),
    ...(fb?.piston ? [part("Pistons", "Driven down by combustion to power the crankshaft.", 2, centerOf(fb.piston), fb.piston)] : []),
    ...(fb ? [part("Cylinder heads", "Hold the valves and spark plugs above each cylinder.", 2, centerOf(fb.head), fb.head)] : []),
    ...(fb ? [part("Exhaust headers", "Carry hot exhaust gases away from the cylinders.", 2, centerOf(fb.pipe), fb.pipe)] : []),
    part("Throttle body", "Valve that controls how much air enters the engine.", 2, centerOf(throttle), throttle),
    part("Oil pan", "Reservoir that holds and cools the engine oil.", 2, centerOf(oilPan), oilPan),
    part("Flywheel", "Smooths rotation and connects to the transmission.", 2, centerOf(flywheel), flywheel),
    part("Alternator", "Generates electricity and charges the battery.", 2, centerOf(alt), alt),
    part("Drive belt", "Turns the alternator and pumps from the crankshaft.", 2, centerOf(belt), belt),
  ];
  return {
    content: engine,
    radius: 1.3,
    parts: engineParts,
    explode: (a) => explodeParts(parts, a),
    update(dt) {
      crank.rotation.x += dt * 4;
      pulley.rotation.y += dt * 4;
      flywheel.rotation.y += dt * 4;
    },
  };
}
