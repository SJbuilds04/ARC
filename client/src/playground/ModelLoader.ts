import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import type { LibraryModel } from "@shared/types";
import type { BuiltObject } from "./objects/types";
import { at, centerOf, partId, type PartAnchor } from "./objects/parts";

let gltf: GLTFLoader | null = null;
function gltfLoader(): GLTFLoader {
  if (gltf) return gltf;
  const draco = new DRACOLoader().setDecoderPath("/draco/");
  gltf = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  return gltf;
}

/** Raw file → scene graph, by format. */
async function loadRaw(model: LibraryModel): Promise<THREE.Object3D> {
  const url = `/api/models/${encodeURIComponent(model.file)}`;
  switch (model.format) {
    case "glb":
    case "gltf":
      return (await gltfLoader().loadAsync(url)).scene;
    case "obj":
      return new OBJLoader().loadAsync(url);
    case "fbx":
      return new FBXLoader().loadAsync(url);
    case "stl": {
      const geo = await new STLLoader().loadAsync(url);
      geo.computeVertexNormals();
      const hasColor = Boolean(geo.getAttribute("color"));
      return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: hasColor ? 0xffffff : 0xb9c4cf, vertexColors: hasColor, metalness: 0.2, roughness: 0.55 }));
    }
  }
}

/** Names exporters give to things nobody named. */
const MEANINGLESS = /^(mesh|object|node|group|geometry|geom|polysurface|poly|cube|sphere|cylinder|plane|torus|cone|default|defaultmaterial|material|mat|primitive|root|rootnode|scene|model|sketchfab|gltf|obj|fbx|stl|untitled|body|shape|part|component|instance|null|empty|armature|bone)$/i;

/** "Left_Ventricle_001" → "Left Ventricle"; meaningless names → null. */
export function cleanPartName(raw: string): string | null {
  const name = raw
    .replace(/\.(\d+)$/, "")
    .replace(/[_\-.:]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b(\d+|lod\d*|low|high|mesh|geo|primitive\d*|mat)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length < 3 || !/[a-z]{3}/i.test(name) || MEANINGLESS.test(name.replace(/\s+/g, ""))) return null;
  return name.replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 60);
}

const cache = new Map<string, Promise<THREE.Object3D>>();

/**
 * Load an imported model as a playground object: centred, scaled to a unit radius, shadowed,
 * with labelled parts from its named meshes plus the user's pinned labels.
 */
export async function buildImported(model: LibraryModel): Promise<BuiltObject> {
  const key = `${model.file}:${model.size}`;
  if (!cache.has(key)) cache.set(key, loadRaw(model));
  let raw: THREE.Object3D;
  try {
    raw = (await cache.get(key)!).clone(true);
  } catch (err) {
    cache.delete(key);
    throw err;
  }

  // Normalise: centre on the origin, fit inside a sphere of radius 1.
  raw.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(raw);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const fit = new THREE.Group();
  fit.add(raw);
  raw.position.sub(sphere.center);
  fit.scale.setScalar(sphere.radius > 0 ? 1 / sphere.radius : 1);
  const content = new THREE.Group();
  content.add(fit);

  const meshes: THREE.Mesh[] = [];
  content.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // OBJ/FBX often ship flat Phong/Lambert materials: upgrade so they react to the studio lighting.
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const upgraded = mats.map((m) => {
      if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial) return m;
      const old = m as THREE.MeshPhongMaterial;
      return new THREE.MeshStandardMaterial({ color: old.color ?? 0xb9c4cf, map: old.map ?? null, metalness: 0.15, roughness: 0.6, transparent: old.transparent, opacity: old.opacity ?? 1, side: old.side });
    });
    mesh.material = Array.isArray(mesh.material) ? upgraded : upgraded[0];
    meshes.push(mesh);
  });

  return { content, radius: 1.02, parts: partsOf(model, content, fit, meshes), explode: exploder(content, meshes) };
}

/** Named meshes (or their nearest named parent) become labelled parts; pinned labels are added. */
function partsOf(model: LibraryModel, content: THREE.Object3D, fit: THREE.Object3D, meshes: THREE.Mesh[]): PartAnchor[] {
  const groups = new Map<string, { name: string; meshes: THREE.Mesh[]; volume: number }>();
  for (const mesh of meshes) {
    let name: string | null = null;
    for (let o: THREE.Object3D | null = mesh; o && o !== content; o = o.parent) {
      name = cleanPartName(o.name);
      if (name) break;
    }
    if (!name) continue;
    const box = new THREE.Box3().setFromObject(mesh);
    const size = box.getSize(new THREE.Vector3());
    const g = groups.get(name) ?? { name, meshes: [], volume: 0 };
    g.meshes.push(mesh);
    g.volume += size.x * size.y * size.z;
    groups.set(name, g);
  }
  // One giant part (e.g. the whole model under one name) isn't a useful label.
  const list = [...groups.values()].filter((g) => groups.size > 1 || g.meshes.length < meshes.length).sort((a, b) => b.volume - a.volume).slice(0, 40);
  const parts: PartAnchor[] = list.map((g, i) => {
    const biggest = g.meshes.reduce((a, b) => (new THREE.Box3().setFromObject(a).getSize(new THREE.Vector3()).lengthSq() >= new THREE.Box3().setFromObject(b).getSize(new THREE.Vector3()).lengthSq() ? a : b));
    return { id: partId(g.name), name: g.name, info: model.partInfo[g.name], level: i < 6 ? 1 : 2, anchor: centerOf(biggest), meshes: g.meshes };
  });
  // User-pinned labels live in the normalised (radius 1) space.
  for (const l of model.labels) {
    parts.push({ id: l.id, name: l.name, info: l.info ?? model.partInfo[l.name], level: 1, anchor: at(content, l.pos[0], l.pos[1], l.pos[2]), custom: true });
  }
  void fit;
  return parts;
}

/** Generic exploded view: every mesh slides away from the model's centre. */
function exploder(content: THREE.Object3D, meshes: THREE.Mesh[]): ((amount: number) => void) | undefined {
  if (meshes.length < 2) return undefined;
  content.updateMatrixWorld(true);
  const centre = new THREE.Box3().setFromObject(content).getCenter(new THREE.Vector3());
  const items = meshes.map((mesh) => {
    const c = new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
    const dirWorld = c.sub(centre);
    if (dirWorld.lengthSq() < 1e-6) dirWorld.set(0, 1, 0).multiplyScalar(0.01);
    // Convert the outward direction into the mesh parent's space.
    const parent = mesh.parent!;
    const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
    const a = new THREE.Vector3().applyMatrix4(inv);
    const b = dirWorld.clone().multiplyScalar(0.9).applyMatrix4(inv);
    return { mesh, home: mesh.position.clone(), out: b.sub(a) };
  });
  return (amount) => {
    for (const it of items) it.mesh.position.copy(it.home).addScaledVector(it.out, amount);
  };
}
