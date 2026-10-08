import * as THREE from "three";

/** A labelled point on a model, for AR mode labels and the phone's second screen. */
export interface PartAnchor {
  id: string;
  name: string;
  info?: string;
  /** 1 = shown zoomed out (major parts); 2 = appears as you zoom in. */
  level: 1 | 2;
  /** Follows the part (explode, animation) because it is a child of it. */
  anchor: THREE.Object3D;
  /** The meshes that make up the part (highlighted when the part is focused). */
  meshes?: THREE.Mesh[];
  custom?: boolean;
}

export const partId = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);

/** Anchor at a fixed point in `parent`'s local space. */
export function at(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  const a = new THREE.Object3D();
  a.position.set(x, y, z);
  a.userData.noPick = true;
  parent.add(a);
  return a;
}

/**
 * Bounding box of what you can actually see: hidden objects (thruster flames, picking
 * proxies with invisible materials) don't count, unlike Box3.setFromObject.
 */
export function visibleBox(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const mat = m.material as THREE.Material | THREE.Material[];
    if (!Array.isArray(mat) && mat && mat.visible === false) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    tmp.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
    box.union(tmp);
  });
  return box.isEmpty() ? new THREE.Box3().setFromObject(root) : box;
}

/** Anchor at the centre of an object's geometry (call once the model is assembled). */
export function centerOf(obj: THREE.Object3D, lift = 0): THREE.Object3D {
  const root = rootOf(obj);
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const c = box.getCenter(new THREE.Vector3());
  c.y += (box.max.y - box.min.y) * lift;
  const a = new THREE.Object3D();
  a.userData.noPick = true;
  obj.add(a);
  a.position.copy(obj.worldToLocal(c));
  return a;
}

function rootOf(o: THREE.Object3D): THREE.Object3D {
  while (o.parent) o = o.parent;
  return o;
}

export function part(name: string, info: string, level: 1 | 2, anchor: THREE.Object3D, meshOf?: THREE.Object3D): PartAnchor {
  const meshes: THREE.Mesh[] = [];
  meshOf?.traverse((o) => (o as THREE.Mesh).isMesh && meshes.push(o as THREE.Mesh));
  return { id: partId(name), name, info, level, anchor, meshes: meshes.length ? meshes : undefined };
}
