import * as THREE from "three";
import type { BuiltObject } from "./objects/types";
import { holoMaterial } from "./holo";
import { kitDetail } from "./objects/suitkit";
import { visibleBox } from "./objects/parts";

export interface CarouselItem {
  id: string;
  name: string;
  category: string;
}

interface Slot {
  item: CarouselItem;
  group: THREE.Group;
  holder: THREE.Group;
  pick: THREE.Mesh;
  label: THREE.Mesh;
  pedestal: THREE.Mesh;
  preview: BuiltObject | null;
  building: boolean;
  front: boolean;
}

/** Angle between neighbouring models on the arc. */
const STEP = 0.2;
/** Radius of the arc (fixed: the carousel never grows toward the camera). */
const ARC = 7.0;
/** The front model sits this far in front of the stage centre. */
const FRONT_Z = 1.15;
/** Models either side of the front that are shown (and built) — the rest wait off-stage. */
const WINDOW = 3;
const PREVIEW_RADIUS = 0.52;

/**
 * A fixed arc of live 3D models in AR hologram style, the selected one at the front.
 * Close your fist and move sideways to scroll it (or drag, swipe, arrow keys, phone); let go
 * and it settles. However many models a collection has, the arc and the camera stay the same:
 * only the window around the front is shown, built one model per frame, and far ones freed.
 */
export class Carousel {
  readonly group = new THREE.Group();
  private slots: Slot[] = [];
  private key = "";
  private pos = 0;
  private target = 0;
  private dragging = false;
  private holo = holoMaterial(0x6fd8ff, { opacity: 0.8, fresnel: 1.9, scan: 1 });
  private holoFront = holoMaterial(0xbff2ff, { opacity: 1, fresnel: 1.6, scan: 1 });
  private core = new THREE.MeshBasicMaterial({ color: 0x041626, transparent: true, opacity: 0.55, depthWrite: true });
  private frontIdx = -1;
  /** Supplied by Deep Dive: builds a model (built-in or imported). */
  makeModel: (id: string) => Promise<BuiltObject | null> = async () => null;

  get count(): number {
    return this.slots.length;
  }

  setItems(items: CarouselItem[], _thumbs?: Record<string, string>): void {
    const key = items.map((i) => `${i.id}:${i.name}`).join("|");
    if (key === this.key) return;
    // keep the same model in front if it is still in the new set
    const keep = this.frontId();
    this.key = key;
    for (const s of this.slots) this.disposeSlot(s);
    this.slots = items.map((item) => this.makeSlot(item));
    const at = keep ? items.findIndex((i) => i.id === keep) : -1;
    this.pos = this.target = Math.max(0, at);
    this.frontIdx = -1;
  }

  private makeSlot(item: CarouselItem): Slot {
    const group = new THREE.Group();
    const holder = new THREE.Group();
    group.add(holder);
    const pick = new THREE.Mesh(new THREE.SphereGeometry(0.62, 10, 8), new THREE.MeshBasicMaterial({ visible: false }));
    pick.userData.noPick = true;
    group.add(pick);
    const pedestal = new THREE.Mesh(new THREE.RingGeometry(0.4, 0.43, 72), holoMaterial(0x6fd8ff, { opacity: 0.7, scan: 0, fresnel: 0.1 }));
    pedestal.rotation.x = -Math.PI / 2;
    pedestal.position.y = -0.64;
    group.add(pedestal);
    const label = this.makeLabel(item, false);
    label.position.y = -0.88;
    group.add(label);
    group.visible = false;
    this.group.add(group);
    return { item, group, holder, pick, label, pedestal, preview: null, building: false, front: false };
  }

  private makeLabel(item: CarouselItem, front: boolean): THREE.Mesh {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 192;
    const g = c.getContext("2d")!;
    g.textAlign = "center";
    if (front) {
      g.fillStyle = "rgba(126,190,226,1)";
      g.font = "600 28px Rajdhani, sans-serif";
      g.fillText(item.category.toUpperCase(), 320, 40);
    }
    g.fillStyle = "rgba(240,250,255,1)";
    g.font = `700 ${front ? 58 : 50}px Rajdhani, sans-serif`;
    let name = item.name.toUpperCase();
    while (g.measureText(name).width > 610 && name.length > 3) name = name.slice(0, -2) + "…";
    g.fillText(name, 320, 100);
    if (front) {
      g.fillStyle = "rgba(127,220,255,0.85)";
      g.font = "600 24px Rajdhani, sans-serif";
      g.fillText("PINCH · CLICK · “THIS ONE” TO OPEN", 320, 150);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.45), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    m.userData.noPick = true;
    return m;
  }

  private relabel(s: Slot, front: boolean): void {
    if (s.front === front) return;
    s.front = front;
    const old = s.label;
    const next = this.makeLabel(s.item, front);
    next.position.copy(old.position);
    s.group.remove(old);
    s.group.add(next);
    (old.material as THREE.MeshBasicMaterial).map?.dispose();
    (old.material as THREE.Material).dispose();
    old.geometry.dispose();
    s.label = next;
  }

