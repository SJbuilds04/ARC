import type { ArcState, DeviceRole, Hand, ServerMessageOf } from "@shared/types";
import type { ArcClient } from "../core/ArcClient";
import { useArc, setLocal, notify, dismissCode } from "../core/store";
import { Emitter } from "../core/emitter";
import { CameraSource } from "./CameraSource";
import type { GestureManager } from "../gestures/GestureManager";
import { createVisionEngine, type ModelHandle, type VisionEngine } from "./VisionEngine";
import type { FaceFrame } from "../visor/FaceTracker";

const RELAY_INTERVAL_MS = 33; // ~30 fps of landmarks — a few KB/s instead of a video stream
const REMOTE_ASPECT = 4 / 3;

/**
 * VisionManager — follows the vision routes published by ARC Core.
 * If this device is a route's source it runs its camera + hand tracker; if the
 * consumer is another device it relays landmarks (never video) over the existing
 * socket. If this device consumes a remote source it feeds the relayed frames into
 * the same GestureManager. Switching cameras just changes routes: nothing restarts.
 */
export class VisionManager extends Emitter<{ stream: MediaStream | null }> {
  readonly camera = new CameraSource();
  /** Hand + face inference — in a Web Worker when possible, so the UI thread stays free. */
  readonly engine: VisionEngine = createVisionEngine();
  /** Hand model handle (kept as `tracker` for existing callers). */
  readonly tracker: ModelHandle = this.engine.hands;
  readonly faceModel: ModelHandle = this.engine.face;
  /** Set by the VISOR while it needs face landmarks. */
  faceWanted = false;
  private busy = false;
  private faceListeners = new Set<(face: FaceFrame | null, now: number) => void>();
  private capturing = false;
  private starting = false;
  private relay = false;
  private consumesRemote: DeviceRole[] = [];
  private lastRelay = 0;
  private frames = 0;
  private fpsWindowStart = performance.now();
  private statusTimer: number | null = null;
  private rafId = 0;
  private videoFrameHandle = 0;
  private frameIndex = 0;
  /** Run hand detection every Nth frame. */
  handEvery = 1;

  constructor(
    private readonly role: DeviceRole,
    private readonly arc: ArcClient,
    private readonly gestures: GestureManager,
  ) {
    super();
    useArc.subscribe((s, prev) => {
      if (s.state !== prev.state || s.engaged !== prev.engaged) this.reconcile(s.state);
    });
    arc.on("HAND_FRAME", (msg) => this.onRemoteFrame(msg));
    // After a reconnect the server has forgotten our camera status — report it again.
    arc.on("open", () => this.reportStatus(true));
  }

  /** Warm the hand model early (boot sequence shows real progress). */
  preload(): Promise<void> {
    return this.tracker
      .load()
      .then(() => setLocal({ trackerReady: true }))
      .catch((err) => {
        setLocal({ trackerReady: false });
        throw err;
      });
  }

  get stream(): MediaStream | null {
    return this.camera.stream;
  }

  private reconcile(state: ArcState | null): void {
    if (!state) return;
    const routes = state.vision.routes;
    const shouldCapture = routes.some((r) => r.source === this.role);
    this.relay = routes.some((r) => r.source === this.role && r.consumer !== this.role);
    this.consumesRemote = routes.filter((r) => r.consumer === this.role && r.source !== this.role).map((r) => r.source);

    if (shouldCapture && !this.capturing && !this.starting) void this.startCapture();
    else if (!shouldCapture && (this.capturing || this.starting)) this.stopCapture();
  }

  /** Called from UI (e.g. RECONNECT on a vision error). */
  retry(): void {
    this.stopCapture();
    this.reconcile(useArc.getState().state);
  }

  private async startCapture(): Promise<void> {
    this.starting = true;
    setLocal({ camera: "starting", cameraError: undefined });
    this.send("STARTING");
    try {
      await Promise.all([this.camera.start(() => this.onCameraEnded()), this.tracker.load()]);
      setLocal({ trackerReady: true });
      if (!this.starting) {
        // Route changed while we were starting.
        this.camera.stop();
        return;
      }
      this.starting = false;
      this.capturing = true;
      setLocal({ camera: "on" });
      dismissCode("CAMERA");
      this.emit("stream", this.camera.stream);
      this.send("ACTIVE");
      this.loop();
      this.statusTimer = window.setInterval(() => this.reportStatus(false), 1000);
    } catch (err) {
      this.starting = false;
      this.camera.stop();
      const message = (err as Error).message || "Camera failed";
      setLocal({ camera: "error", cameraError: message });
      this.send("ERROR", message);
      notify({ level: "error", title: "VISION SOURCE UNAVAILABLE", text: `${this.role} CAMERA · ${message}`, code: "CAMERA" }, 0);
    }
  }

