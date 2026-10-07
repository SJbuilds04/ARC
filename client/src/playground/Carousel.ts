import * as THREE from "three";
import type { BuiltObject } from "./objects/types";
import { holoMaterial } from "./holo";

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
}

const SPACING = 1.55;
const PREVIEW_RADIUS = 0.52;
const LIVE_RANGE = 3; // slots either side of the front that show a live model

/**
 * A ring of live 3D models in AR hologram style. Close your fist and move sideways to spin it
 * (or drag, swipe, arrow keys, phone); let go and it settles. Only the models near the front
 * are built (one per frame, so spinning never stalls) and far ones are freed.
 */
export class Carousel {
  readonly group = new THREE.Group();
  private slots: Slot[] = [];
  private key = "";
  private angle = 0;
  private target = 0;
  private dragging = false;
  private holo = holoMaterial(0x6fd8ff, { opacity: 0.85, fresnel: 1.8, scan: 1 });
  private holoFront = holoMaterial(0xbff2ff, { opacity: 1, fresnel: 1.6, scan: 1 });
  private core = new THREE.MeshBasicMaterial({ color: 0x041626, transparent: true, opacity: 0.55, depthWrite: true });
  radius = 3;
  /** Supplied by Deep Dive: builds a model (built-in or imported). */
  makeModel: (id: string) => Promise<BuiltObject | null> = async () => null;

  get count(): number {
    return this.slots.length;
  }

  private get stepAngle(): number {
    return (Math.PI * 2) / Math.max(1, this.slots.length);
  }

  setItems(items: CarouselItem[], _thumbs?: Record<string, string>): void {
    const key = items.map((i) => `${i.id}:${i.name}`).join("|");
    if (key === this.key) return;
    this.key = key;
    for (const s of this.slots) this.disposeSlot(s);
    this.slots = items.map((item) => this.makeSlot(item));
    this.radius = Math.max(2.4, (this.slots.length * SPACING) / (Math.PI * 2));
    this.angle = this.target = 0;
  }

  private makeSlot(item: CarouselItem): Slot {
    const group = new THREE.Group();
    const holder = new THREE.Group();
    group.add(holder);
    const pick = new THREE.Mesh(new THREE.SphereGeometry(0.62, 10, 8), new THREE.MeshBasicMaterial({ visible: false }));
    pick.userData.noPick = true;
    group.add(pick);
    const pedestal = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.46, 64), holoMaterial(0x6fd8ff, { opacity: 0.8, scan: 0, fresnel: 0.1 }));
    pedestal.rotation.x = -Math.PI / 2;
    pedestal.position.y = -0.62;
    group.add(pedestal);
    const label = this.makeLabel(item);
    label.position.y = -0.84;
    group.add(label);
    this.group.add(group);
    return { item, group, holder, pick, label, pedestal, preview: null, building: false };
  }

  private makeLabel(item: CarouselItem): THREE.Mesh {
    const c = document.createElement("canvas");
    c.width = 512;
    c.height = 128;
    const g = c.getContext("2d")!;
    g.textAlign = "center";
    g.fillStyle = "rgba(126,190,226,1)";
    g.font = "600 26px Rajdhani, sans-serif";
    g.fillText(item.category.toUpperCase(), 256, 40);
    g.fillStyle = "rgba(236,249,255,1)";
    g.font = "700 46px Rajdhani, sans-serif";
    let name = item.name.toUpperCase();
    while (g.measureText(name).width > 490 && name.length > 3) name = name.slice(0, -2) + "…";
    g.fillText(name, 256, 92);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.325), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
    m.userData.noPick = true;
    return m;
  }

  /** Turn a model into an AR hologram: dark translucent core + fresnel shell, special shaders kept. */
  private hologram(b: BuiltObject): void {
    // Collect first: adding the core meshes while traversing would visit them too.
    const meshes: THREE.Mesh[] = [];
    b.content.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && !mesh.userData.keepMaterial && !mesh.userData.arExtra && (mesh.material as THREE.Material).visible) meshes.push(mesh);
    });
    meshes.forEach((mesh) => {
      mesh.material = this.holo;
      mesh.castShadow = false;
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

  private async build(s: Slot): Promise<void> {
    s.building = true;
    try {
      const b = await this.makeModel(s.item.id);
      if (!b || !this.slots.includes(s)) return;
      this.hologram(b);
      b.content.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(b.content);
      if (!box.isEmpty()) b.content.position.sub(box.getCenter(new THREE.Vector3()));
      s.holder.add(b.content);
      s.holder.scale.setScalar(PREVIEW_RADIUS / b.radius);
      s.preview = b;
    } catch {
      // a model that fails to load just stays as its label
    } finally {
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

  update(dt: number, t = 0): void {
    const n = this.slots.length;
    if (!n) return;
    this.angle += (this.target - this.angle) * (1 - Math.exp(-dt * (this.dragging ? 18 : 7)));
    const step = this.stepAngle;
    const front = this.frontIndex();
    let startedBuild = false;
    this.slots.forEach((s, i) => {
      const theta = i * step - this.angle;
      s.group.position.set(Math.sin(theta) * this.radius, 0, Math.cos(theta) * this.radius);
      s.group.rotation.y = theta;
      let d = Math.abs(i - front);
      d = Math.min(d, n - d);
      const isFront = i === front;
      const facing = Math.cos(theta);
      const sc = isFront ? 1.18 : 0.9;
      s.group.scale.lerp(new THREE.Vector3(sc, sc, sc), 1 - Math.exp(-dt * 10));
      (s.label.material as THREE.MeshBasicMaterial).opacity = Math.max(0, facing) ** 2 * (isFront ? 1 : 0.6);
      s.group.visible = facing > -0.2;
      if (d <= LIVE_RANGE) {
        if (!s.preview && !s.building && !startedBuild) {
          startedBuild = true; // one new model per frame
          void this.build(s);
        }
        if (s.preview) {
          s.holder.rotation.y += dt * (isFront ? 0.5 : 0.25);
          s.preview.update?.(dt, t);
          s.preview.content.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (mesh.isMesh && (mesh.material === this.holo || mesh.material === this.holoFront)) mesh.material = isFront ? this.holoFront : this.holo;
          });
        }
      } else if (d > LIVE_RANGE + 1) this.freePreview(s);
    });
  }

  drag(dx: number): void {
    this.dragging = true;
    this.target -= dx * this.stepAngle * 7;
  }

  release(): void {
    this.dragging = false;
    this.target = Math.round(this.target / this.stepAngle) * this.stepAngle;
  }

  step(n: number): void {
    this.target = (Math.round(this.target / this.stepAngle) + n) * this.stepAngle;
  }

  goTo(index: number): void {
    const step = this.stepAngle;
    const cur = Math.round(this.target / step);
    const n = this.slots.length;
    let delta = (((index - cur) % n) + n) % n;
    if (delta > n / 2) delta -= n;
    this.target = (cur + delta) * step;
  }

  frontIndex(): number {
    const n = this.slots.length;
    if (!n) return -1;
    return ((Math.round(this.angle / this.stepAngle) % n) + n) % n;
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
