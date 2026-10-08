import * as THREE from "three";
import { OBJECT_CATALOG, catalogEntry, collectionOf } from "@shared/catalog";
import type { DeepDivePart, DeepDiveSettings, DeepDiveState, LibraryModel, ModelActionInfo } from "@shared/types";
import type { PlaygroundEngine, View } from "./PlaygroundEngine";
import { build } from "./objects/factory";
import type { BuiltObject } from "./objects/types";
import { visibleBox, type PartAnchor } from "./objects/parts";
import { buildImported } from "./ModelLoader";
import { holoMaterial, lineMaterial } from "./holo";
import { Carousel, type CarouselItem } from "./Carousel";
import { kitDetail } from "./objects/suitkit";
import { studioRig } from "./studio";
import { LabelLayer } from "./LabelLayer";
import { inkScan } from "./ink";
import { isLight } from "../core/theme";

/** The stage colour Deep Dive starts with; in the light theme it means the light studio. */
const DEFAULT_BG = "#02070f";
const LIGHT_STUDIO = "#e9eef3";

const STAGE_Y = 0.1;
const MODEL_RADIUS = 1.35;
const HOME: View = { azimuth: 0, elevation: 0.14, distance: 6.2, target: new THREE.Vector3(0, STAGE_Y, 0) };
/** Zoom bands: main parts beyond ALL_PARTS, every part inside it, functions inside WITH_INFO. */
const ALL_PARTS = 5.0;
const WITH_INFO = 3.6;
const MAX_EDGE_TRIANGLES = 90_000;
/** Above this many triangles, wireframe shows feature edges (plate outlines) instead of every triangle. */
const DENSE_TRIANGLES = 40_000;

interface StageModel {
  id: string;
  name: string;
  built: BuiltObject;
  root: THREE.Group;
  spinner: THREE.Group;
  parts: PartAnchor[];
  tris: number;
}

interface Styled {
  mesh: THREE.Mesh;
  original: THREE.Material | THREE.Material[];
  extras: THREE.Object3D[];
}

/**
 * Deep Dive — one model alone on a studio stage. The state (which model, AR on/off, colours,
 * explode…) lives in ARC Core so the phone and voice can drive it; this class makes the PC's
 * 3D view match that state every frame:
 *   · AR mode: dark translucent core + fresnel hologram shell + edge lines in the chosen colour,
 *     with labels that add parts and their functions as you zoom in
 *   · solid / wireframe / x-ray styles, background colour, exploded view, auto-spin
 *   · a fist-spun carousel to pick the model
 */
export class DeepDive {
  readonly stage = new THREE.Group();
  readonly labels: LabelLayer;
  readonly carousel: Carousel;
  private model: StageModel | null = null;
  private loading: string | null = null;
  private wanted: { active: boolean; modelId: string | null } = { active: false, modelId: null };
  private settings: DeepDiveSettings | null = null;
  private explode = 0;
  private styleKey = "";
  private styled: Styled[] = [];
  private styleMats: THREE.Material[] = [];
  private platform: THREE.Group;
  /** Soft floor shadow + contact occlusion under standing models (suits). */
  private floor: THREE.Group;
  private savedView: View | null = null;
  private focusId: string | null = null;
  private partInfo = new Map<string, DeepDivePart>();
  /** Action values last applied to the model on stage (ARC state is the source of truth). */
  private applied = new Map<string, boolean | string>();
  private occlusionFrame = 0;
  private raycaster = new THREE.Raycaster();
  private thumbCaptured = new Set<string>();
  private baking = false;
  private bakeAfter = 0;
  /** When the current model landed on stage (wall clock, independent of frame rate). */
  private stageSince = 0;
  /** Pin-a-label mode (imported models): the next click on the model places a label. */
  pinMode = false;
  /** Free horizontal space between the UI panels (viewport px); labels stay inside it. */
  private safe: { left: number; right: number } | null = null;
  /** Last centre shift asked for, so it's only recomputed when the layout changes (no per-frame layout reads). */
  private shiftKey = "";
  private viewMode: "carousel" | "model" | null = null;

