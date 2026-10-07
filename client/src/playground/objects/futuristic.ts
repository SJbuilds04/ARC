import * as THREE from "three";
import type { BuiltObject, ModelAction } from "./types";
import { at, centerOf, part } from "./parts";
import { glowSprite, holoGain } from "../holo";

const TAU = Math.PI * 2;

// ─── Tesseract: a 4D hypercube rotating through the fourth dimension ───

export function buildTesseract(): BuiltObject {
  const verts4: number[][] = [];
  for (let i = 0; i < 16; i++) verts4.push([i & 1 ? 1 : -1, i & 2 ? 1 : -1, i & 4 ? 1 : -1, i & 8 ? 1 : -1]);
  const edges: [number, number][] = [];
  for (let a = 0; a < 16; a++) for (let b = a + 1; b < 16; b++) if ([0, 1, 2, 3].filter((k) => verts4[a][k] !== verts4[b][k]).length === 1) edges.push([a, b]);

  const content = new THREE.Group();
  const innerMat = new THREE.MeshBasicMaterial({ color: 0x6fe0ff, toneMapped: false });
  const outerMat = new THREE.MeshBasicMaterial({ color: 0xbfefff, toneMapped: false });
  const linkMat = new THREE.MeshBasicMaterial({ color: 0x3a8cff, toneMapped: false, transparent: true, opacity: 0.7 });
  const tube = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
  const edgeMeshes = edges.map(([a, b]) => {
    const w = verts4[a][3] === verts4[b][3] ? (verts4[a][3] > 0 ? outerMat : innerMat) : linkMat;
    const m = new THREE.Mesh(tube, w);
    content.add(m);
    return m;
  });
  const nodes = verts4.map(() => {
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 8), outerMat);
    content.add(s);
    return s;
  });
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSprite("rgba(90,190,255,1)"), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, opacity: 0.6 }));
  core.scale.setScalar(1.4);
  core.userData.noPick = true;
  content.add(core);
  const proxy = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), new THREE.MeshBasicMaterial({ visible: false }));
  content.add(proxy);

  const state = { rotate: true, plane: "XW + YW" };
  let speed = 1;
  let a1 = 0;
  let a2 = 0;
  const p3 = verts4.map(() => new THREE.Vector3());
  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const actions: ModelAction[] = [
    { id: "rotate", label: "4D rotation", kind: "toggle", words: ["rotation", "rotate", "spin", "4d"], value: true, parts: [proxy] },
    { id: "plane", label: "Rotation plane", kind: "choice", options: ["XW + YW", "XW", "ZW"], words: ["plane"], value: "XW + YW" },
  ];
  const parts = [
    part("Inner cube", "The 3D 'shadow' of the hypercube's far side (w = −1).", 1, at(content, 0, 0, 0)),
    part("Outer cube", "The near side (w = +1), larger in perspective.", 1, at(content, 0.62, 0.62, 0.62)),
    part("4D edges", "Edges running along the fourth dimension: 16 vertices, 32 edges.", 2, at(content, -0.45, 0.45, 0.45)),
  ];
  const project = () => {
    const c1 = Math.cos(a1), s1 = Math.sin(a1), c2 = Math.cos(a2), s2 = Math.sin(a2);
    verts4.forEach(([x0, y0, z0, w0], i) => {
      let x = x0, y = y0, z = z0, w = w0;
      if (state.plane !== "ZW") [x, w] = [x * c1 - w * s1, x * s1 + w * c1];
      if (state.plane === "XW + YW") [y, w] = [y * c2 - w * s2, y * s2 + w * c2];
      if (state.plane === "ZW") [z, w] = [z * c1 - w * s1, z * s1 + w * c1];
      const k = 1.6 / (3 - w); // 4D → 3D perspective
      p3[i].set(x * k * 0.55, y * k * 0.55, z * k * 0.55);
      nodes[i].position.copy(p3[i]);
    });
    edges.forEach(([a, b], i) => {
      const m = edgeMeshes[i];
      dir.subVectors(p3[b], p3[a]);
      const len = dir.length();
      m.position.addVectors(p3[a], p3[b]).multiplyScalar(0.5);
      m.scale.set(0.011, len, 0.011);
      m.quaternion.setFromUnitVectors(up, dir.divideScalar(len || 1));
    });
  };
  project();
  const group = new THREE.Group();
  group.add(content);
  return {
    content: group,
    radius: 1.15,
    parts,
    actions,
    act(id, value) {
      if (id === "rotate") state.rotate = Boolean(value);
      if (id === "plane") state.plane = String(value);
    },
    update(dt) {
      speed += ((state.rotate ? 1 : 0) - speed) * (1 - Math.exp(-dt * 3));
      a1 += dt * 0.7 * speed;
      a2 += dt * 0.45 * speed;
      content.rotation.y += dt * 0.15 * speed;
      const g = holoGain.value;
      innerMat.color.setRGB(0.44 * g, 0.88 * g, 1.0 * g);
      outerMat.color.setRGB(0.75 * g, 0.94 * g, 1.0 * g);
      project();
    },
  };
}

// ─── Quantum computer: dilution refrigerator "chandelier" ───

