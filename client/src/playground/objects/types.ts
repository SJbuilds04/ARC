import type * as THREE from "three";
import type { CountryInfo } from "@shared/catalog";

/** What an object builder returns. The ObjectManager wraps it in a transform root. */
export interface BuiltObject {
  content: THREE.Object3D;
  /** Bounding radius at scale 1 — used for placement, selection rings and the spawn scan. */
  radius: number;
  /** Initial object-specific properties (e.g. atmosphere: true). */
  props?: Record<string, boolean>;
  setProperty?(prop: string, value: boolean): boolean;
  /** 0 = assembled … 1 = fully exploded. */
  explode?(amount: number): void;
  /** Highlight a country; returns the root rotation that faces it toward the viewer. */
  showLocation?(country: CountryInfo): Promise<THREE.Euler | null>;
  update?(dt: number, t: number): void;
}

export type Builder = () => BuiltObject;