  /** Wired by services: library lookup, thumbnails, and callbacks back to ARC Core. */
  lookup: (id: string) => LibraryModel | undefined = () => undefined;
  thumbs: () => Record<string, string> = () => ({});
  onParts: (modelId: string, parts: DeepDivePart[], actions: ModelActionInfo[]) => void = () => undefined;
  /** Pinched / clicked a part that drives one of the model's actions. */
  onAct: (actionId: string) => void = () => undefined;
  onSelect: (modelId: string) => void = () => undefined;
  onFocus: (partId: string | null) => void = () => undefined;
  onPin: (modelId: string, pos: [number, number, number], screen: { x: number; y: number }) => void = () => undefined;
  onThumb: (modelId: string, png: Blob) => void = () => undefined;
  onMessage: (text: string) => void = () => undefined;

  constructor(private readonly engine: PlaygroundEngine) {
    this.stage.visible = false;
    this.stage.position.y = STAGE_Y;
    engine.scene.add(this.stage);
    this.platform = buildPlatform();
    inkScan(this.platform);
    this.platform.position.y = -MODEL_RADIUS - 0.08;
    this.stage.add(this.platform);
    this.floor = buildStudioFloor();
    inkScan(this.floor);
    this.floor.visible = false;
    this.stage.add(this.floor);
    this.carousel = new Carousel();
    this.carousel.makeModel = async (id) => {
      const imported = id.startsWith("m-") ? this.lookup(id) : undefined;
      return imported ? buildImported(imported) : build(id);
    };
    this.carousel.group.position.y = 0.32; // sits above the bottom controls
    this.stage.add(this.carousel.group);
    this.labels = new LabelLayer((id) => this.onFocus(this.focusId === id ? null : id));
  }

  get active(): boolean {
    return this.wanted.active;
  }

  get picking(): boolean {
    return this.wanted.active && !this.wanted.modelId;
  }

  get modelId(): string | null {
    return this.model?.id ?? null;
  }

  // ─── State sync (called whenever ARC state changes) ───

  sync(dd: DeepDiveState, inPlayground: boolean, library: LibraryModel[]): void {
    const active = dd.active && inPlayground;
    const wasActive = this.wanted.active;
    this.wanted = { active, modelId: active ? dd.modelId : null };
    this.settings = dd.settings;
    this.partInfo = new Map(dd.parts.map((p) => [p.id, p]));

    if (active && !wasActive) this.enter();
    if (!active && wasActive) this.leave();
    if (!active) return;

    this.engine.setStudio(this.stageBg(dd.settings), this.wantsSpace());
    this.carousel.setItems(this.carouselItems(library, dd.collection), this.thumbs());
    this.carousel.group.visible = !dd.modelId;

    if (!dd.modelId && this.viewMode !== "carousel") {
      this.viewMode = "carousel";
      this.engine.setView(this.carouselView());
    }
    // A different model was asked for (null = back to the carousel: unload the current one).
    // back to the carousel: the model you were looking at comes round to the front
    if (dd.modelId === null && this.model) this.carousel.focusOn(this.model.id);
    if (dd.modelId !== (this.model?.id ?? null) && (dd.modelId === null || dd.modelId !== this.loading)) void this.load(dd.modelId);
    else if (this.model?.id.startsWith("m-")) this.syncPinnedLabels(library);

    if (dd.focusPart !== this.focusId) this.focus(dd.focusPart);
    this.labels.setInfo(this.partInfo);
    // Model actions changed from anywhere (phone, voice, a pinch) → animate the model.
    const m = this.model;
    if (m && m.id === dd.modelId && m.built.act) {
      for (const a of dd.actions) {
        if (this.applied.get(a.id) !== a.value) {
          this.applied.set(a.id, a.value);
          m.built.act(a.id, a.value);
        }
      }
    }
  }

  /** The carousel always has the same shape, so its view is fixed (never inside the ring). */
  private carouselView(): View {
    return { azimuth: 0, elevation: 0.07, distance: 6.6, target: new THREE.Vector3(0, STAGE_Y + 0.22, 0.35) };
  }

  /** The backdrop: the chosen colour, except that the default stage is the light studio in the light theme. */
  private stageBg(s: DeepDiveSettings): string {
    return isLight() && s.bg.toLowerCase() === DEFAULT_BG ? LIGHT_STUDIO : s.bg;
  }

