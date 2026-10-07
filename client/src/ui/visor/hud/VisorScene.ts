import * as THREE from "three";
import type { PersonMask } from "../../../camera/VisionEngine";

/**
 * The visor's single WebGL view:
 *   1. your face — sharpened (unsharp mask), graded with cold HUD light, cut out with the
 *      person-segmentation mask (face + hair + shoulders), with an inner cyan rim light and an
 *      orange flicker while JARVIS speaks;
 *   2. the helmet interior — dark curved vignette and a faint glass reflection;
 *   3. the HUD — drawn crisp on a 2D canvas, then composited with visor curvature (barrel
 *      distortion), chromatic aberration toward the edges, glow, and a little head parallax.
 */

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FACE_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uVideo;
  uniform sampler2D uMask;
  uniform float uHasMask;
  uniform vec2 uTexel;        // 1 / video size
  uniform vec2 uMaskTexel;    // 1 / mask size
  uniform vec4 uRect;         // video rect on screen in uv: x, y (bottom-left), w, h
  uniform vec4 uEllipse;      // fallback face ellipse in video uv: cx, cy, rx, ry
  uniform vec2 uFaceCenter;   // screen uv
  uniform float uSpeak;
  uniform float uTime;
  uniform float uPresence;
  uniform float uSharpen;     // only when the camera image is being enlarged

  float maskAt(vec2 uv) { return texture2D(uMask, uv).r; }

  void main() {
    vec2 uv = (vUv - uRect.xy) / uRect.zw;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0); return; }
    vec2 vuv = vec2(1.0 - uv.x, 1.0 - uv.y); // mirrored selfie view; texture rows top-down

    // Unsharp mask: recovers detail lost to webcam softness and upscaling.
    vec3 c = texture2D(uVideo, vuv).rgb;
    vec3 blur = (texture2D(uVideo, vuv + vec2(uTexel.x, 0.0) * 1.5).rgb + texture2D(uVideo, vuv - vec2(uTexel.x, 0.0) * 1.5).rgb +
                 texture2D(uVideo, vuv + vec2(0.0, uTexel.y) * 1.5).rgb + texture2D(uVideo, vuv - vec2(0.0, uTexel.y) * 1.5).rgb) * 0.25;
    c = clamp(c + (c - blur) * uSharpen, 0.0, 1.0);

    // HUD lighting: desaturated, contrasty, cold blue key light; skin keeps a little warmth.
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    vec3 g = mix(vec3(l), c, 0.5);
    g = clamp((g - 0.45) * 1.25 + 0.47, 0.0, 1.0);
    vec3 lit = g * vec3(0.78, 0.94, 1.14) * 1.12;
    lit += vec3(0.03, 0.12, 0.22) * smoothstep(0.2, 0.95, l);
    // Light falls off away from the HUD centre (the face sits in the brightest zone).
    float d = distance(vUv, uFaceCenter);
    lit *= mix(1.12, 0.62, smoothstep(0.16, 0.7, d));
    // JARVIS speaking: warm flicker from the lower HUD.
    float flick = 0.75 + 0.25 * sin(uTime * 37.0) * sin(uTime * 11.0);
    lit += vec3(0.42, 0.20, 0.04) * uSpeak * flick * smoothstep(0.1, 0.8, l) * smoothstep(0.9, 0.2, uv.y);

    // Silhouette: person mask (exact to this frame), or the face ellipse as a fallback.
    float m;
    float inner;
    if (uHasMask > 0.5) {
      float raw = maskAt(vuv);
      m = smoothstep(0.42, 0.72, raw);
      // Wider average → inner rim: bright just inside the edge of the silhouette.
      float wide = 0.0;
      for (int i = 0; i < 8; i++) {
        float a = float(i) * 0.785398;
        wide += maskAt(vuv + vec2(cos(a), sin(a)) * uMaskTexel * 3.0);
      }
      wide /= 8.0;
      inner = m * (1.0 - smoothstep(0.55, 0.98, wide));
    } else {
      vec2 e = (vuv - uEllipse.xy) / uEllipse.zw;
      float r = length(e);
      m = 1.0 - smoothstep(0.85, 1.0, r);
      inner = m * smoothstep(0.7, 0.98, r);
    }
    // Fade where the camera frame ends (shoulders leaving the bottom edge).
    m *= smoothstep(0.0, 0.14, uv.y) * smoothstep(0.0, 0.05, uv.x) * smoothstep(1.0, 0.95, uv.x);
    vec3 col = lit + vec3(0.35, 0.82, 1.0) * inner * 0.32;
    gl_FragColor = vec4(col * m * uPresence, m * uPresence);
  }`;

const HELMET_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform vec2 uAspect;
  uniform float uTime;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0 * uAspect;
    // Curved visor edge: dark helmet shell outside an ellipse.
    float r = length(p * vec2(0.9, 1.08));
    float shell = smoothstep(0.98, 1.32, r);
    // Faint diagonal glass reflection.
    float refl = smoothstep(0.05, 0.0, abs(p.x * 0.55 + p.y - 0.65)) * 0.05 + smoothstep(0.02, 0.0, abs(p.x * 0.55 + p.y - 0.8)) * 0.03;
    // Soft blue glow along the lower rim (light from the HUD console).
    float rim = smoothstep(0.25, 0.0, abs(r - 1.12)) * smoothstep(0.1, -0.6, p.y) * 0.22;
    vec3 col = vec3(0.25, 0.6, 1.0) * (refl + rim);
    gl_FragColor = vec4(col, shell * 0.92);
  }`;

