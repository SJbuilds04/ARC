import type * as THREE from "three";
import type { CountryInfo } from "@shared/catalog";
import type { PartAnchor } from "./parts";

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
  /** Labelled parts for Deep Dive AR mode. */
  parts?: PartAnchor[];
  /** Things you can do to the model (open the faceplate, power the reactor, paint it…). */
  actions?: ModelAction[];
  /** Apply an action's new value (the model animates toward it in update()). */
  act?(id: string, value: boolean | string): void;
  /**
   * Models with their own renderer (the black hole) can't take Deep Dive's hologram materials,
   * so they switch looks themselves: `holo` for AR / wireframe / x-ray, in the chosen colour.
   */
  setStyle?(look: { holo: boolean; color: string }): void;
}

export interface ModelAction {
  id: string;
  label: string;
  kind: "toggle" | "choice" | "trigger";
  options?: string[];
  /** Words that name it by voice. */
  words?: string[];
  value: boolean | string;
  /** Pinch / click one of these to trigger the action with your hand. */
  parts?: THREE.Object3D[];
}

export type Builder = () => BuiltObject;