  /** Models like the black hole ask for deep space behind them (while their stars are on). */
  private wantsSpace(): boolean {
    const ud = this.model?.built.content.userData;
    const s = this.settings;
    // the hologram looks (AR / wireframe / x-ray) stay on the studio backdrop
    return Boolean(ud?.spaceBackdrop && ud.spaceOn && s && !s.ar && s.style === "solid");
  }

  /** The overlay reports where its panels are, so labels and the model use the space between them. */
  setSafeArea(left: number, right: number): void {
    this.safe = right - left > 200 ? { left, right } : null;
    if (this.active) this.applyShift();
  }

  private applyShift(): void {
    const key = `${this.safe?.left}|${this.safe?.right}|${this.picking}|${innerWidth}|${innerHeight}`;
    if (key === this.shiftKey) return;
    this.shiftKey = key;
    if (!this.safe || this.picking) {
      this.engine.setCenterShift(0);
      return;
    }
    const rect = this.engine.rect;
    this.engine.setCenterShift((this.safe.left + this.safe.right) / 2 - (rect.left + rect.width / 2));
  }

  private enter(): void {
    this.savedView = this.engine.viewTarget;
    this.viewMode = null;
    this.engine.setLimits({ min: 1.7, max: 11 }, { min: -1.2, max: 1.35 });
    this.engine.frameHook = (dt, t) => this.update(dt, t);
    this.engine.objects.setSuppressed(true);
    this.stage.visible = true;
    this.engine.setView(HOME);
  }

  private leave(): void {
    this.stage.visible = false;
    this.engine.frameHook = null;
    this.engine.setStudio(null);
    this.engine.setCenterShift(0);
    this.viewMode = null;
    this.engine.setLimits({ min: 3, max: 14 }, { min: -0.05, max: 1.2 });
    this.engine.objects.setSuppressed(false);
    if (this.savedView) this.engine.setView(this.savedView);
    this.unload();
    this.labels.clear();
    this.focusId = null;
    this.pinMode = false;
  }

  private carouselItems(library: LibraryModel[], collection: string | null): CarouselItem[] {
    const coll = collection ? collectionOf(collection) : undefined;
    if (collection === "yours") return library.map((m) => ({ id: m.id, name: m.name, category: "Your model" }));
    return [
      ...(coll ? [] : library.map((m) => ({ id: m.id, name: m.name, category: "Your model" }))),
      ...OBJECT_CATALOG.filter((e) => (coll ? coll.categories.includes(e.category) : e.category !== "Primitive")).map((e) => ({ id: e.id, name: e.name, category: e.category })),
    ];
  }

  // ─── Model ───

  private async load(id: string | null): Promise<void> {
    this.unload();
    this.loading = null;
    this.focusId = null;
    if (!id) {
      this.engine.setView(this.carouselView());
      return;
    }
    this.loading = id;
    this.viewMode = "model";
    let built: BuiltObject | null = null;
    let name = catalogEntry(id)?.name ?? id;
    try {
      const imported = id.startsWith("m-") ? this.lookup(id) : undefined;
      if (imported) {
        name = imported.name;
        built = await buildImported(imported);
      } else built = build(id);
    } catch (err) {
      this.onMessage(`Couldn't load that model: ${(err as Error).message || "unsupported file"}`);
    }
    if (this.loading !== id) return; // superseded while loading
    this.loading = null;
    if (!built) return;

    // Centre the model on the turntable (builders don't always put their geometry at the origin).
    built.content.updateMatrixWorld(true);
    const box = visibleBox(built.content);
    if (!box.isEmpty()) built.content.position.sub(box.getCenter(new THREE.Vector3()));
    const spinner = new THREE.Group();
    spinner.add(built.content);
    const root = new THREE.Group();
    root.add(spinner);
    root.scale.setScalar(MODEL_RADIUS / built.radius);
    this.stage.add(root);
    if (built.content.userData.grounded) {
      // the floor sits under the feet; its occlusion blob matches the footprint
      root.updateMatrixWorld(true);
      const fb = visibleBox(root);
      this.floor.position.y = fb.min.y - this.stage.position.y - 0.004;
      const foot = Math.max(fb.max.x - fb.min.x, fb.max.z - fb.min.z);
      this.floor.children[2].scale.set(foot * 0.95, foot * 0.62, 1);
    }
    let tris = 0;
    built.content.traverse((o) => {
      const g = (o as THREE.Mesh).isMesh ? (o as THREE.Mesh).geometry : null;
      if (g) tris += (g.index?.count ?? g.attributes.position?.count ?? 0) / 3;
    });
    this.model = { id, name, built, root, spinner, parts: built.parts ?? [], tris };
    this.styleKey = "";
    this.explode = 0;
    this.stageSince = performance.now();
    this.engine.setView(HOME);
    this.labels.setParts(this.model.parts);
    this.applied = new Map((built.actions ?? []).map((a) => [a.id, a.value]));
    this.onParts(
      id,
      this.model.parts.map(({ id: pid, name: pname, info, level, custom }) => ({ id: pid, name: pname, info, level, custom })),
      (built.actions ?? []).map(({ id: aid, label, kind, options, words, value }) => ({ id: aid, label, kind, options, words, value })),
    );
  }

