import * as THREE from "three";
import type { BuiltObject } from "./types";
import { HOLO_CYAN, edgeLines, holoMaterial, holoMesh } from "../holo";

interface Part {
  obj: THREE.Object3D;
  home: THREE.Vector3;
  out: THREE.Vector3;
}

const bodyMat = () => new THREE.MeshStandardMaterial({ color: 0x0c2036, metalness: 0.85, roughness: 0.28, emissive: 0x020a14 });
const metalMat = () => new THREE.MeshStandardMaterial({ color: 0x6f8296, metalness: 0.9, roughness: 0.35 });

function withEdges(mesh: THREE.Mesh, opacity = 0.5, threshold = 25) {
  mesh.castShadow = true;
  mesh.add(edgeLines(mesh.geometry, HOLO_CYAN, opacity, threshold));
  return mesh;
}

function explodeParts(parts: Part[], amount: number) {
  for (const p of parts) p.obj.position.copy(p.home).addScaledVector(p.out, amount);
}

export function buildCar(): BuiltObject {
  const car = new THREE.Group();
  const width = 1.7;

  // Side profile of a low coupe, extruded across the car's width.
  const profile = new THREE.Shape(
    [
      [-2.1, 0.32], [-2.18, 0.62], [-2.0, 0.82], [-1.0, 0.92], [-0.45, 1.3], [0.7, 1.34], [1.35, 0.98], [2.0, 0.84], [2.18, 0.56], [2.08, 0.32],
    ].map(([x, y]) => new THREE.Vector2(x, y)),
  );
  const bodyGeo = new THREE.ExtrudeGeometry(profile, { depth: width, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 4 });
  bodyGeo.translate(0, 0, -width / 2);
  const body = withEdges(new THREE.Mesh(bodyGeo, bodyMat()), 0.55, 30);

  const glassShape = new THREE.Shape([[-0.85, 0.95], [-0.38, 1.27], [0.66, 1.3], [1.22, 0.98]].map(([x, y]) => new THREE.Vector2(x, y)));
  const glassGeo = new THREE.ExtrudeGeometry(glassShape, { depth: width * 0.86, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.05, bevelSegments: 2 });
  glassGeo.translate(0, 0.02, -(width * 0.86) / 2);
  const cabin = new THREE.Mesh(glassGeo, new THREE.MeshStandardMaterial({ color: 0x0a2a44, metalness: 0.2, roughness: 0.05, transparent: true, opacity: 0.75, emissive: 0x06213a }));
  cabin.add(edgeLines(glassGeo, 0x9fe9ff, 0.6, 30));

  const parts: Part[] = [];
  const wheelGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.3, 40);
  wheelGeo.rotateX(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.32, 10);
  rimGeo.rotateX(Math.PI / 2);
  for (const [x, z] of [
    [1.35, width / 2],
    [1.35, -width / 2],
    [-1.35, width / 2],
    [-1.35, -width / 2],
  ]) {
    const wheel = new THREE.Group();
    const tire = new THREE.Mesh(wheelGeo, new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 0.9 }));
    tire.castShadow = true;
    const rim = withEdges(new THREE.Mesh(rimGeo, metalMat()), 0.7, 10);
    wheel.add(tire, rim);
    wheel.position.set(x, 0.36, z);
    car.add(wheel);
    parts.push({ obj: wheel, home: wheel.position.clone(), out: new THREE.Vector3(x * 0.15, -0.1, Math.sign(z) * 0.9) });
  }

  const lightMat = new THREE.MeshBasicMaterial({ color: 0xcff6ff });
  const tailMat = new THREE.MeshBasicMaterial({ color: 0xff3045 });
  for (const z of [0.55, -0.55]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.42), lightMat);
    head.position.set(2.17, 0.66, z);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.5), tailMat);
    tail.position.set(-2.2, 0.68, z);
    car.add(head, tail);
  }
  car.add(body, cabin);
  parts.push({ obj: cabin, home: cabin.position.clone(), out: new THREE.Vector3(0, 0.75, 0) });

  const shell = new THREE.Mesh(bodyGeo, holoMaterial(HOLO_CYAN, { opacity: 0.35, fresnel: 3, scan: 0.7 }));
  shell.userData.noPick = true;
  car.add(shell);

  car.position.y = -0.7;
  const wrapper = new THREE.Group();
  wrapper.add(car);
  wrapper.scale.setScalar(0.62);
  wrapper.rotation.y = -0.5;
  return { content: wrapper, radius: 1.4, explode: (a) => explodeParts(parts, a) };
}

export function buildEngine(): BuiltObject {
  const engine = new THREE.Group();
  const parts: Part[] = [];
  const add = (obj: THREE.Object3D, out: THREE.Vector3) => {
    engine.add(obj);
    parts.push({ obj, home: obj.position.clone(), out });
  };

  const block = withEdges(new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.7, 0.9), bodyMat()));
  block.position.y = -0.1;
  engine.add(block);

  // Two banks of four cylinders at ±45°.
  for (const side of [1, -1]) {
    const bank = new THREE.Group();
    bank.position.set(0, 0.35, side * 0.32);
    bank.rotation.x = side * (Math.PI / 4);
    const head = withEdges(new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.18, 0.5), bodyMat()));
    head.position.y = 0.62;
    bank.add(head);
    for (let i = 0; i < 4; i++) {
      const x = -0.6 + i * 0.4;
      const cyl = withEdges(new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.6, 24), metalMat()), 0.35, 40);
      cyl.position.set(x, 0.25, 0);
      bank.add(cyl);
      const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.16, 20), new THREE.MeshStandardMaterial({ color: 0xc9d6e2, metalness: 0.95, roughness: 0.2 }));
      piston.position.set(x, 0.2, 0);
      bank.add(piston);
      parts.push({ obj: piston, home: piston.position.clone(), out: new THREE.Vector3(0, 0.5, 0) });
    }
    add(bank, new THREE.Vector3(0, 0.45, side * 0.55));
    parts.push({ obj: head, home: head.position.clone(), out: new THREE.Vector3(0, 0.6, 0) });
  }

  const crank = withEdges(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.1, 16), metalMat()), 0.6, 40);
  crank.rotation.z = Math.PI / 2;
  crank.position.y = -0.5;
  add(crank, new THREE.Vector3(0, -0.6, 0));

  const pulley = withEdges(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.1, 40), metalMat()), 0.6, 10);
  pulley.rotation.z = Math.PI / 2;
  pulley.position.set(1.1, -0.35, 0);
  add(pulley, new THREE.Vector3(0.7, 0, 0));

  const intake = holoMesh(new THREE.BoxGeometry(1.4, 0.16, 0.34));
  intake.position.y = 0.72;
  add(intake, new THREE.Vector3(0, 0.9, 0));

  engine.scale.setScalar(0.9);
  return {
    content: engine,
    radius: 1.3,
    explode: (a) => explodeParts(parts, a),
    update(dt) {
      crank.rotation.x += dt * 4;
      pulley.rotation.x += dt * 4;
    },
  };
}