export function buildQuantumComputer(): BuiltObject {
  const content = new THREE.Group();
  const gold = new THREE.MeshPhysicalMaterial({ color: 0xd8a64a, metalness: 1, roughness: 0.22, clearcoat: 0.5 });
  const copperMat = new THREE.MeshStandardMaterial({ color: 0xc27a45, metalness: 1, roughness: 0.3 });
  const steelMat = new THREE.MeshStandardMaterial({ color: 0xc8ced6, metalness: 1, roughness: 0.18 });
  const plates = [
    { y: 1.0, r: 0.62, name: "50 K plate", info: "First cooling stage, about 50 kelvin." },
    { y: 0.72, r: 0.54, name: "4 K plate", info: "Pulse-tube stage: 4 kelvin, colder than liquid helium." },
    { y: 0.45, r: 0.46, name: "Still plate", info: "~800 millikelvin: helium-3 evaporates here." },
    { y: 0.2, r: 0.38, name: "Cold plate", info: "~100 millikelvin." },
    { y: -0.05, r: 0.3, name: "Mixing chamber", info: "~15 millikelvin: colder than outer space." },
  ];
  const chandelier = new THREE.Group();
  content.add(chandelier);
  const plateMeshes = plates.map((p) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, 0.035, 64), gold);
    m.position.y = p.y;
    m.castShadow = true;
    chandelier.add(m);
    return m;
  });
  // Rods between plates
  for (let i = 0; i < plates.length - 1; i++) {
    const a = plates[i];
    const b = plates[i + 1];
    for (let k = 0; k < 4; k++) {
      const ang = (k / 4) * TAU + 0.4;
      const r = b.r * 0.8;
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, a.y - b.y, 8), gold);
      rod.position.set(Math.cos(ang) * r, (a.y + b.y) / 2, Math.sin(ang) * r);
      chandelier.add(rod);
    }
  }
  // Coax lines spiralling down to the chip
  const coax = new THREE.Group();
  chandelier.add(coax);
  for (let c = 0; c < 8; c++) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 40; i++) {
      const f = i / 40;
      const y = 1.0 - f * 1.22;
      const rr = THREE.MathUtils.lerp(0.42, 0.06, f) + 0.025 * Math.sin(f * 30 + c);
      const ang = (c / 8) * TAU + f * 2.2;
      pts.push(new THREE.Vector3(Math.cos(ang) * rr, y, Math.sin(ang) * rr));
    }
    const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 0.008, 6), c % 2 ? copperMat : steelMat);
    coax.add(m);
  }
  // Quantum processor at the bottom
  const qpu = new THREE.Group();
  qpu.position.y = -0.24;
  chandelier.add(qpu);
  const mount = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.12, 32), gold);
  qpu.add(mount);
  const chip = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.012, 0.12), new THREE.MeshStandardMaterial({ color: 0x1b2230, metalness: 0.6, roughness: 0.3 }));
  chip.position.y = -0.066;
  qpu.add(chip);
  const qubitMat = new THREE.MeshBasicMaterial({ color: 0x6fe0ff, toneMapped: false });
  for (let i = 0; i < 9; i++) {
    const q = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.004, 0.014), qubitMat);
    q.position.set(((i % 3) - 1) * 0.032, -0.073, (Math.floor(i / 3) - 1) * 0.032);
    q.userData.keepMaterial = true;
    qpu.add(q);
  }
  // Top flange
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.08, 64), steelMat);
  top.position.y = 1.18;
  content.add(top);
  // Cryostat can (closes over everything)
  const can = new THREE.Mesh(
    new THREE.CylinderGeometry(0.7, 0.7, 1.45, 64, 1, true),
    new THREE.MeshPhysicalMaterial({ color: 0xd9dee5, metalness: 1, roughness: 0.15, side: THREE.DoubleSide }),
  );
  const canBottom = new THREE.Mesh(new THREE.CircleGeometry(0.7, 64), steelMat);
  canBottom.rotation.x = Math.PI / 2;
  canBottom.position.y = -0.72;
  const canGroup = new THREE.Group();
  canGroup.add(can, canBottom);
  canGroup.position.y = 0.45;
  content.add(canGroup);

  const state = { cryostat: false, qubits: true };
  const anim = { closed: 0, qubits: 1 };
  const actions: ModelAction[] = [
    { id: "cryostat", label: "Cryostat", kind: "toggle", words: ["cryostat", "can", "shield", "cover", "case", "close it"], value: false, parts: [canGroup, top] },
    { id: "qubits", label: "Qubits", kind: "toggle", words: ["qubits", "qubit", "processor", "chip", "compute"], value: true, parts: [qpu] },
  ];
  const parts = [
    ...plates.map((p, i) => part(p.name, p.info, i === 4 || i === 0 ? 1 : 2, at(plateMeshes[i], p.r, 0.02, 0), plateMeshes[i])),
    part("Quantum processor", "Superconducting qubits: superposition and entanglement at work.", 1, at(qpu, 0, -0.08, 0.07), qpu),
    part("Coax lines", "Microwave lines that control and read each qubit.", 2, centerOf(coax), coax),
  ];
  content.position.y = -0.45;
  const group = new THREE.Group();
  group.add(content);
  return {
    content: group,
    radius: 1.15,
    parts,
    actions,
    act(id, value) {
      if (id === "cryostat") state.cryostat = Boolean(value);
      if (id === "qubits") state.qubits = Boolean(value);
    },
    explode(a) {
      plateMeshes.forEach((m, i) => (m.position.y = plates[i].y + (2 - i) * 0.12 * a));
    },
    update(dt, t) {
      const k = 1 - Math.exp(-dt * 3);
      anim.closed += ((state.cryostat ? 1 : 0) - anim.closed) * k;
      anim.qubits += ((state.qubits ? 1 : 0) - anim.qubits) * k;
      // open = can lifted away above the flange
      canGroup.position.y = 0.45 + (1 - anim.closed) * 1.9;
      canGroup.visible = anim.closed > 0.02;
      const flick = 0.6 + 0.4 * Math.sin(t * 9) * Math.sin(t * 4.3);
      qubitMat.color.setRGB(0.1 + 0.33 * anim.qubits * flick, 0.25 + 0.63 * anim.qubits * flick, 0.35 + 0.65 * anim.qubits);
      chandelier.rotation.y += dt * 0.08;
    },
  };
}