  private unload(): void {
    if (!this.model) return;
    this.restyle(null);
    // line geometry cached on the meshes for wireframe / AR edges
    this.model.root.traverse((o) => {
      for (const key of ["ddWire", "ddEdges12", "ddEdges28"]) (o.userData[key] as THREE.BufferGeometry | undefined)?.dispose();
    });
    this.stage.remove(this.model.root);
    this.model = null;
    this.labels.setParts([]);
  }

  /** New / removed pinned labels on an imported model, without reloading it. */
  private syncPinnedLabels(library: LibraryModel[]): void {
    const m = this.model;
    const entry = m ? library.find((x) => x.id === m.id) : undefined;
    if (!m || !entry) return;
    const have = new Set(m.parts.filter((p) => p.custom).map((p) => p.id));
    const want = new Set(entry.labels.map((l) => l.id));
    if (have.size === want.size && [...want].every((id) => have.has(id))) return;
    const content = m.built.content;
    m.parts = m.parts.filter((p) => !p.custom || want.has(p.id));
    for (const l of entry.labels) {
      if (have.has(l.id)) continue;
      const anchor = new THREE.Object3D();
      anchor.position.set(...l.pos);
      content.add(anchor);
      m.parts.push({ id: l.id, name: l.name, info: l.info, level: 1, anchor, custom: true });
    }
    this.labels.setParts(m.parts);
    this.onParts(
      m.id,
      m.parts.map(({ id, name, info, level, custom }) => ({ id, name, info, level, custom })),
      (m.built.actions ?? []).map(({ id, label, kind, options, words }) => ({ id, label, kind, options, words, value: this.applied.get(id) ?? false })),
    );
  }

  // ─── Frame ───

  private update(dt: number, t: number): void {
    const s = this.settings;
    if (!s) return;
    this.carousel.update(dt, t);
    this.applyShift();
    // thumbnails bake in the background only while the carousel is still (never while you scroll)
    if (this.picking && !this.baking && this.carousel.idleFor > 2.5 && (this.bakeAfter -= dt) <= 0) void this.bakeNext();
    this.platform.visible = Boolean(this.model) && s.ar && !this.focusId && !this.model?.built.content.userData.noPlatform;
    this.engine.setStudio(this.stageBg(s), this.wantsSpace());
    this.platform.rotation.y += dt * 0.15;
    this.floor.visible = Boolean(this.model?.built.content.userData.grounded) && !s.ar && s.style === "solid" && !this.focusId && Math.abs(this.model?.root.rotation.x ?? 0) < 0.05;
    const m = this.model;
    if (m) {
      if (!this.focusId && s.spin) m.spinner.rotation.y += dt * s.spin;
      if (m.built.explode && Math.abs(this.explode - s.explode) > 1e-3) {
        this.explode = THREE.MathUtils.lerp(this.explode, s.explode, 1 - Math.exp(-dt * 5));
        m.built.explode(this.explode);
      }
      m.built.update?.(dt, t);
      const key = `${s.ar}|${s.style}|${s.color}|${this.focusId}|${isLight()}`;
      if (key !== this.styleKey) {
        this.styleKey = key;
        this.restyle(s);
      }
      this.updateLabels(s);
      // Thumbnail for the library/carousel, once the model has settled on stage.
      if (performance.now() - this.stageSince > 1600 && !this.thumbCaptured.has(m.id) && !this.thumbs()[m.id]) {
        this.thumbCaptured.add(m.id);
        void this.captureThumb(m);
      }
    } else this.labels.hide();
  }

