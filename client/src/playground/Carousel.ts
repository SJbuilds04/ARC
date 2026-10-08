import * as THREE from "three";
import type { BuiltObject } from "./objects/types";
import { holoMaterial } from "./holo";
import { kitDetail } from "./objects/suitkit";
import { visibleBox } from "./objects/parts";
import { inkScan } from "./ink";
import { isLight, onTheme } from "../core/theme";

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
  /** Time since the preview last animated (side models animate at a lower rate). */
  tick: number;
  /** When it was last on screen (built previews are kept, the oldest freed first). */
  seenAt: number;
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
/** Built previews kept in memory: scrolling back and forth reuses them instead of rebuilding. */
const MAX_PREVIEWS = 12;
/** A grab that ends settles this much later: a hand flickering out of a fist for a few frames isn't a release. */
const RELEASE_GRACE_MS = 320;
/** At most this far ahead of where the carousel is, so a hard flick doesn't race through everything. */
const MAX_LEAD = 2.5;

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
  /** Drag speed (models per second), smoothed: a flick carries on and settles. */
  private vel = 0;
  private lastDragAt = 0;
  private releaseAt = 0;
  private movedAt = 0;
  private lastBuildAt = 0;
  private frameNo = 0;
  private holo = holoMaterial(0x6fd8ff, { opacity: 0.8, fresnel: 1.9, scan: 1, ink: { alpha: 1.25 } });
  private holoFront = holoMaterial(0xbff2ff, { opacity: 1, fresnel: 1.6, scan: 1 });
  /** Inside every hologram: dark glass on the dark theme, black glass on the light one. */
  private core = new THREE.MeshBasicMaterial({ color: 0x041626, transparent: true, opacity: 0.55, depthWrite: true });
  private frontIdx = -1;
  /** Supplied by Deep Dive: builds a model (built-in or imported). */
  makeModel: (id: string) => Promise<BuiltObject | null> = async () => null;

  constructor() {
    this.applyTheme();
    onTheme(() => {
      this.applyTheme();
      // labels are drawn into textures: redraw them in the new colours
      for (const s of this.slots) {
        const front = s.front;
        s.front = !front;
        this.relabel(s, front);
      }
    });
  }

  private applyTheme(): void {
    const light = isLight();
    this.core.color.set(light ? 0x050608 : 0x041626);
    this.core.opacity = light ? 0.9 : 0.55;
  }

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
    this.dragging = false;
    this.releaseAt = 0;
    this.vel = 0;
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
    return { item, group, holder, pick, label, pedestal, preview: null, building: false, front: false, tick: 0, seenAt: 0 };
  }

  private makeLabel(item: CarouselItem, front: boolean): THREE.Mesh {
    const c = document.createElement("canvas");
    c.width = 640;
    c.height = 192;
    const g = c.getContext("2d")!;
    const light = isLight();
    g.textAlign = "center";
    if (front) {
      g.fillStyle = light ? "#1b8fe0" : "rgba(126,190,226,1)";
      g.font = "600 28px Rajdhani, sans-serif";
      g.fillText(item.category.toUpperCase(), 320, 40);
    }
    g.fillStyle = light ? "#050608" : "rgba(240,250,255,1)";
    g.font = `700 ${front ? 58 : 50}px Rajdhani, sans-serif`;
    let name = item.name.toUpperCase();
    while (g.measureText(name).width > 610 && name.length > 3) name = name.slice(0, -2) + "…";
    g.fillText(name, 320, 100);
    if (front) {
      g.fillStyle = light ? "#1b8fe0" : "rgba(127,220,255,0.85)";
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
      // the shell draws after its core: glow over glass, or (light theme) ink over paper
      core.renderOrder = mesh.renderOrder;
      mesh.renderOrder = core.renderOrder + 1;
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
      if (b.setStyle) {
        b.setStyle({ holo: true, color: "#6fd8ff" });
        b.update?.(4, 0); // settle into the hologram look at once (no fade on a preview)
        inkScan(b.content);
      }
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

  /** Being rolled right now, or was a moment ago (a pinch then is part of the roll, not a tap). */
  get rolling(): boolean {
    return this.dragging || performance.now() - this.lastDragAt < 450;
  }

  /** Seconds since the carousel last moved (thumbnail baking waits for a still carousel). */
  get idleFor(): number {
    return (performance.now() - this.movedAt) / 1000;
  }

  update(dt: number, t = 0): void {
    const n = this.slots.length;
    if (!n) return;
    const now = performance.now();
    if (this.releaseAt && now - this.releaseAt > RELEASE_GRACE_MS) this.settle();
    // the hand went away mid-drag (no release event): settle anyway
    if (this.dragging && !this.releaseAt && now - this.lastDragAt > 700) this.settle();
    this.pos += (this.target - this.pos) * (1 - Math.exp(-dt * (this.dragging ? 14 : 7)));
    if (Math.abs(this.target - this.pos) < 1e-4) this.pos = this.target;
    const moving = this.dragging || Math.abs(this.target - this.pos) > 0.3;
    if (this.dragging || Math.abs(this.target - this.pos) > 0.01) this.movedAt = now;
    this.frameNo++;
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
      if (!visible) continue;
      s.seenAt = now;
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
      // Building a model is the expensive part: while it spins only the front one builds; the rest
      // wait until it slows down. At most one build every ~0.1 s, nearest first.
      if (!s.preview && !s.building && !startedBuild && (d < 0.6 || !moving) && now - this.lastBuildAt > 100) {
        startedBuild = true;
        this.lastBuildAt = now;
        void this.build(s, i === front);
      }
      if (s.preview) {
        s.holder.rotation.y += dt * (i === front ? 0.45 : 0.18);
        // the front and its neighbours animate every frame; the smaller side ones at a quarter of the rate
        s.tick += dt;
        if (d < 1.5 || (this.frameNo + i) % 4 === 0) {
          s.preview.update?.(Math.min(s.tick, 0.2), t);
          s.tick = 0;
        }
        s.holder.visible = fade > 0.02;
      }
    }
    this.trimPreviews();
  }

  /** Keep at most MAX_PREVIEWS built: free the ones off-screen for longest. */
  private trimPreviews(): void {
    const built = this.slots.filter((s) => s.preview && !s.group.visible);
    let count = this.slots.filter((s) => s.preview).length;
    if (count <= MAX_PREVIEWS) return;
    built.sort((a, b) => a.seenAt - b.seenAt);
    for (const s of built) {
      if (count <= MAX_PREVIEWS) break;
      this.freePreview(s);
      count--;
    }
  }

  drag(dx: number): void {
    const now = performance.now();
    if (!this.dragging) {
      this.dragging = true;
      this.vel = 0;
      this.lastDragAt = now;
    }
    this.releaseAt = 0;
    const step = -dx * 7;
    this.target = THREE.MathUtils.clamp(this.target + step, this.pos - MAX_LEAD, this.pos + MAX_LEAD);
    const sec = Math.max(0.008, (now - this.lastDragAt) / 1000);
    this.lastDragAt = now;
    this.vel = this.vel * 0.7 + (step / sec) * 0.3;
  }

  /** Let go: settles a moment later (a hand flickering out of a fist re-grabs within the grace). */
  release(): void {
    if (this.dragging) this.releaseAt = performance.now();
  }

  /** Carry on a little with the flick, then come to rest on a model. */
  private settle(): void {
    const fling = THREE.MathUtils.clamp(this.vel * 0.12, -2, 2);
    this.dragging = false;
    this.releaseAt = 0;
    this.vel = 0;
    this.target = Math.round(THREE.MathUtils.clamp(this.target + fling, this.pos - MAX_LEAD, this.pos + MAX_LEAD));
  }

  step(n: number): void {
    this.dragging = false;
    this.releaseAt = 0;
    this.target = Math.round(this.target) + n;
  }

  goTo(index: number): void {
    const n = this.slots.length;
    if (!n) return;
    this.dragging = false;
    this.releaseAt = 0;
    this.vel = 0;
    const cur = Math.round(this.target);
    let delta = (((index - cur) % n) + n) % n;
    if (delta > n / 2) delta -= n;
    this.target = cur + delta;
  }

  /** Jump straight to a model (e.g. the one you just left) without spinning round. */
  focusOn(id: string): void {
    const i = this.slots.findIndex((s) => s.item.id === id);
    if (i < 0) return;
    this.pos = this.target = i;
    this.dragging = false;
    this.releaseAt = 0;
    this.vel = 0;
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
