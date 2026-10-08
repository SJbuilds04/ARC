import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ObjectManager, type ArcObject } from "./ObjectManager";
import { glowSprite, holoGain, holoTime } from "./holo";
import { blackHoleEnv, blackHoleGain, blackHoleQuality } from "./objects/blackhole";
import { studioEnvironment, studioRig } from "./studio";
import { ink, inkScan, setInk } from "./ink";

/** Light theme: the Playground under a soft daylight sky instead of deep space. */
const LIGHT_SKY = 0xe9eff5;
const DARK_SKY = 0x01060e;

/** three.js's ACES filmic curve (as in its shader), applied to a linear colour. */
function aces(x: number, y: number, z: number, exposure: number): [number, number, number] {
  const k = exposure / 0.6;
  const r = (0.59719 * x + 0.35458 * y + 0.04823 * z) * k;
  const g = (0.076 * x + 0.90834 * y + 0.01566 * z) * k;
  const b = (0.0284 * x + 0.13383 * y + 0.83777 * z) * k;
  const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const R = fit(r), G = fit(g), B = fit(b);
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return [c(1.60475 * R - 0.53108 * G - 0.07367 * B), c(-0.10208 * R + 1.10813 * G - 0.00605 * B), c(-0.00327 * R - 0.07276 * G + 1.07602 * B)];
}

/**
 * The colour to put behind the scene so that, after tone mapping, it shows as exactly `color`.
 * (Tone mapping is for lit models; without this a light backdrop comes out a muddy grey.)
 */
function backdrop(color: THREE.ColorRepresentation, exposure: number): THREE.Color {
  const t = new THREE.Color(color);
  if (t.getHSL({ h: 0, s: 0, l: 0 }).l < 0.25) return t; // dark backdrops barely change
  const target = [Math.min(t.r, 0.97), Math.min(t.g, 0.97), Math.min(t.b, 0.97)];
  const x = [...target];
  for (let i = 0; i < 16; i++) {
    const out = aces(x[0], x[1], x[2], exposure);
    for (let c = 0; c < 3; c++) x[c] *= target[c] / Math.max(out[c], 1e-4);
  }
  return new THREE.Color(x[0], x[1], x[2]);
}

const FLOOR_Y = -1.15;
const HOME = { azimuth: 0, elevation: 0.17, distance: 6.6, target: new THREE.Vector3(0, 0.15, -0.4) };

export interface View {
  azimuth: number;
  elevation: number;
  distance: number;
  target: THREE.Vector3;
}

/**
 * PlaygroundEngine — the 3D spatial workspace on the PC. Created once and kept
 * alive for the whole session; leaving playground mode only pauses rendering.
 */