  private updateLabels(s: DeepDiveSettings): void {
    const m = this.model!;
    const labelsOn = s.labels ?? s.ar;
    const show = labelsOn || Boolean(this.focusId);
    if (!show) {
      this.labels.hide();
      return;
    }
    const cam = this.engine.camera;
    const distance = this.engine.view.distance;
    // Zoom decides how much you see: major parts far away, every part closer, functions up close.
    const allParts = s.detail === "all" || (s.detail === "auto" && distance < ALL_PARTS);
    const withInfo = distance < WITH_INFO;
    const focus = this.focusId;
    const occlude = ++this.occlusionFrame % 8 === 0;
    const meshes: THREE.Object3D[] = [];
    if (occlude) m.root.traverse((o) => (o as THREE.Mesh).isMesh && !o.userData.noPick && !o.userData.arExtra && meshes.push(o));
    const centre = m.root.getWorldPosition(new THREE.Vector3());
    const radius = MODEL_RADIUS * 1.05;
    this.labels.layout(
      this.engine.canvas,
      cam,
      centre,
      radius,
      // A focused part gets the stage to itself; otherwise zoom decides.
      (p) => (focus ? p.id === focus : labelsOn && (p.level === 1 || allParts)),
      withInfo,
      focus,
      s.labelColor,
      occlude ? (_p, world) => this.occluded(world, meshes) : null,
      this.safe,
    );
  }

  private occluded(world: THREE.Vector3, meshes: THREE.Object3D[]): boolean {
    const cam = this.engine.camera.position;
    const dir = world.clone().sub(cam);
    const dist = dir.length();
    this.raycaster.set(cam, dir.normalize());
    this.raycaster.far = dist - 0.05;
    return this.raycaster.intersectObjects(meshes, false).length > 0;
  }

  // ─── Styles: solid · AR hologram · wireframe · x-ray ───

