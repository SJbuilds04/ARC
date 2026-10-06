import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ObjectManager, type ArcObject } from "./ObjectManager";
import { glowSprite, holoTime } from "./holo";

const FLOOR_Y = -1.15;
const HOME = { azimuth: 0, elevation: 0.17, distance: 6.6, target: new THREE.Vector3(0, 0.15, -0.4) };

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
  private active = false;
  private host: HTMLElement | null = null;
  private resizeObserver = new ResizeObserver(() => this.resize());
  private orbit = { ...HOME, target: HOME.target.clone() };
  private orbitTarget = { ...HOME, target: HOME.target.clone() };
  private frames = 0;
  private fpsStart = performance.now();
  fps = 0;
  onFps: ((fps: number) => void) | null = null;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.canvas = this.renderer.domElement;
    this.canvas.className = "playground-canvas";

    this.scene.background = new THREE.Color(0x01060e);
    this.scene.fog = new THREE.FogExp2(0x01060e, 0.055);

    this.setupLights();
    this.scene.add(this.buildFloor());
    this.particles = this.buildParticles();
    this.scene.add(this.particles);
    this.objects = new ObjectManager(this.scene, FLOOR_Y, this.camera);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.5, 0.5, 0.55);
    this.composer.addPass(this.bloom);
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

  private resize(): void {
    if (!this.host) return;
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    holoTime.value = t;
    this.objects.update(dt, t);

    // Ease the orbit camera.
    const k = 1 - Math.exp(-dt * 6);
    this.orbit.azimuth += (this.orbitTarget.azimuth - this.orbit.azimuth) * k;
    this.orbit.elevation += (this.orbitTarget.elevation - this.orbit.elevation) * k;
    this.orbit.distance += (this.orbitTarget.distance - this.orbit.distance) * k;
    this.applyCamera();

    const pos = this.particles.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      let y = pos.getY(i) + dt * 0.08;
      if (y > 4) y = FLOOR_Y;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    this.particles.rotation.y += dt * 0.01;

    this.composer.render(dt);
    this.frames++;
    const now = performance.now();
    if (now - this.fpsStart > 1000) {
      this.fps = Math.round((this.frames * 1000) / (now - this.fpsStart));
      this.frames = 0;
      this.fpsStart = now;
      this.onFps?.(this.fps);
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
    this.orbitTarget.elevation = THREE.MathUtils.clamp(this.orbitTarget.elevation + dElevation, -0.05, 1.2);
  }

  zoomBy(factor: number): void {
    this.orbitTarget.distance = THREE.MathUtils.clamp(this.orbitTarget.distance * factor, 3, 14);
  }

  resetView(): void {
    this.orbitTarget = { ...HOME, target: HOME.target.clone() };
  }

  // ─── Picking ───

  private ndc(nx: number, ny: number): THREE.Vector2 {
    // nx/ny are relative to the viewport; convert via the canvas rect.
    const rect = this.canvas.getBoundingClientRect();
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
    const rect = this.canvas.getBoundingClientRect();
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
    this.scene.add(new THREE.HemisphereLight(0x3d6fa8, 0x02060c, 0.9));
    this.scene.add(new THREE.AmbientLight(0x1a3150, 0.6));
    const key = new THREE.DirectionalLight(0xdfefff, 2.2);
    key.position.set(-4, 7, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = key.shadow.camera.bottom = -7;
    key.shadow.camera.right = key.shadow.camera.top = 7;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    this.scene.add(key);
    const rim = new THREE.PointLight(0x37b6ff, 18, 14, 1.8);
    rim.position.set(4, 2, -3);
    this.scene.add(rim);
    const fill = new THREE.PointLight(0x2050ff, 8, 12, 2);
    fill.position.set(-5, 0.5, -2);
    this.scene.add(fill);
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