const HUD_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uHud;
  uniform vec2 uTexel;
  uniform vec2 uParallax;
  uniform float uCurve;
  uniform float uCA;
  uniform float uGlow;
  vec4 hud(vec2 uv) { vec4 c = texture2D(uHud, uv); return vec4(c.rgb * c.a, c.a); }
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r2 = dot(p, p);
    vec2 uv = (p * (1.0 + uCurve * r2)) * 0.5 + 0.5 + uParallax; // visor curvature (edges pulled in)
    uv.y = 1.0 - uv.y;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0); return; }
    float ca = uCA * r2;
    vec2 dir = p * uTexel * 2.0;
    vec4 base = hud(uv);
    float rr = hud(uv + dir * ca).r;
    float bb = hud(uv - dir * ca).b;
    vec3 col = vec3(rr, base.g, bb);
    // Glow: a ring of taps around the pixel.
    vec3 glow = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.785398;
      glow += hud(uv + vec2(cos(a), sin(a)) * uTexel * 3.5).rgb;
      glow += hud(uv + vec2(cos(a + 0.39), sin(a + 0.39)) * uTexel * 8.0).rgb * 0.6;
    }
    col += glow / 12.8 * uGlow;
    gl_FragColor = vec4(col, 1.0);
  }`;

export interface FaceFrameInput {
  image: TexImageSource | null;
  width: number;
  height: number;
  mask: PersonMask | null;
}

export class VisorScene {
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  /** Camera frames are copied here first: the pipeline closes its bitmaps, a canvas stays valid. */
  private frameCanvas = document.createElement("canvas");
  private frameCtx = this.frameCanvas.getContext("2d")!;
  private videoTex = new THREE.CanvasTexture(this.frameCanvas);
  private maskTex: THREE.DataTexture;
  private hudTex: THREE.CanvasTexture;
  private faceMat: THREE.ShaderMaterial;
  private helmetMat: THREE.ShaderMaterial;
  private hudMat: THREE.ShaderMaterial;
  private maskSize = { w: 0, h: 0 };
  private lastImage: unknown = null;
  private lastMask: PersonMask | null = null;

  constructor(hudCanvas: HTMLCanvasElement, weak: boolean) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, weak ? 1 : 1.5));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);
    this.canvas = this.renderer.domElement;
    this.canvas.className = "visor-scene";

    this.videoTex.minFilter = THREE.LinearFilter;
    this.videoTex.magFilter = THREE.LinearFilter;
    this.videoTex.generateMipmaps = false;
    this.videoTex.colorSpace = THREE.NoColorSpace;
    this.videoTex.flipY = false;
    this.maskTex = new THREE.DataTexture(new Uint8Array(4), 2, 2, THREE.RedFormat);
    this.hudTex = new THREE.CanvasTexture(hudCanvas);
    this.hudTex.minFilter = THREE.LinearFilter;
    this.hudTex.generateMipmaps = false;
    this.hudTex.colorSpace = THREE.NoColorSpace;
    this.hudTex.flipY = false;

    const quad = new THREE.PlaneGeometry(2, 2);
    this.faceMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: FACE_FRAG,
      uniforms: {
        uVideo: { value: this.videoTex },
        uMask: { value: this.maskTex },
        uHasMask: { value: 0 },
        uTexel: { value: new THREE.Vector2(1 / 640, 1 / 480) },
        uMaskTexel: { value: new THREE.Vector2(1 / 256, 1 / 256) },
        uRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uEllipse: { value: new THREE.Vector4(0.5, 0.45, 0.2, 0.3) },
        uFaceCenter: { value: new THREE.Vector2(0.5, 0.55) },
        uSpeak: { value: 0 },
        uTime: { value: 0 },
        uPresence: { value: 0 },
        uSharpen: { value: 0.6 },
      },
      transparent: true,
      depthTest: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.helmetMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: HELMET_FRAG,
      uniforms: { uAspect: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 } },
      transparent: true,
      depthTest: false,
    });
    this.hudMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT,
      fragmentShader: HUD_FRAG,
      uniforms: {
        uHud: { value: this.hudTex },
        uTexel: { value: new THREE.Vector2(1 / 1600, 1 / 900) },
        uParallax: { value: new THREE.Vector2() },
        uCurve: { value: 0.025 },
        uCA: { value: weak ? 0.25 : 0.45 },
        uGlow: { value: weak ? 0.8 : 1.15 },
      },
      transparent: true,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    const add = (mat: THREE.Material, order: number) => {
      const mesh = new THREE.Mesh(quad, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = order;
      this.scene.add(mesh);
    };
    add(this.faceMat, 1);
    add(this.helmetMat, 2);
    add(this.hudMat, 3);
  }

  setSize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    const a = w / h;
    (this.helmetMat.uniforms.uAspect.value as THREE.Vector2).set(a > 1 ? a / 1.6 : 1, a > 1 ? 1 / 1.1 : 1 / a);
  }

  setHudSize(w: number, h: number): void {
    (this.hudMat.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
  }

  /** New camera frame (+ its mask). Uploads only when something actually changed. */
  setFace(input: FaceFrameInput): void {
    const u = this.faceMat.uniforms;
    if (input.image && input.width > 0 && input.height > 0 && (input.image !== this.lastImage || input.image instanceof HTMLVideoElement)) {
      this.lastImage = input.image;
      if (this.frameCanvas.width !== input.width || this.frameCanvas.height !== input.height) {
        // A new size needs a fresh GPU texture (three allocates immutable storage once).
        this.frameCanvas.width = input.width;
        this.frameCanvas.height = input.height;
        this.videoTex.dispose();
      }
      try {
        this.frameCtx.drawImage(input.image as CanvasImageSource, 0, 0, input.width, input.height);
        this.videoTex.needsUpdate = true;
      } catch {
        // frame was released before we got to it — keep the previous one
      }
      (u.uTexel.value as THREE.Vector2).set(1 / input.width, 1 / input.height);
    }
    if (input.mask && input.mask !== this.lastMask) {
      this.lastMask = input.mask;
      const { w, h, data } = input.mask;
      if (w !== this.maskSize.w || h !== this.maskSize.h) {
        this.maskTex.dispose();
        this.maskTex = new THREE.DataTexture(data, w, h, THREE.RedFormat);
        this.maskTex.minFilter = THREE.LinearFilter;
        this.maskTex.magFilter = THREE.LinearFilter;
        this.maskTex.flipY = false;
        u.uMask.value = this.maskTex;
        this.maskSize = { w, h };
        (u.uMaskTexel.value as THREE.Vector2).set(1 / w, 1 / h);
      } else this.maskTex.image.data = data;
      this.maskTex.needsUpdate = true;
    }
    u.uHasMask.value = this.lastMask ? 1 : 0;
  }

  /** Video rect on screen (CSS px, top-left origin) and HUD-light parameters. */
  setLayout(o: { rect: { x: number; y: number; w: number; h: number }; screen: { w: number; h: number }; ellipse: [number, number, number, number]; faceCenter: { x: number; y: number }; presence: number; speak: number; time: number; parallax: { x: number; y: number } }): void {
    const u = this.faceMat.uniforms;
    const { w: W, h: H } = o.screen;
    (u.uRect.value as THREE.Vector4).set(o.rect.x / W, 1 - (o.rect.y + o.rect.h) / H, o.rect.w / W, o.rect.h / H);
    (u.uEllipse.value as THREE.Vector4).set(...o.ellipse);
    (u.uFaceCenter.value as THREE.Vector2).set(o.faceCenter.x / W, 1 - o.faceCenter.y / H);
    u.uPresence.value = o.presence;
    // Upscaled webcam → sharpen; downscaled (phone, HD camera) → leave it natural.
    u.uSharpen.value = Math.max(0, Math.min(0.85, ((o.rect.h / Math.max(1, this.frameCanvas.height)) - 1) * 0.9));
    u.uSpeak.value = o.speak;
    u.uTime.value = o.time;
    this.helmetMat.uniforms.uTime.value = o.time;
    (this.hudMat.uniforms.uParallax.value as THREE.Vector2).set(o.parallax.x, o.parallax.y);
  }

  render(hudChanged: boolean): void {
    if (hudChanged) this.hudTex.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.videoTex.dispose();
    this.maskTex.dispose();
    this.hudTex.dispose();
    this.faceMat.dispose();
    this.helmetMat.dispose();
    this.hudMat.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