  private restyle(s: DeepDiveSettings | null): void {
    for (const st of this.styled) {
      st.mesh.material = st.original;
      // overlays share the model's geometry; line geometry stays cached on the mesh
      for (const e of st.extras) st.mesh.remove(e);
    }
    this.styled = [];
    for (const mat of this.styleMats) mat.dispose();
    this.styleMats = [];
    const m = this.model;
    if (!s || !m) return;
    // models that render themselves (the black hole) switch to their own hologram look
    m.built.setStyle?.({ holo: s.ar || s.style !== "solid", color: s.color });
    inkScan(m.built.content);
    const focusMeshes = new Set(m.parts.find((p) => p.id === this.focusId)?.meshes ?? []);
    if (s.style === "solid" && !s.ar && !focusMeshes.size) return;

    const dense = m.tris > DENSE_TRIANGLES;
    const color = new THREE.Color(s.color);
    const highlight = new THREE.Color("#ffb347");
    // light theme: the hologram is drawn in ink on a pale paper-like core instead of glowing over a dark one
    const light = isLight();
    const core = light
      ? new THREE.MeshStandardMaterial({ color: 0xeef3f8, metalness: 0, roughness: 0.85, transparent: true, opacity: 0.35, depthWrite: true })
      : new THREE.MeshStandardMaterial({ color: color.clone().multiplyScalar(0.08), emissive: color.clone().multiplyScalar(0.05), metalness: 0.4, roughness: 0.4, transparent: true, opacity: 0.6, depthWrite: true });
    const shell = holoMaterial(color, { opacity: 0.95, fresnel: 2, scan: 1 });
    const shellHot = holoMaterial(highlight, { opacity: 1, fresnel: 1.6, scan: 1 });
    // Wireframe: hidden-line edges over a dark silhouette, at brightness-controlled intensity
    // (drawing every edge of a dense model additively saturates to white).
    const lineColor = s.ar ? color.clone() : new THREE.Color("#9fd6ff");
    const wireCore = new THREE.MeshBasicMaterial({ color: light ? new THREE.Color(0xf4f7fa) : lineColor.clone().multiplyScalar(0.045), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const wireLines = lineMaterial(lineColor, dense ? 0.8 : 0.6);
    const hotLines = lineMaterial(highlight, 0.95);
    // x-ray builds up from many see-through layers; ink doesn't add up like light, so it's drawn bolder
    const xray = holoMaterial(s.ar ? color : new THREE.Color(light ? "#5b8db8" : "#d6ecff"), { opacity: dense ? 0.26 : 0.55, fresnel: 1.4, scan: s.ar ? 0.8 : 0, ink: { tone: 0.22, alpha: 4.5 } });
    const lineMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false });
    this.styleMats = [core, shell, shellHot, wireCore, wireLines, hotLines, xray, lineMat];

    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || mesh.userData.arExtra || mesh.userData.placeholder || mesh.userData.keepMaterial || !(mesh.material as THREE.Material).visible) return;
      const hot = focusMeshes.has(mesh);
      const st: Styled = { mesh, original: mesh.material, extras: [] };
      if (s.style === "wireframe") {
        mesh.material = wireCore;
        const lines = new THREE.LineSegments(this.lineGeometry(mesh, dense ? "ddEdges12" : "ddWire"), hot ? hotLines : wireLines);
        lines.userData.arExtra = true;
        lines.userData.noPick = true;
        st.extras.push(lines);
      } else if (s.style === "xray") mesh.material = hot ? shellHot : xray;
      else if (s.ar) {
        mesh.material = core;
        const overlay = new THREE.Mesh(mesh.geometry, hot ? shellHot : shell);
        overlay.userData.arExtra = true;
        overlay.userData.noPick = true;
        overlay.renderOrder = mesh.renderOrder + 1; // ink / glow over the core
        st.extras.push(overlay);
        const tris = (mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0) / 3;
        if (tris > 0 && tris < MAX_EDGE_TRIANGLES) {
          const edges = new THREE.LineSegments(this.lineGeometry(mesh, "ddEdges28"), lineMat);
          edges.userData.arExtra = true;
          edges.userData.noPick = true;
          st.extras.push(edges);
        }
      } else if (hot) {
        const overlay = new THREE.Mesh(mesh.geometry, shellHot);
        overlay.userData.arExtra = true;
        st.extras.push(overlay);
      } else return;
      for (const e of st.extras) mesh.add(e);
      this.styled.push(st);
    });
    inkScan(m.root);
  }

  /** Line geometry for a mesh, computed once and cached on it. */
  private lineGeometry(mesh: THREE.Mesh, kind: "ddWire" | "ddEdges12" | "ddEdges28"): THREE.BufferGeometry {
    let g = mesh.userData[kind] as THREE.BufferGeometry | undefined;
    if (!g) {
      g = kind === "ddWire" ? new THREE.WireframeGeometry(mesh.geometry) : new THREE.EdgesGeometry(mesh.geometry, kind === "ddEdges12" ? 12 : 28);
      mesh.userData[kind] = g;
    }
    return g;
  }

  // ─── Focus a part ───

  private focus(partId: string | null): void {
    this.focusId = partId;
    this.styleKey = "";
    const m = this.model;
    const part = partId ? m?.parts.find((p) => p.id === partId) : null;
    if (!m || !part) {
      if (m) this.engine.setView(HOME);
      return;
    }
    const centre = m.root.getWorldPosition(new THREE.Vector3());
    const p = part.anchor.getWorldPosition(new THREE.Vector3());
    const dir = p.clone().sub(centre);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    this.engine.setView({
      azimuth: Math.atan2(dir.x, dir.z),
      elevation: THREE.MathUtils.clamp(Math.asin(dir.y), -0.9, 1.1),
      distance: 3.7,
      target: centre.clone().lerp(p, 0.35),
    });
  }

  // ─── Input (mouse, hands, phone) ───

  // The carousel has one fixed view: nothing orbits or zooms the camera while it's showing.
  orbit(dx: number, dy: number): void {
    if (!this.picking) this.engine.orbitBy(-dx * 3.2, dy * 2.2);
  }

  zoom(factor: number): void {
    if (!this.picking) this.engine.zoomBy(factor);
  }

  /** Fist: turn the model itself (or spin the carousel while picking). */
  grab(dx: number, dy: number): void {
    if (this.picking) {
      this.carousel.drag(dx);
      return;
    }
    const m = this.model;
    if (!m) return;
    m.spinner.rotation.y += dx * 6;
    m.root.rotation.x = THREE.MathUtils.clamp(m.root.rotation.x + dy * 4, -1.2, 1.2);
  }

  release(): void {
    if (this.picking) this.carousel.release();
  }

  /** The carousel is being rolled (or just was). */
  get rolling(): boolean {
    return this.picking && this.carousel.rolling;
  }

  step(n: number): void {
    if (this.picking) this.carousel.step(n);
  }

  selectFront(): void {
    const id = this.carousel.frontId();
    if (this.picking && id) this.onSelect(id);
  }

  /** Click / pinch at a viewport-normalized point. Returns true if it was used. */
  click(nx: number, ny: number): boolean {
    const ray = this.ray(nx, ny);
    if (this.picking) {
      const card = this.carousel.pick(ray);
      if (card === null) return false;
      if (card === this.carousel.frontIndex()) this.selectFront();
      else this.carousel.goTo(card);
      return true;
    }
    if (this.pinMode && this.model) {
      const meshes: THREE.Object3D[] = [];
      this.model.root.traverse((o) => (o as THREE.Mesh).isMesh && !o.userData.arExtra && meshes.push(o));
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit) return false;
      const local = this.model.built.content.worldToLocal(hit.point.clone());
      const r = (v: number) => Math.round(v * 1000) / 1000;
      this.onPin(this.model.id, [r(local.x), r(local.y), r(local.z)], { x: nx * innerWidth, y: ny * innerHeight });
      this.pinMode = false;
      return true;
    }
    // Pinch / click a part that drives an action (the faceplate, the reactor, the detector…).
    const m = this.model;
    if (m?.built.actions?.length) {
      const meshes: THREE.Object3D[] = [];
      m.root.traverse((o) => (o as THREE.Mesh).isMesh && !o.userData.arExtra && meshes.push(o));
      const hit = ray.intersectObjects(meshes, false)[0];
      if (hit) {
        for (const a of m.built.actions) {
          if (!a.parts?.length || a.kind === "choice") continue;
          let o: THREE.Object3D | null = hit.object;
          while (o && o !== m.root) {
            if (a.parts.includes(o)) {
              this.onAct(a.id);
              return true;
            }
            o = o.parent;
          }
        }
      }
    }
    return false;
  }

  private ray(nx: number, ny: number): THREE.Raycaster {
    const rect = this.engine.rect;
    const x = ((nx * innerWidth - rect.left) / rect.width) * 2 - 1;
    const y = -(((ny * innerHeight - rect.top) / rect.height) * 2 - 1);
    this.raycaster.far = Infinity;
    this.raycaster.setFromCamera(new THREE.Vector2(x, y), this.engine.camera);
    return this.raycaster;
  }

  // ─── Thumbnails ───

  /** While the carousel is open, render missing built-in thumbnails one at a time (off screen). */
  private async bakeNext(): Promise<void> {
    const have = this.thumbs();
    const id = OBJECT_CATALOG.map((e) => e.id).find((x) => !have[x] && !this.thumbCaptured.has(x));
    if (!id) {
      this.bakeAfter = 5;
      return;
    }
    this.baking = true;
    this.thumbCaptured.add(id);
    try {
      kitDetail.value = 0.6; // thumbnails are tiny: lighter tessellation, shorter hitch
      const built = build(id);
      kitDetail.value = 1;
      if (!built) return;
      const scene = new THREE.Scene();
      scene.environment = this.engine.scene.environment;
      scene.environmentIntensity = 1.6;
      scene.add(studioRig().group);
      const holder = new THREE.Group();
      holder.add(built.content);
      holder.scale.setScalar(MODEL_RADIUS / built.radius);
      holder.position.y = STAGE_Y;
      scene.add(holder);
      await new Promise((r) => setTimeout(r, 1200)); // let textures arrive
      built.update?.(0.016, 1);
      const cam = new THREE.PerspectiveCamera(36, 1, 0.05, 50);
      const dist = (MODEL_RADIUS / Math.sin(THREE.MathUtils.degToRad(18))) * 0.92;
      cam.position.set(dist * 0.35, STAGE_Y + dist * 0.18, dist * 0.92);
      cam.lookAt(0, STAGE_Y, 0);
      const blob = await this.engine.snapshot(cam, 256, scene);
      if (blob) this.onThumb(id, blob);
      holder.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose?.();
      });
    } catch (err) {
      console.warn("[deep dive] thumbnail failed:", err);
    } finally {
      this.baking = false;
      this.bakeAfter = 1.2;
    }
  }

  private async captureThumb(m: StageModel): Promise<void> {
    const cam = new THREE.PerspectiveCamera(36, 1, 0.05, 50);
    const dist = MODEL_RADIUS / Math.sin(THREE.MathUtils.degToRad(18)) * 0.92;
    cam.position.set(dist * 0.35, STAGE_Y + dist * 0.18, dist * 0.92);
    cam.lookAt(0, STAGE_Y, 0);
    const prevLabels = this.platform.visible;
    this.platform.visible = false;
    const blob = await this.engine.snapshot(cam, 256);
    this.platform.visible = prevLabels;
    if (blob) this.onThumb(m.id, blob);
  }
}

