import * as THREE from "three";
import type { BuiltObject, ModelAction } from "./types";
import { at, part } from "./parts";
import { glowSprite, holoGain } from "../holo";

/**
 * Miniature arc reactors (ARC's own models): brushed steel casing, copper coil windings,
 * a glowing core and a glass cover. Interactive: power up/down, open the casing.
 */

const TAU = Math.PI * 2;
const steel = () => new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 1, roughness: 0.32 });
const darkSteel = () => new THREE.MeshStandardMaterial({ color: 0x3a4048, metalness: 0.9, roughness: 0.38 });
const copper = () => new THREE.MeshStandardMaterial({ color: 0xb8683a, metalness: 1, roughness: 0.3 });

function buildReactor(kind: "round" | "triangle"): BuiltObject {
  const content = new THREE.Group();
  const glowColor = new THREE.Color(kind === "round" ? 0xbfefff : 0xd8f6ff);
  const glow = new THREE.MeshBasicMaterial({ color: glowColor, toneMapped: false });
  const softGlow = new THREE.MeshBasicMaterial({ color: glowColor, toneMapped: false, transparent: true, opacity: 0.5 });

  // Back housing
  const housing = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.04, 0.32, 72), darkSteel());
  housing.rotation.x = Math.PI / 2;
  housing.position.z = -0.16;
  content.add(housing);

  // Outer ring with bolts
  const casing = new THREE.Group();
  content.add(casing);
  const outer = new THREE.Mesh(new THREE.TorusGeometry(0.94, 0.09, 24, 96), steel());
  casing.add(outer);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * TAU;
    const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.05, 6), darkSteel());
    bolt.rotation.x = Math.PI / 2;
    bolt.position.set(Math.cos(a) * 0.94, Math.sin(a) * 0.94, 0.09);
    casing.add(bolt);
  }

  // Copper coil windings
  const coils = new THREE.Group();
  content.add(coils);
  const n = kind === "round" ? 10 : 9;
  const coilMat = copper();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const coil = new THREE.Group();
    coil.position.set(Math.cos(a) * 0.62, Math.sin(a) * 0.62, 0);
    coil.rotation.z = a;
    for (let w = 0; w < 9; w++) {
      const wind = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.016, 8, 24), coilMat);
      wind.rotation.y = Math.PI / 2;
      wind.position.x = -0.12 + w * 0.03;
      coil.add(wind);
    }
    const core = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.08), darkSteel());
    coil.add(core);
    coils.add(coil);
  }
  // Inner contact ring + spokes
  const inner = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.045, 16, 72), steel());
  content.add(inner);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + Math.PI / n;
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.025, 0.04), darkSteel());
    spoke.position.set(Math.cos(a) * 0.62, Math.sin(a) * 0.62, -0.03);
    spoke.rotation.z = a;
    content.add(spoke);
  }

  // Core
  const coreGroup = new THREE.Group();
  content.add(coreGroup);
  let coreMesh: THREE.Mesh;
  if (kind === "round") {
    coreMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.12, 48), glow);
    coreMesh.rotation.x = Math.PI / 2;
    const ringIn = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.02, 10, 48), darkSteel());
    ringIn.position.z = 0.07;
    coreGroup.add(ringIn);
  } else {
    // "new element": glowing triangle in a ring of segments
    const tri = new THREE.Shape();
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i / 3) * TAU;
      const x = Math.cos(a) * 0.3;
      const y = -Math.sin(a) * 0.3;
      if (i === 0) tri.moveTo(x, y);
      else tri.lineTo(x, y);
    }
    tri.closePath();
    const hole = new THREE.Path();
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + (i / 3) * TAU;
      const x = Math.cos(a) * 0.17;
      const y = -Math.sin(a) * 0.17;
      if (i === 0) hole.moveTo(x, y);
      else hole.lineTo(x, y);
    }
    tri.holes.push(hole);
    coreMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(tri, { depth: 0.08, bevelEnabled: true, bevelSize: 0.01, bevelThickness: 0.01 }), glow);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(0.3, 48), softGlow);
    disc.position.z = -0.01;
    coreGroup.add(disc);
  }
  coreGroup.add(coreMesh);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSprite("rgba(150,225,255,1)"), blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  halo.scale.setScalar(1.3);
  halo.position.z = 0.1;
  halo.userData.noPick = true;
  coreGroup.add(halo);
  const light = new THREE.PointLight(glowColor, 2.2, 3, 2);
  light.position.z = 0.4;
  content.add(light);

  // Glass cover
  const cover = new THREE.Mesh(
    new THREE.SphereGeometry(0.95, 64, 16, 0, TAU, 0, 0.42),
    new THREE.MeshPhysicalMaterial({ color: 0xdff6ff, metalness: 0, roughness: 0.05, transmission: 0.92, thickness: 0.05, transparent: true, opacity: 0.35, clearcoat: 1 }),
  );
  cover.rotation.x = Math.PI / 2;
  cover.position.z = -0.75;
  cover.userData.noPick = true;
  casing.add(cover);

  // ─── actions ───
  const state = { power: true, casing: false };
  const anim = { power: 1, open: 0 };
  let exploded = 0;
  const actions: ModelAction[] = [
    { id: "power", label: "Power", kind: "toggle", words: ["power", "reactor", "core", "energy"], value: true, parts: [coreGroup] },
    { id: "casing", label: "Casing", kind: "toggle", words: ["casing", "cover", "case", "glass", "housing"], value: false, parts: [casing] },
  ];

  const parts = [
    part("Core", kind === "round" ? "Palladium core where the reaction glows." : "Triangular new-element core: cleaner, stronger output.", 1, at(coreGroup, 0, 0, 0.12), coreGroup),
    part("Copper coils", "Electromagnetic windings that contain and shape the plasma.", 1, at(coils, 0.62, 0.0, 0.1), coils),
    part("Casing ring", "Steel housing bolted around the reactor.", 2, at(outer, 0, 0.94, 0.1), outer),
    part("Glass cover", "Protective dome over the core.", 2, at(casing, 0.4, 0.4, 0.25)),
    part("Contact ring", "Carries power from the core to the suit.", 2, at(inner, 0.38, 0, 0.05), inner),
  ];

  content.rotation.x = -0.2;
  const group = new THREE.Group();
  group.add(content);
  return {
    content: group,
    radius: 1.15,
    parts,
    actions,
    act(id, value) {
      if (id === "power") state.power = Boolean(value);
      if (id === "casing") state.casing = Boolean(value);
    },
    explode(a) {
      exploded = a;
      coils.position.z = 0.3 * a;
      coreGroup.position.z = 0.15 * a;
    },
    update(dt, t) {
      const k = 1 - Math.exp(-dt * 3);
      anim.power += ((state.power ? 1 : 0) - anim.power) * k;
      anim.open += ((state.casing ? 1 : 0) - anim.open) * k;
      casing.position.z = anim.open * 0.7 + exploded * 0.6;
      casing.rotation.z = anim.open * 0.6;
      const flick = 0.92 + 0.08 * Math.sin(t * 13) * Math.sin(t * 7.3);
      const g = holoGain.value; // follows the brightness control (low by default)
      const p = anim.power * flick * g;
      glow.color.copy(glowColor).multiplyScalar(0.08 + 0.92 * p);
      softGlow.opacity = 0.5 * p;
      (halo.material as THREE.SpriteMaterial).opacity = p;
      light.intensity = 0.9 * p;
      coreGroup.rotation.z += dt * 0.4 * anim.power;
      coilMat.emissive.setRGB(0.25 * p, 0.08 * p, 0.02 * p);
    },
  };
}

export const buildArcReactor = () => buildReactor("round");
export const buildArcReactor2 = () => buildReactor("triangle");