  /** Turn a model into an AR hologram: dark translucent core + fresnel shell, special shaders kept. */
  private hologram(b: BuiltObject, front: boolean): void {
    // Collect first: adding the core meshes while traversing would visit them too.
    const meshes: THREE.Mesh[] = [];
    b.content.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !mesh.userData.keepMaterial && !mesh.userData.arExtra && (mesh.material as THREE.Material).visible) meshes.push(mesh);
    });
    meshes.forEach((mesh) => {
      mesh.material = front ? this.holoFront : this.holo;
      mesh.userData.holo = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      const core = new THREE.Mesh(mesh.geometry, this.core);
      core.scale.setScalar(0.985);
      core.userData.arExtra = true;
      mesh.add(core);
    });
    b.content.traverse((o) => {
      const sprite = o as THREE.Sprite;
      if (sprite.isSprite) sprite.visible = false;
      const light = o as THREE.Light;
      if (light.isLight) light.visible = false;
    });
  }

  private setFront(s: Slot, front: boolean): void {
    this.relabel(s, front);
    if (!s.preview) return;
    s.preview.content.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.userData.holo) mesh.material = front ? this.holoFront : this.holo;
    });
  }

  private async build(s: Slot, front: boolean): Promise<void> {
    s.building = true;
    try {
      // previews are small: build procedural suits at reduced tessellation
      kitDetail.value = 0.45;
      const pending = this.makeModel(s.item.id);
      kitDetail.value = 1;
      const b = await pending;
      if (!b || !this.slots.includes(s)) return;
      this.hologram(b, front);
      b.content.updateMatrixWorld(true);
      const box = visibleBox(b.content);
      if (!box.isEmpty()) b.content.position.sub(box.getCenter(new THREE.Vector3()));
      s.holder.add(b.content);
      s.holder.scale.setScalar(PREVIEW_RADIUS / b.radius);
      s.preview = b;
    } catch {
      // a model that fails to load just stays as its label
    } finally {
      kitDetail.value = 1;
      s.building = false;
    }
  }

  private freePreview(s: Slot): void {
    if (!s.preview) return;
    s.holder.remove(s.preview.content);
    s.preview.content.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !mesh.userData.arExtra) mesh.geometry?.dispose?.();
    });
    s.preview = null;
  }

  private disposeSlot(s: Slot): void {
    this.freePreview(s);
    this.group.remove(s.group);
    const lm = s.label.material as THREE.MeshBasicMaterial;
    lm.map?.dispose();
    lm.dispose();
    s.label.geometry.dispose();
    (s.pedestal.material as THREE.Material).dispose();
    s.pedestal.geometry.dispose();
    s.pick.geometry.dispose();
  }

  // ─── Motion ───

  /** Signed offset of slot i from the front, wrapped to the shorter way round. */
  private offset(i: number): number {
    const n = this.slots.length;
    let d = i - this.pos;
    d -= Math.round(d / n) * n;
    return d;
  }

  update(dt: number, t = 0): void {
    const n = this.slots.length;
    if (!n) return;
    this.pos += (this.target - this.pos) * (1 - Math.exp(-dt * (this.dragging ? 16 : 7)));
    const front = this.frontIndex();
    if (front !== this.frontIdx) {
      if (this.frontIdx >= 0 && this.slots[this.frontIdx]) this.setFront(this.slots[this.frontIdx], false);
      this.frontIdx = front;
      this.setFront(this.slots[front], true);
    }
    let startedBuild = false;
    // build nearest-first
    const order = this.slots.map((s, i) => ({ s, i, d: Math.abs(this.offset(i)) })).sort((a, b) => a.d - b.d);
    for (const { s, i, d } of order) {
      const off = this.offset(i);
      const visible = d <= WINDOW + 0.5 && (n > 1 || d < 0.5);
      s.group.visible = visible;
      if (!visible) {
        if (d > WINDOW + 1.5) this.freePreview(s);
        continue;
      }
      const theta = off * STEP;
      s.group.position.set(Math.sin(theta) * ARC, 0, Math.cos(theta) * ARC - ARC + FRONT_Z);
      s.group.rotation.y = theta * 0.85;
      const nearness = Math.max(0, 1 - Math.abs(off));
      const sc = 0.8 + 0.48 * nearness;
      s.group.scale.setScalar(sc);
      const fade = 1 - Math.max(0, Math.min(1, d - (WINDOW - 0.6)));
      (s.label.material as THREE.MeshBasicMaterial).opacity = (0.35 + 0.65 * nearness) * fade;
      const pm = s.pedestal.material as THREE.ShaderMaterial;
      pm.uniforms.uOpacity.value = (0.25 + 0.75 * nearness) * fade;
      if (!s.preview && !s.building && !startedBuild) {
        startedBuild = true; // one new model per frame, nearest first
        void this.build(s, i === front);
      }
      if (s.preview) {
        s.holder.rotation.y += dt * (i === front ? 0.45 : 0.18);
        s.preview.update?.(dt, t);
        s.holder.visible = fade > 0.02;
      }
    }
  }

  drag(dx: number): void {
    this.dragging = true;
    this.target -= dx * 7;
  }

  release(): void {
    this.dragging = false;
    this.target = Math.round(this.target);
  }

  step(n: number): void {
    this.target = Math.round(this.target) + n;
  }

  goTo(index: number): void {
    const n = this.slots.length;
    if (!n) return;
    const cur = Math.round(this.target);
    let delta = (((index - cur) % n) + n) % n;
    if (delta > n / 2) delta -= n;
    this.target = cur + delta;
  }

  frontIndex(): number {
    const n = this.slots.length;
    if (!n) return -1;
    return ((Math.round(this.pos) % n) + n) % n;
  }

  frontId(): string | null {
    return this.slots[this.frontIndex()]?.item.id ?? null;
  }

  pick(ray: THREE.Raycaster): number | null {
    const visible = this.slots.filter((s) => s.group.visible);
    const hits = ray.intersectObjects(
      visible.map((s) => s.pick),
      false,
    );
    if (!hits.length) return null;
    return this.slots.findIndex((s) => s.pick === hits[0].object);
  }
}