/** Studio floor: catches the key light's shadow and adds a soft contact shadow under the feet. */
function buildStudioFloor(): THREE.Group {
  const g = new THREE.Group();
  // a faint pool of light on the floor, so the shadows have something to fall on
  const pc = document.createElement("canvas");
  pc.width = pc.height = 256;
  const px = pc.getContext("2d")!;
  const pg = px.createRadialGradient(128, 128, 0, 128, 128, 128);
  pg.addColorStop(0, "rgba(150,190,230,0.55)");
  pg.addColorStop(0.5, "rgba(110,150,200,0.22)");
  pg.addColorStop(1, "rgba(0,0,0,0)");
  px.fillStyle = pg;
  px.fillRect(0, 0, 256, 256);
  const poolTex = new THREE.CanvasTexture(pc);
  poolTex.colorSpace = THREE.SRGBColorSpace;
  const pool = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 4.2), new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.32 }));
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = -0.001;
  pool.renderOrder = 1;
  pool.userData.noPick = true;
  g.add(pool);
  const catcher = new THREE.Mesh(new THREE.CircleGeometry(3.2, 64), new THREE.ShadowMaterial({ opacity: 0.42, transparent: true, depthWrite: false }));
  catcher.rotation.x = -Math.PI / 2;
  catcher.receiveShadow = true;
  catcher.renderOrder = 2;
  catcher.userData.noPick = true;
  g.add(catcher);
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const grd = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, "rgba(0,0,0,0.85)");
  grd.addColorStop(0.45, "rgba(0,0,0,0.45)");
  grd.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.75 }));
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.001;
  blob.renderOrder = 3;
  blob.userData.noPick = true;
  g.add(blob);
  return g;
}

/** Holographic turntable under the model in AR mode. */
function buildPlatform(): THREE.Group {
  const g = new THREE.Group();
  for (const [r, w, o] of [
    [1.25, 0.008, 0.45],
    [1.55, 0.004, 0.25],
    [1.9, 0.003, 0.14],
  ] as const) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(r - w, r + w, 128), holoMaterial(0x5fd8ff, { opacity: o, scan: 0, fresnel: 0.1 }));
    ring.rotation.x = -Math.PI / 2;
    ring.userData.noPick = true;
    g.add(ring);
  }
  const ticks = new THREE.Group();
  for (let i = 0; i < 72; i++) {
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.008, i % 6 ? 0.05 : 0.11), new THREE.MeshBasicMaterial({ color: 0x5fd8ff, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const a = (i / 72) * Math.PI * 2;
    tick.position.set(Math.cos(a) * 1.42, 0, Math.sin(a) * 1.42);
    tick.rotation.set(-Math.PI / 2, 0, -a);
    ticks.add(tick);
  }
  g.add(ticks);
  return g;
}