export class PlaygroundEngine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.05, 100);
  readonly objects: ObjectManager;
  readonly canvas: HTMLCanvasElement;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private clock = new THREE.Clock();
  private raycaster = new THREE.Raycaster();
  private particles: THREE.Points;
  private floor: THREE.Group;
  private milkyWay: THREE.Texture | null = null;
  private light = false;
  private hemi!: THREE.HemisphereLight;
  private ambient!: THREE.AmbientLight;
  private rim!: THREE.PointLight;
  private fill!: THREE.PointLight;
  private zoomLimits = { min: 3, max: 14 };
  private elevationLimits = { min: -0.05, max: 1.2 };
  /** Deep Dive (or anything else) takes over the frame: objects are hidden and not updated. */
  frameHook: ((dt: number, t: number) => void) | null = null;
  private active = false;
  private host: HTMLElement | null = null;
  private resizeObserver = new ResizeObserver(() => this.resize());
  private orbit = { ...HOME, target: HOME.target.clone() };
  private orbitTarget = { ...HOME, target: HOME.target.clone() };
  private frames = 0;
  private maxRatio = 1;
  private weakGpu = false;
  private ratio = 1;
  private slowFor = 0;
  private fastFor = 0;
  private fpsStart = performance.now();
  fps = 0;
  onFps: ((fps: number) => void) | null = null;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.maxRatio = Math.min(window.devicePixelRatio, 2);
    // Integrated / software GPUs start at native-or-lower resolution; adaptive quality raises it if there's headroom.
    const gl = this.renderer.getContext();
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "";
    this.weakGpu = /Intel|SwiftShader|llvmpipe|Mali|Adreno [1-5]/i.test(gpu);
    this.ratio = this.weakGpu ? Math.min(1, this.maxRatio) : Math.min(this.maxRatio, 1.5);
    this.renderer.setPixelRatio(this.ratio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "playground-canvas";

    this.scene.background = new THREE.Color(0x01060e);
    this.scene.fog = new THREE.FogExp2(0x01060e, 0.045);
    // Product-studio reflections (soft boxes, strip lights) for paint, metal, glass, tissue.
    this.scene.environment = studioEnvironment(this.renderer);
    this.scene.environmentIntensity = 1.2;
    if (this.weakGpu) blackHoleQuality.steps = 150;
    // Faint Milky Way for depth (falls back to the flat colour until it loads).
    new THREE.TextureLoader().load("/textures/2k_stars_milky_way.jpg", (tex) => {
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.milkyWay = tex;
      blackHoleEnv.texture = tex;
      this.applyBackdrop();
    });

    this.setupLights();
    // integrated graphics: quarter-size shadow maps (still crisp at stage scale, a lot less work per frame)
    if (this.weakGpu) this.studioLights.key.shadow.mapSize.set(1024, 1024);
    this.studioLights.group.visible = false;
    this.scene.add(this.studioLights.group);
    this.floor = this.buildFloor();
    this.scene.add(this.floor);
    this.particles = this.buildParticles();
    this.scene.add(this.particles);
    // light theme: the floor grid draws as ink, the glow halo and dust hide
    inkScan(this.floor);
    inkScan(this.particles);
    this.objects = new ObjectManager(this.scene, FLOOR_Y, this.camera);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.5, 0.5, 0.55);
    this.composer.addPass(this.bloom);
    if (this.weakGpu) this.renderer.shadowMap.type = THREE.PCFShadowMap; // cheaper shadows on integrated graphics
    this.composer.addPass(new OutputPass());
    this.applyCamera();
  }

  /** Attach the (persistent) canvas to a host element. Re-mounting moves it; nothing is rebuilt. */
  mount(host: HTMLElement): void {
    if (this.host === host) return;
    if (this.host) this.resizeObserver.unobserve(this.host);
    this.host = host;
    host.appendChild(this.canvas);
    this.resizeObserver.observe(host);
    this.resize();
  }

  setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    if (active) {
      this.clock.getDelta();
      this.renderer.setAnimationLoop(() => this.frame());
    } else {
      this.renderer.setAnimationLoop(null);
      this.fps = 0;
      this.onFps?.(0);
    }
  }

  private rectCache: DOMRect | null = null;
  /** The canvas's place on screen, cached: it only changes on resize (no layout read per pointer move). */
  get rect(): DOMRect {
    return (this.rectCache ??= this.canvas.getBoundingClientRect());
  }

  private resize(): void {
    this.rectCache = null;
    if (!this.host) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(Math.round(w / 2), Math.round(h / 2)); // half-res bloom
    this.camera.aspect = w / h;
    if (this.centerShift) this.camera.setViewOffset(w, h, -this.centerShift, 0, w, h);
    this.camera.updateProjectionMatrix();
  }

  private centerShift = 0;
  /** Shift the rendered image sideways by `px` (screen pixels) without moving the camera. */
  setCenterShift(px: number): void {
    const next = Math.round(px);
    if (Math.abs(next - this.centerShift) < 2) return;
    this.centerShift = next;
    if (next) {
      const w = Math.max(1, this.host?.clientWidth ?? innerWidth);
      const h = Math.max(1, this.host?.clientHeight ?? innerHeight);
      this.camera.setViewOffset(w, h, -next, 0, w, h);
    } else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    holoTime.value = t;
    if (this.frameHook) this.frameHook(dt, t);
    else this.objects.update(dt, t);

    // Ease the orbit camera.
    const k = 1 - Math.exp(-dt * 6);
    this.orbit.azimuth += (this.orbitTarget.azimuth - this.orbit.azimuth) * k;
    this.orbit.elevation += (this.orbitTarget.elevation - this.orbit.elevation) * k;
    this.orbit.distance += (this.orbitTarget.distance - this.orbit.distance) * k;
    this.applyCamera();

    // drifting dust: only when it's showing (not in Deep Dive's studio, not on the light theme)
    if (this.particles.visible && !this.light) {
      const pos = this.particles.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) + dt * 0.08;
        if (y > 4) y = FLOOR_Y;
        pos.setY(i, y);
      }
      pos.needsUpdate = true;
      this.particles.rotation.y += dt * 0.01;
    }
    this.orbit.target.lerp(this.orbitTarget.target, k);

    this.composer.render(dt);
    this.frames++;
    const now = performance.now();
    if (now - this.fpsStart > 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsStart));
      this.frames = 0;
      this.fpsStart = now;
      this.onFps?.(this.fps);
      this.adaptQuality();
    }
  }

  /** Adaptive resolution: drop pixel ratio when frames are slow, restore when there's headroom. */
  private adaptQuality(): void {
    if (this.fps < 48) {
      this.slowFor++;
      this.fastFor = 0;
    } else if (this.fps >= 58) {
      this.fastFor++;
      this.slowFor = 0;
    } else {
      this.slowFor = 0;
      this.fastFor = 0;
    }
    let next = this.ratio;
    if (this.slowFor >= 2) next = Math.max(0.6, this.ratio - 0.2);
    else if (this.fastFor >= 5) next = Math.min(this.maxRatio, this.ratio + 0.1);
    if (Math.abs(next - this.ratio) > 0.01) {
      this.ratio = next;
      this.slowFor = 0;
      this.fastFor = 0;
      this.renderer.setPixelRatio(next);
      this.resize();
    }
  }

  // ─── Camera ───

  private applyCamera(): void {
    const { azimuth, elevation, distance, target } = this.orbit;
    this.camera.position.set(
      target.x + distance * Math.sin(azimuth) * Math.cos(elevation),
      target.y + distance * Math.sin(elevation),
      target.z + distance * Math.cos(azimuth) * Math.cos(elevation),
    );
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
  }

  orbitBy(dAzimuth: number, dElevation: number): void {
    this.orbitTarget.azimuth += dAzimuth;
    this.orbitTarget.elevation = THREE.MathUtils.clamp(this.orbitTarget.elevation + dElevation, this.elevationLimits.min, this.elevationLimits.max);
  }

  zoomBy(factor: number): void {
    this.orbitTarget.distance = THREE.MathUtils.clamp(this.orbitTarget.distance * factor, this.zoomLimits.min, this.zoomLimits.max);
  }

  resetView(): void {
    this.orbitTarget = { ...HOME, target: HOME.target.clone() };
  }

  /** Current (eased) view and where it is heading. */
  get view(): View {
    return { ...this.orbit, target: this.orbit.target.clone() };
  }

  get viewTarget(): View {
    return { ...this.orbitTarget, target: this.orbitTarget.target.clone() };
  }

  /** Fly to a view (or jump, with `immediate`). Azimuth takes the short way round. */
  setView(v: View, immediate = false): void {
    const twoPi = Math.PI * 2;
    let az = v.azimuth;
    const cur = this.orbitTarget.azimuth;
    az = cur + ((((az - cur) % twoPi) + twoPi * 1.5) % twoPi) - Math.PI;
    this.orbitTarget = { azimuth: az, elevation: v.elevation, distance: v.distance, target: v.target.clone() };
    if (immediate) this.orbit = { ...this.orbitTarget, target: v.target.clone() };
  }

  setLimits(zoom: { min: number; max: number }, elevation: { min: number; max: number }): void {
    this.zoomLimits = zoom;
    this.elevationLimits = elevation;
  }

  private studio = false;
  private studioBg = "#02070f";
  private space = false;
  private brightness = 0.3;
  private playLights = new THREE.Group();
  private studioLights = studioRig();
  /**
   * Studio look for Deep Dive: a plain backdrop colour (or deep space for models that want
   * it, like the black hole), studio lights, no floor/particles/fog. `null` restores the
   * Playground environment.
   */
  setStudio(bg: string | null, space = false): void {
    const studio = bg !== null;
    if (studio === this.studio && bg === this.studioBg && space === this.space) return;
    this.studio = studio;
    if (bg) this.studioBg = bg;
    this.space = space;
    this.floor.visible = this.particles.visible = !studio;
    this.playLights.visible = !studio;
    this.studioLights.group.visible = studio;
    this.applyFog();
    this.applyBackdrop();
    this.setBrightness(this.brightness);
  }

  /**
   * Light or dark theme. Light: a daylight sky and brighter fill, the grid drawn as ink, holograms and
   * effects as blueprints (see ink.ts). Deep Dive picks its own studio colour for the theme.
   */
  setTheme(light: boolean): void {
    if (light === this.light && ink.value === (light ? 1 : 0)) return;
    this.light = light;
    setInk(light);
    this.hemi.color.set(light ? 0xdbe9f7 : 0x3d6fa8);
    this.hemi.groundColor.set(light ? 0x9fb2c4 : 0x02060c);
    this.hemi.intensity = light ? 1.25 : 0.75;
    this.ambient.color.set(light ? 0xffffff : 0x1a3150);
    this.ambient.intensity = light ? 0.35 : 0.45;
    this.rim.intensity = light ? 6 : 14;
    this.fill.intensity = light ? 2 : 6;
    this.applyFog();
    this.applyBackdrop();
    this.setBrightness(this.brightness);
  }

  private applyFog(): void {
    this.scene.fog = this.studio ? null : this.light ? new THREE.FogExp2(LIGHT_SKY, 0.03) : new THREE.FogExp2(DARK_SKY, 0.045);
  }

  private applyBackdrop(): void {
    if (this.studio && !this.space) {
      this.scene.background = backdrop(this.studioBg, this.renderer.toneMappingExposure);
      this.scene.backgroundIntensity = 1;
      blackHoleEnv.intensity = 0;
      return;
    }
    if (this.light && !this.studio) {
      this.scene.background = backdrop(LIGHT_SKY, this.renderer.toneMappingExposure);
      this.scene.backgroundIntensity = 1;
      blackHoleEnv.intensity = 0;
      return;
    }
    const level = this.studio ? 0.42 : 0.16;
    this.scene.background = this.milkyWay ?? new THREE.Color(DARK_SKY);
    this.scene.backgroundIntensity = this.milkyWay ? level : 1;
    blackHoleEnv.intensity = this.milkyWay ? level : 0;
  }

  /**
   * Scene brightness 0..1: exposure, bloom, environment reflections and hologram intensity.
   * ARC starts low so coloured models and holograms don't glare.
   */
  setBrightness(b: number): void {
    const v = Math.max(0, Math.min(1, b));
    this.brightness = v;
    this.renderer.toneMappingExposure = 0.55 + v * 0.7;
    // bloom only for things that really glow (eyes, reactors, the disk), not every highlight;
    // none on the light theme (glow draws as ink there, and the bright backdrop would haze everything)
    this.bloom.enabled = !this.light;
    this.bloom.strength = 0.08 + v * 0.35;
    this.bloom.radius = 0.35;
    this.bloom.threshold = 0.95;
    this.scene.environmentIntensity = this.studio ? 1.2 + v * 2.0 : 0.9 + v * 1.2;
    holoGain.value = 0.42 + v * 0.75;
    blackHoleGain.value = 0.6 + v * 0.7;
    this.applyBackdrop(); // light backdrops are compensated for the exposure
  }

  /** Render the current scene from `camera` into a PNG (for model thumbnails). */
  async snapshot(camera: THREE.Camera, size = 256, scene: THREE.Scene = this.scene): Promise<Blob | null> {
    const rt = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
    rt.texture.colorSpace = THREE.SRGBColorSpace;
    const prevTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    // thumbnails are shared by both themes: always capture the dark studio look
    const light = this.light;
    const background = scene.background;
    if (light) {
      setInk(false);
      if (background instanceof THREE.Color) scene.background = new THREE.Color("#02070f");
    }
    this.renderer.render(scene, camera);
    if (light) {
      setInk(true);
      scene.background = background;
    }
    const pixels = new Uint8Array(size * size * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, size, size, pixels);
    this.renderer.setRenderTarget(prevTarget);
    rt.dispose();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) img.data.set(pixels.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
    ctx.putImageData(img, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  }

  // ─── Picking ───

  private ndc(nx: number, ny: number): THREE.Vector2 {
    // nx/ny are relative to the viewport; convert via the canvas rect.
    const rect = this.rect;
    const x = ((nx * window.innerWidth - rect.left) / rect.width) * 2 - 1;
    const y = -(((ny * window.innerHeight - rect.top) / rect.height) * 2 - 1);
    return new THREE.Vector2(x, y);
  }

  /** Object under a viewport-normalized point, if any. */
  pick(nx: number, ny: number): ArcObject | null {
    this.raycaster.setFromCamera(this.ndc(nx, ny), this.camera);
    const roots = this.objects.live().map((o) => o.root);
    const hits = this.raycaster.intersectObjects(roots, true).filter((h) => !h.object.userData.noPick && (h.object as THREE.Mesh).isMesh);
    for (const h of hits) {
      const obj = this.objects.byRoot(h.object);
      if (obj) return obj;
    }
    // Generous fallback: nearest object whose bounding sphere the ray passes through.
    let best: ArcObject | null = null;
    let bestD = Infinity;
    for (const o of this.objects.live()) {
      const sphere = new THREE.Sphere(o.root.position, o.radius * o.root.scale.x * 0.9);
      const p = this.raycaster.ray.intersectSphere(sphere, new THREE.Vector3());
      if (p) {
        const d = p.distanceTo(this.camera.position);
        if (d < bestD) {
          bestD = d;
          best = o;
        }
      }
    }
    return best;
  }

  /** Intersect the pointer ray with the camera-facing plane through `point`. */
  pointOnPlane(nx: number, ny: number, point: THREE.Vector3): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(nx, ny), this.camera);
    const normal = new THREE.Vector3();
    this.camera.getWorldDirection(normal);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  }

  viewAxis(): THREE.Vector3 {
    return this.camera.getWorldDirection(new THREE.Vector3()).negate();
  }

  cameraRight(): THREE.Vector3 {
    return new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
  }

  cameraUp(): THREE.Vector3 {
    return new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
  }

  /** Screen-space circle (viewport px) around an object — for the VISOR targeting frame. */
  screenCircle(obj: ArcObject): { x: number; y: number; r: number } {
    const rect = this.rect;
    const toScreen = (v: THREE.Vector3) => {
      const p = v.clone().project(this.camera);
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
    };
    const c = toScreen(obj.root.position);
    const edge = toScreen(obj.root.position.clone().addScaledVector(this.cameraRight(), obj.radius * obj.root.scale.x));
    return { x: c.x, y: c.y, r: Math.max(24, Math.hypot(edge.x - c.x, edge.y - c.y)) };
  }

  // ─── Environment ───

  private setupLights(): void {
    const g = this.playLights;
    this.scene.add(g);
    this.hemi = new THREE.HemisphereLight(0x3d6fa8, 0x02060c, 0.75);
    this.ambient = new THREE.AmbientLight(0x1a3150, 0.45);
    g.add(this.hemi, this.ambient);
    const key = new THREE.DirectionalLight(0xdfefff, 2.2);
    key.position.set(-4, 7, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(this.weakGpu ? 1024 : 2048, this.weakGpu ? 1024 : 2048);
    key.shadow.camera.left = key.shadow.camera.bottom = -7;
    key.shadow.camera.right = key.shadow.camera.top = 7;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    g.add(key);
    this.rim = new THREE.PointLight(0x37b6ff, 14, 14, 1.8);
    this.rim.position.set(4, 2, -3);
    g.add(this.rim);
    this.fill = new THREE.PointLight(0x2050ff, 6, 12, 2);
    this.fill.position.set(-5, 0.5, -2);
    g.add(this.fill);
  }

  private buildFloor(): THREE.Group {
    const group = new THREE.Group();
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(9, 64), new THREE.ShadowMaterial({ opacity: 0.45, color: 0x000000 }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = FLOOR_Y;
    shadow.receiveShadow = true;

    const grid = new THREE.Mesh(
      new THREE.CircleGeometry(9, 96),
      new THREE.ShaderMaterial({
        uniforms: { uTime: holoTime },
        vertexShader: /* glsl */ `varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
        fragmentShader: /* glsl */ `uniform float uTime; varying vec2 vP;
          float line(float v, float w){ float d = abs(fract(v - 0.5) - 0.5) / fwidth(v); return 1.0 - min(d / w, 1.0); }
          void main(){
            float r = length(vP);
            float g = max(line(vP.x * 2.0, 1.0), line(vP.y * 2.0, 1.0)) * 0.35;
            float rings = line(r * 0.8, 1.2) * 0.6;
            float sweep = smoothstep(0.06, 0.0, abs(fract(r * 0.12 - uTime * 0.08) - 0.5) - 0.44) * 0.5;
            float fade = smoothstep(9.0, 1.5, r);
            float a = (g + rings + sweep) * fade;
            gl_FragColor = vec4(vec3(0.3, 0.75, 1.0) * a, a * 0.55);
          }`,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    grid.rotation.x = -Math.PI / 2;
    grid.position.y = FLOOR_Y + 0.005;
    grid.userData.noPick = true;

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowSprite("rgba(40,140,255,0.9)"), blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.35 }));
    halo.scale.set(10, 3, 1);
    halo.position.set(0, FLOOR_Y + 0.2, -1);
    group.add(shadow, grid, halo);
    return group;
  }

  private buildParticles(): THREE.Points {
    const count = 1400;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 1.5 + Math.random() * 8;
      const a = Math.random() * Math.PI * 2;
      positions[i * 3] = Math.cos(a) * r;
      positions[i * 3 + 1] = FLOOR_Y + Math.random() * 5.2;
      positions[i * 3 + 2] = Math.sin(a) * r - 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.035,
        map: glowSprite("rgba(150,220,255,1)", 64),
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    points.userData.noPick = true;
    return points;
  }
}
