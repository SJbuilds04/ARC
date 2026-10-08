import * as THREE from "three";
import type { Builder, BuiltObject } from "./types";
import { buildEarth, buildMars, buildMoon, buildSaturn, buildSolarSystem, buildSun } from "./space";
import { buildAtom, buildBrain, buildDna, buildHeart } from "./science";
import { buildCar, buildEngine } from "./machines";
import { holoMesh } from "../holo";
import { buildHulkbuster, buildIronSpider, buildMark3, buildMark42, buildMark50, buildMark85, buildSpiderClassic } from "./armor";
import { buildArcReactor, buildArcReactor2 } from "./reactor";
import { buildBlackHole } from "./blackhole";
import { buildDoubleSlit, buildNewtonCradle, buildPrism } from "./experiments";
import { buildQuantumComputer, buildTesseract } from "./futuristic";
import { buildGammaRadiation, buildLaser, buildPhoton, buildXRayMachine } from "./radiation";
import { buildCollider, buildPulsar, buildTokamak } from "./frontier";

const primitive = (geometry: THREE.BufferGeometry, radius: number, edgeThreshold = 22): Builder => () => ({
  content: holoMesh(geometry, undefined, edgeThreshold),
  radius,
  props: { wireframe: false },
  setProperty(prop, value) {
    if (prop !== "wireframe") return false;
    this.content.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && "wireframe" in m && m.type === "MeshStandardMaterial") m.wireframe = value;
    });
    return true;
  },
});

/** Kind → builder. New objects are added here (and in shared/catalog.ts). */
export const BUILDERS: Record<string, Builder> = {
  earth: buildEarth,
  moon: buildMoon,
  mars: buildMars,
  saturn: buildSaturn,
  sun: buildSun,
  solar_system: buildSolarSystem,
  atom: buildAtom,
  dna: buildDna,
  heart: buildHeart,
  brain: buildBrain,
  car: buildCar,
  engine: buildEngine,
  mark3: buildMark3,
  mark42: buildMark42,
  mark50: buildMark50,
  mark85: buildMark85,
  hulkbuster: buildHulkbuster,
  arc_reactor: buildArcReactor,
  arc_reactor2: buildArcReactor2,
  spider_classic: buildSpiderClassic,
  iron_spider: buildIronSpider,
  black_hole: buildBlackHole,
  double_slit: buildDoubleSlit,
  newton_cradle: buildNewtonCradle,
  prism: buildPrism,
  tesseract: buildTesseract,
  quantum_computer: buildQuantumComputer,
  xray_machine: buildXRayMachine,
  gamma_rays: buildGammaRadiation,
  photon: buildPhoton,
  laser: buildLaser,
  pulsar: buildPulsar,
  collider: buildCollider,
  tokamak: buildTokamak,
  cube: primitive(new THREE.BoxGeometry(1.3, 1.3, 1.3), 1.15),
  sphere: primitive(new THREE.IcosahedronGeometry(0.95, 4), 0.95, 60),
  torus: primitive(new THREE.TorusKnotGeometry(0.62, 0.2, 220, 28), 0.95, 60),
  pyramid: primitive(new THREE.ConeGeometry(0.95, 1.4, 4), 1),
};

export function build(kind: string): BuiltObject | null {
  const builder = BUILDERS[kind];
  return builder ? builder() : null;
}
