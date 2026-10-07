import * as THREE from "three";
import { catalogEntry, resolveCatalogId, resolveCountry } from "@shared/catalog";
import type { LibraryModel, PlaygroundAction, SceneObject, SceneSnapshot } from "@shared/types";
import { Emitter } from "../core/emitter";
import { build } from "./objects/factory";
import type { BuiltObject } from "./objects/types";
import { holoMaterial } from "./holo";
import { buildImported } from "./ModelLoader";

export interface ArcObject {
  id: string;
  kind: string;
  name: string;
  root: THREE.Group;
  built: BuiltObject;
  radius: number;
  props: Record<string, boolean | number | string>;
  target: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: number };
  spin: number;
  explode: number;
  explodeTarget: number;
  spawnT: number;
  removing: number | null;
}

interface ObjectEvents extends Record<string, unknown> {
  change: SceneSnapshot;
  selection: ArcObject | null;
  location: { name: string; items: { label: string; value: string }[] } | null;
  message: { level: "info" | "warning"; text: string };
  loaded: ArcObject;
}

const SLOTS = [
  new THREE.Vector3(0, 0.25, 0),
  new THREE.Vector3(-2.4, 0.25, -0.6),
  new THREE.Vector3(2.4, 0.25, -0.6),
  new THREE.Vector3(-1.3, 0.25, -2.4),
  new THREE.Vector3(1.3, 0.25, -2.4),
  new THREE.Vector3(0, 0.25, -3.6),
];
const MAX_OBJECTS = 12;
const Y_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * ObjectManager — owns playground objects and executes structured commands
 * (from JARVIS, gestures, mouse or UI buttons). Transforms are driven through
 * targets and eased every frame, so every input path animates the same way.
 */