  private stopCapture(): void {
    this.starting = false;
    this.capturing = false;
    cancelAnimationFrame(this.rafId);
    const v = this.camera.video as HTMLVideoElement & { cancelVideoFrameCallback?: (h: number) => void };
    if (this.videoFrameHandle && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this.videoFrameHandle);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.camera.stop();
    this.gestures.reset();
    setLocal({ camera: "off", trackerFps: 0, hands: 0 });
    this.emit("stream", null);
    this.send("IDLE");
  }

  private onCameraEnded(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.camera.stop();
    setLocal({ camera: "error", cameraError: "Camera disconnected" });
    this.send("ERROR", "Camera disconnected");
    this.emit("stream", null);
  }

  private loop(): void {
    const video = this.camera.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    const step = () => {
      if (!this.capturing) return;
      this.processFrame();
      if (video.requestVideoFrameCallback) this.videoFrameHandle = video.requestVideoFrameCallback(step);
      else this.rafId = requestAnimationFrame(step);
    };
    step();
  }

  /** Face landmarks for each processed frame while `faceWanted` (null = no face in view). */
  onFace(listener: (face: FaceFrame | null, now: number) => void): () => void {
    this.faceListeners.add(listener);
    return () => this.faceListeners.delete(listener);
  }

  private processFrame(): void {
    // Back-pressure: one frame in flight; newer camera frames are simply skipped.
    if (this.busy) return;
    const now = performance.now();
    const want = { hands: this.frameIndex++ % this.handEvery === 0, face: this.faceWanted };
    this.busy = true;
    this.engine
      .process(this.camera.video, now, want, this.camera.aspect)
      .then((r) => this.onResult(r.hands, r.face, now))
      .catch((err) => console.warn("[vision] inference failed", err))
      .finally(() => (this.busy = false));
  }

  private onResult(hands: Hand[] | null, face: FaceFrame | null | undefined, now: number): void {
    if (!this.capturing) return;
    if (face !== undefined) for (const l of this.faceListeners) l(face, now);
    this.frames++;
    if (!hands) return;
    if (this.consumesLocally()) this.gestures.ingest(hands, now, this.camera.aspect);
    if (this.relay && now - this.lastRelay >= RELAY_INTERVAL_MS) {
      this.lastRelay = now;
      this.arc.sendVolatile({
        type: "HAND_FRAME",
        source: this.role,
        t: Date.now(),
        hands: hands.map((h) => ({ handedness: h.handedness, lm: h.lm.map((v) => Math.round(v * 1000) / 1000) })),
      });
    }
    if (now - this.fpsWindowStart >= 1000) {
      setLocal({ trackerFps: Math.round((this.frames * 1000) / (now - this.fpsWindowStart)), hands: hands.length });
      this.frames = 0;
      this.fpsWindowStart = now;
    }
  }

  private consumesLocally(): boolean {
    const s = useArc.getState().state;
    return Boolean(s?.vision.routes.some((r) => r.source === this.role && r.consumer === this.role));
  }

  private onRemoteFrame(msg: ServerMessageOf<"HAND_FRAME">): void {
    if (!this.consumesRemote.includes(msg.source)) return;
    this.gestures.ingest(msg.hands, performance.now(), REMOTE_ASPECT);
  }

  private reportStatus(force: boolean): void {
    const local = useArc.getState().local;
    if (!force && !this.capturing) return;
    const status = this.capturing ? "ACTIVE" : local.camera === "error" ? "ERROR" : local.camera === "starting" ? "STARTING" : "IDLE";
    this.arc.send({ type: "VISION_STATUS", source: this.role, status, error: local.cameraError, fps: local.trackerFps, hands: local.hands });
  }

  private send(status: "IDLE" | "STARTING" | "ACTIVE" | "ERROR", error?: string): void {
    this.arc.send({ type: "VISION_STATUS", source: this.role, status, error });
  }
}
