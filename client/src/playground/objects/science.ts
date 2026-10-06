import * as THREE from "three";
import type { BuiltObject } from "./types";
import { HOLO_CYAN, edgeLines, glowSprite, holoMaterial } from "../holo";

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
function heartGeometry(): THREE.ExtrudeGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, -0.95);
  s.bezierCurveTo(-0.35, -0.6, -1.05, -0.25, -1.0, 0.25);
  s.bezierCurveTo(-0.95, 0.75, -0.3, 0.95, 0, 0.5);
  s.bezierCurveTo(0.3, 0.95, 0.95, 0.75, 1.0, 0.25);
  s.bezierCurveTo(1.05, -0.25, 0.35, -0.6, 0, -0.95);
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.35, bevelEnabled: true, bevelThickness: 0.28, bevelSize: 0.22, bevelSegments: 10, curveSegments: 48 });
  geo.center();
  return geo;
}

export function buildHeart(): BuiltObject {
  const group = new THREE.Group();
  const geo = heartGeometry();
  const muscle = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc8283a, emissive: 0x3a0610, roughness: 0.45, metalness: 0.1 }));
  muscle.castShadow = true;
  const shell = new THREE.Mesh(geo, holoMaterial(0xff6a7a, { opacity: 0.7, fresnel: 2.5, scan: 0.5 }));
  shell.scale.setScalar(1.01);
  shell.userData.noPick = true;
  const heart = new THREE.Group();
  heart.add(muscle, shell);
  heart.rotation.z = -0.35;

  // Great vessels
  const vesselMat = new THREE.MeshStandardMaterial({ color: 0xb02234, emissive: 0x2a040c, roughness: 0.5 });
  const aorta = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0.1, 0.4, 0), new THREE.Vector3(0.15, 0.95, 0), new THREE.Vector3(-0.25, 1.15, 0), new THREE.Vector3(-0.55, 0.85, 0)]), 64, 0.13, 16),
    vesselMat,
  );
  const vein = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([new THREE.Vector3(0.45, 0.35, 0.05), new THREE.Vector3(0.6, 0.85, 0.1), new THREE.Vector3(0.55, 1.15, 0.05)]), 48, 0.09, 12), new THREE.MeshStandardMaterial({ color: 0x3e5fd0, emissive: 0x08133a, roughness: 0.5 }));
  group.add(heart, aorta, vein);
  group.scale.setScalar(0.85);
  return {
    content: group,
    radius: 1.2,
    update(_dt, t) {
      // ~72 bpm: quick contraction then relaxation
      const phase = (t * 1.2) % 1;
      const beat = phase < 0.15 ? Math.sin((phase / 0.15) * Math.PI) : phase > 0.25 && phase < 0.38 ? 0.5 * Math.sin(((phase - 0.25) / 0.13) * Math.PI) : 0;
      heart.scale.setScalar(1 + beat * 0.06);
    },
  };
}

export function buildBrain(): BuiltObject {
  const geo = new THREE.SphereGeometry(1, 160, 120);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Gyri / sulci folds
    const folds =
      Math.sin(v.x * 13 + Math.sin(v.y * 9) * 1.7) * Math.sin(v.y * 12 + Math.sin(v.z * 8) * 1.4) * Math.sin(v.z * 11 + Math.sin(v.x * 7) * 1.2);
    let r = 1 + folds * 0.045;
    // Longitudinal fissure between hemispheres
    r *= 1 - 0.16 * Math.exp(-(v.x * v.x) / 0.004) * (v.y > -0.3 ? 1 : 0.3);
    // Flatter underside
    if (v.y < -0.35) r *= 1 - (-0.35 - v.y) * 0.35;
    v.multiplyScalar(r);
    v.set(v.x * 0.82, v.y * 0.7, v.z * 1.05);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();

  const group = new THREE.Group();
  const cortex = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xd8c3cf, emissive: 0x1a1020, roughness: 0.55, metalness: 0.05 }));
  cortex.castShadow = true;
  const shell = new THREE.Mesh(geo, holoMaterial(HOLO_CYAN, { opacity: 0.45, fresnel: 2.4, scan: 0.6 }));
  shell.scale.setScalar(1.01);
  shell.userData.noPick = true;
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.08, 0.6, 24), new THREE.MeshStandardMaterial({ color: 0xc9b2bf, roughness: 0.6 }));
  stem.position.set(0, -0.62, -0.25);
  stem.rotation.x = 0.35;
  const cerebellum = new THREE.Mesh(new THREE.SphereGeometry(0.32, 48, 32), new THREE.MeshStandardMaterial({ color: 0xcdb6c4, roughness: 0.6 }));
  cerebellum.scale.set(1.3, 0.7, 0.9);
  cerebellum.position.set(0, -0.45, -0.68);
  group.add(cortex, shell, stem, cerebellum, edgeLines(new THREE.IcosahedronGeometry(1.12, 2), HOLO_CYAN, 0.08, 1));
  return { content: group, radius: 1.2 };
}