export class ObjectManager extends Emitter<ObjectEvents> {
  readonly objects: ArcObject[] = [];
  selected: ArcObject | null = null;
  hovered: ArcObject | null = null;
  private seq = 0;
  private changeTimer: number | null = null;
  private readonly selectionRing: THREE.Mesh;
  private readonly hoverRing: THREE.Mesh;
  private readonly scanRings: { mesh: THREE.Mesh; obj: ArcObject }[] = [];
  /** Imported models by library id (wired to the shared library state). */
  modelLookup: (id: string) => LibraryModel | undefined = () => undefined;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly floorY: number,
    private readonly camera: THREE.Camera,
  ) {
    super();
    const ringGeo = new THREE.RingGeometry(0.94, 1, 96);
    ringGeo.rotateX(-Math.PI / 2);
    this.selectionRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x8fe6ff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.hoverRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x8fe6ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.selectionRing.visible = this.hoverRing.visible = false;
    scene.add(this.selectionRing, this.hoverRing);
  }

  // ─── Lifecycle ───

  spawn(kind: string, init?: Partial<SceneObject>, animate = true): ArcObject | null {
    const imported = kind.startsWith("m-") ? this.modelLookup(kind) : undefined;
    const resolved = imported ? kind : catalogEntry(kind) ? kind : resolveCatalogId(kind);
    if (!resolved) {
      this.emit("message", { level: "warning", text: `Unknown object "${kind}"` });
      return null;
    }
    if (this.objects.length >= MAX_OBJECTS) {
      this.emit("message", { level: "warning", text: "Playground is full — delete something first" });
      return null;
    }
    // Imported models load asynchronously into a placeholder (a holographic sphere until ready).
    const built = imported ? this.placeholder() : build(resolved);
    if (!built) return null;
    const entry = imported ? { name: imported.name } : catalogEntry(resolved)!;

    const root = new THREE.Group();
    root.add(built.content);
    const id = init?.id ?? `${resolved}-${(++this.seq).toString(36)}${Date.now().toString(36).slice(-3)}`;
    root.userData.arcId = id;

    const position = init?.position ? new THREE.Vector3(...init.position) : this.freeSlot();
    const quaternion = init?.rotation ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...init.rotation)) : new THREE.Quaternion();
    // New objects get a consistent footprint (e.g. the solar system starts smaller).
    const scale = init?.scale ?? Math.min(1, 1.35 / built.radius);
    root.position.copy(position);
    root.quaternion.copy(quaternion);
    root.scale.setScalar(animate ? 0.001 : scale);

    const obj: ArcObject = {
      id,
      kind: resolved,
      name: entry.name,
      root,
      built,
      radius: built.radius,
      props: { ...(built.props ?? {}) },
      target: { position, quaternion, scale },
      spin: 0,
      explode: 0,
      explodeTarget: 0,
      spawnT: animate ? 0 : 1,
      removing: null,
    };

    // Restore persisted properties.
    if (init?.props) {
      for (const [k, v] of Object.entries(init.props)) {
        if (k === "spin" && typeof v === "number") obj.spin = v;
        else if (k === "explode" && typeof v === "number") obj.explode = obj.explodeTarget = v;
        else if (typeof v === "boolean" && built.setProperty?.(k, v)) obj.props[k] = v;
        else if (k === "location" && typeof v === "string") void this.showLocation(obj, v, false);
      }
      built.explode?.(obj.explode);
    }

    root.visible = !this.suppressed;
    this.scene.add(root);
    this.objects.push(obj);
    if (animate) this.addScan(obj);
    this.select(obj);
    this.changed();
    if (imported) void this.loadInto(obj, imported, init);
    return obj;
  }

  private placeholder(): BuiltObject {
    const content = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9, 2), holoMaterial(0x5fd8ff, { opacity: 0.6 }));
    shell.userData.placeholder = true;
    content.add(shell);
    return { content, radius: 1, update: (dt) => void (shell.rotation.y += dt * 1.5) };
  }

  private async loadInto(obj: ArcObject, model: LibraryModel, init?: Partial<SceneObject>): Promise<void> {
    try {
      const built = await buildImported(model);
      if (obj.removing !== null || !this.objects.includes(obj)) return;
      obj.root.remove(obj.built.content);
      obj.built = built;
      obj.radius = built.radius;
      obj.root.add(built.content);
      if (init?.props?.explode && typeof init.props.explode === "number") built.explode?.(obj.explode);
      this.emit("loaded", obj);
      this.changed();
    } catch (err) {
      console.warn("[playground] model failed to load:", err);
      this.emit("message", { level: "warning", text: `Couldn't load ${model.name}: ${(err as Error).message || "unsupported file"}` });
      this.remove(obj);
    }
  }

  remove(obj: ArcObject): void {
    if (obj.removing !== null) return;
    obj.removing = 0;
    if (this.selected === obj) this.select(null);
    if (this.hovered === obj) this.hovered = null;
  }

  clear(): void {
    for (const o of [...this.objects]) this.remove(o);
    this.emit("location", null);
  }

  private dispose(obj: ArcObject): void {
    this.scene.remove(obj.root);
    obj.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const m of mats) m.dispose(); // cached textures are shared and kept
    });
    const i = this.objects.indexOf(obj);
    if (i >= 0) this.objects.splice(i, 1);
    this.changed();
  }

  select(obj: ArcObject | null): void {
    if (this.selected === obj) return;
    this.selected = obj;
    this.emit("selection", obj);
    if (!obj || obj.kind !== "earth") this.emit("location", obj?.props.location ? this.locationInfo(String(obj.props.location)) : null);
    this.changed();
  }

  private suppressed = false;
  /**
   * Deep Dive hides the whole Playground (objects + selection rings) while it owns the frame —
   * including objects restored or spawned while it is open.
   */
  setSuppressed(on: boolean): void {
    this.suppressed = on;
    for (const o of this.objects) o.root.visible = !on;
    if (on) this.selectionRing.visible = this.hoverRing.visible = false;
  }

  setHovered(obj: ArcObject | null): void {
    this.hovered = obj;
  }

  byRoot(o: THREE.Object3D | null): ArcObject | null {
    while (o) {
      if (o.userData.arcId) return this.objects.find((x) => x.id === o!.userData.arcId && x.removing === null) ?? null;
      o = o.parent;
    }
    return null;
  }

  live(): ArcObject[] {
    return this.objects.filter((o) => o.removing === null);
  }

  /** "selected", "all", an id, or a kind/name ("earth"). */
  resolve(ref: string | undefined): ArcObject[] {
    const live = this.live();
    if (!live.length) return [];
    const r = (ref ?? "selected").toLowerCase().trim();
    if (r === "all" || r === "everything") return live;
    if (["selected", "it", "this", "that", "current", ""].includes(r)) return [this.selected ?? live[live.length - 1]];
    const byId = live.find((o) => o.id === r);
    if (byId) return [byId];
    const kind = resolveCatalogId(r) ?? r;
    const matches = live.filter((o) => o.kind === kind || o.name.toLowerCase() === r);
    return matches.length ? [matches.includes(this.selected!) ? this.selected! : matches[matches.length - 1]] : [];
  }

  // ─── Commands ───

  async apply(cmd: PlaygroundAction): Promise<void> {
    // Deep Dive commands are handled by the Deep Dive stage, not individual objects.
    if (cmd.action === "DEEP_DIVE" || cmd.action === "DEEP_DIVE_SET" || cmd.action === "FOCUS_PART" || cmd.action === "CAROUSEL") return;
    if (cmd.action === "SPAWN_OBJECT") {
      this.spawn(cmd.object);
      return;
    }
    if (cmd.action === "CLEAR_SCENE") {
      this.clear();
      return;
    }
    if (cmd.action === "RESET_VIEW") return; // handled by the engine

    const targets = this.resolve(cmd.target);
    if (!targets.length) {
      this.emit("message", { level: "warning", text: this.live().length ? `No object matches "${cmd.target}"` : "The playground is empty" });
      return;
    }
    for (const obj of targets) {
      switch (cmd.action) {
        case "DELETE_OBJECT":
          this.remove(obj);
          break;
        case "SELECT_OBJECT":
          this.select(obj);
          break;
        case "ROTATE_OBJECT": {
          const axis = cmd.axis === "x" ? new THREE.Vector3(1, 0, 0) : cmd.axis === "z" ? new THREE.Vector3(0, 0, 1) : Y_AXIS;
          obj.target.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, (cmd.amount * Math.PI) / 180));
          break;
        }
        case "SPIN_OBJECT":
          obj.spin = cmd.enabled ? cmd.speed || 0.5 : 0;
          break;
        case "SCALE_OBJECT":
          obj.target.scale = THREE.MathUtils.clamp(obj.target.scale * cmd.factor, 0.2, 5);
          break;
        case "MOVE_OBJECT": {
          const p = obj.target.position;
          const step = cmd.amount || 0.6;
          if (cmd.direction === "center") p.copy(SLOTS[0]);
          else {
            // Directions are relative to the viewer, not world axes.
            const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).setY(0).normalize();
            const forward = new THREE.Vector3().crossVectors(Y_AXIS, right).normalize();
            const dir = { left: right.clone().negate(), right, up: Y_AXIS, down: Y_AXIS.clone().negate(), forward: forward.clone().negate(), back: forward }[cmd.direction];
            p.addScaledVector(dir, step * 1.5);
            p.y = Math.max(this.floorY + obj.radius * obj.target.scale * 0.6, Math.min(3, p.y));
          }
          break;
        }
        case "SET_PROPERTY":
          if (obj.built.setProperty?.(cmd.property, cmd.value)) obj.props[cmd.property] = cmd.value;
          else this.emit("message", { level: "warning", text: `${obj.name} has no ${cmd.property}` });
          break;
        case "EXPLODE_OBJECT":
          if (obj.built.explode) obj.explodeTarget = cmd.enabled ? 1 : 0;
          else this.emit("message", { level: "warning", text: `${obj.name} can't be exploded` });
          break;
        case "SHOW_LOCATION":
          await this.showLocation(obj, cmd.location, true);
          break;
      }
    }
    this.changed();
  }

  private async showLocation(obj: ArcObject, location: string, announce: boolean): Promise<void> {
    const country = resolveCountry(location);
    if (!country || !obj.built.showLocation) {
      if (announce) this.emit("message", { level: "warning", text: country ? `${obj.name} has no map` : `Unknown location "${location}"` });
      return;
    }
    const rotation = await obj.built.showLocation(country);
    obj.props.location = country.name;
    if (rotation) {
      obj.spin = 0;
      obj.target.quaternion.setFromEuler(rotation);
    }
    this.select(obj);
    this.emit("location", this.locationInfo(country.name));
    this.changed();
  }

  private locationInfo(name: string) {
    const c = resolveCountry(name);
    if (!c) return null;
    return {
      name: c.name,
      items: [
        { label: "Capital", value: c.capital },
        { label: "Population", value: c.population },
        { label: "Area", value: c.area },
        { label: "Coordinates", value: `${Math.abs(c.lat).toFixed(1)}°${c.lat >= 0 ? "N" : "S"} ${Math.abs(c.lon).toFixed(1)}°${c.lon >= 0 ? "E" : "W"}` },
      ],
    };
  }

  // ─── Frame ───

  update(dt: number, t: number): void {
    const k = 1 - Math.exp(-dt * 10);
    for (const obj of [...this.objects]) {
      if (obj.removing !== null) {
        obj.removing += dt / 0.35;
        obj.root.scale.setScalar(Math.max(0.001, obj.target.scale * (1 - easeIn(obj.removing))));
        if (obj.removing >= 1) this.dispose(obj);
        continue;
      }
      if (obj.spin) obj.target.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(Y_AXIS, obj.spin * dt));
      obj.root.position.lerp(obj.target.position, k);
      obj.root.quaternion.slerp(obj.target.quaternion, k);
      if (obj.spawnT < 1) {
        obj.spawnT = Math.min(1, obj.spawnT + dt / 0.7);
        obj.root.scale.setScalar(Math.max(0.001, obj.target.scale * easeOutBack(obj.spawnT)));
      } else {
        const s = THREE.MathUtils.lerp(obj.root.scale.x, obj.target.scale, k);
        obj.root.scale.setScalar(s);
      }
      if (Math.abs(obj.explode - obj.explodeTarget) > 1e-3) {
        obj.explode = THREE.MathUtils.lerp(obj.explode, obj.explodeTarget, 1 - Math.exp(-dt * 5));
        obj.built.explode?.(obj.explode);
      }
      obj.built.update?.(dt, t);
    }
    this.updateRings(t);
    this.updateScans(dt);
  }

  private updateRings(t: number): void {
    const place = (ring: THREE.Mesh, obj: ArcObject | null, pulse: boolean) => {
      ring.visible = Boolean(obj && obj.removing === null);
      if (!obj || !ring.visible) return;
      const s = obj.radius * obj.root.scale.x * 1.15 * (pulse ? 1 + Math.sin(t * 3) * 0.02 : 1);
      ring.scale.set(s, 1, s);
      ring.position.set(obj.root.position.x, this.floorY + 0.012, obj.root.position.z);
    };
    place(this.selectionRing, this.selected, true);
    place(this.hoverRing, this.hovered !== this.selected ? this.hovered : null, false);
  }

  private addScan(obj: ArcObject): void {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.008, 6, 96), holoMaterial(0xbff3ff, { opacity: 1, scan: 0, fresnel: 0.5 }));
    mesh.rotation.x = Math.PI / 2;
    mesh.userData.t = 0;
    this.scene.add(mesh);
    this.scanRings.push({ mesh, obj });
  }

  private updateScans(dt: number): void {
    for (let i = this.scanRings.length - 1; i >= 0; i--) {
      const { mesh, obj } = this.scanRings[i];
      mesh.userData.t += dt / 0.9;
      const t = mesh.userData.t as number;
      const r = obj.radius * obj.target.scale;
      mesh.position.set(obj.root.position.x, obj.root.position.y - r + t * 2 * r, obj.root.position.z);
      const w = Math.sqrt(Math.max(0, 1 - (2 * t - 1) ** 2)) * r * 1.05 + 0.02;
      mesh.scale.setScalar(w);
      (mesh.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 1 - t * 0.6;
      if (t >= 1) {
        this.scene.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.scanRings.splice(i, 1);
      }
    }
  }

  private freeSlot(): THREE.Vector3 {
    const live = this.live();
    for (const s of SLOTS) if (!live.some((o) => o.target.position.distanceTo(s) < 1.2)) return s.clone();
    return SLOTS[0].clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 0, -Math.random() * 2));
  }

  // ─── Persistence ───

  snapshot(): SceneSnapshot {
    return {
      selectedId: this.selected?.id ?? null,
      objects: this.live().map((o) => {
        const e = new THREE.Euler().setFromQuaternion(o.target.quaternion);
        const r = (n: number) => Math.round(n * 1000) / 1000;
        return {
          id: o.id,
          kind: o.kind,
          name: o.name,
          position: [r(o.target.position.x), r(o.target.position.y), r(o.target.position.z)],
          rotation: [r(e.x), r(e.y), r(e.z)],
          scale: r(o.target.scale),
          props: { ...o.props, spin: r(o.spin), explode: o.explodeTarget },
        };
      }),
    };
  }

  restore(snapshot: SceneSnapshot): void {
    for (const o of snapshot.objects) {
      if (this.objects.some((x) => x.id === o.id)) continue;
      this.spawn(o.kind, o, false);
    }
    const sel = this.objects.find((o) => o.id === snapshot.selectedId);
    this.select(sel ?? null);
  }

  changed(): void {
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeTimer = window.setTimeout(() => this.emit("change", this.snapshot()), 350);
  }
}

const easeOutBack = (x: number) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
const easeIn = (x: number) => x * x;
