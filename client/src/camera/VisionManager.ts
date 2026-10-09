import type { ArcState, DeviceRole, Hand, ServerMessageOf } from "@shared/types";
import type { ArcClient } from "../core/ArcClient";
import { useArc, setLocal, notify, dismissCode } from "../core/store";
import { Emitter } from "../core/emitter";
import { CameraSource } from "./CameraSource";
import { VideoLink } from "./VideoLink";
import type { GestureManager } from "../gestures/GestureManager";
import { VisionEngine, type ModelHandle, type PersonMask } from "./VisionEngine";
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
  readonly engine = new VisionEngine();
  /** Hand model handle (kept as `tracker` for existing callers). */
  readonly tracker: ModelHandle = this.engine.hands;
  readonly faceModel: ModelHandle = this.engine.face;
  /** Set by the VISOR while it needs face landmarks. */
  faceWanted = false;
  /** The phone is touch-first: its camera skips hand tracking unless switched on, or it's the PC's camera. */
  private get handsWanted(): boolean {
    return this.role !== "PHONE" || this.relay || Boolean(useArc.getState().state?.vision.phoneHands);
  }
  /** Live video between devices: the phone's camera shown in the PC's camera panel. */
  private readonly link: VideoLink;
  private remoteStream: MediaStream | null = null;
  private linkMode = "";
  private relayTo: DeviceRole | null = null;
  private handsBusy = false;
  private faceBusy = false;
  private faceListeners = new Set<(face: FaceFrame | null, now: number) => void>();
  /** The exact frame the latest face landmarks belong to (worker path) — drawn by the visor so the HUD never drifts. */
  latestFrame: { bitmap: ImageBitmap; at: number; mask: PersonMask | null } | null = null;
  private stats = { camera: 0, hands: 0, face: 0, handsMs: 0, faceMs: 0, since: performance.now() };
  private capturing = false;
  private starting = false;
  /** Start-up failed: wait for RECONNECT / TRY AGAIN instead of retrying on every state update. */
  private failed = false;
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

  /** 1 hand outside the Playground (lowest latency), 2 where two-hand zoom is used. */
  setMaxHands(n: 1 | 2): void {
    (this.tracker as unknown as { setNumHands(n: number): void }).setNumHands(n);
  }

  constructor(
    private readonly role: DeviceRole,
    private readonly arc: ArcClient,
    private readonly gestures: GestureManager,
  ) {
    super();
    this.link = new VideoLink(arc);
    this.link.onRemote = (stream) => {
      this.remoteStream = stream;
      this.emitPreview();
    };
    useArc.subscribe((s, prev) => {
      if (s.state !== prev.state || s.engaged !== prev.engaged) this.reconcile(s.state);
    });
    arc.on("HAND_FRAME", (msg) => this.onRemoteFrame(msg));
    // After a reconnect the server has forgotten our camera status — report it again.
    arc.on("open", () => {
      this.reportStatus(true);
      // the handshake may have been lost with the connection: ask for the video again
      if (this.linkMode.startsWith("recv:")) this.link.receive(this.linkMode.slice(5) as DeviceRole);
    });
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

  /** What the camera panel shows: this device's camera, or the remote camera it's using (the phone's). */
  get stream(): MediaStream | null {
    return this.consumesRemote.length ? this.remoteStream : this.camera.stream;
  }

  /** Whether the remote camera's video has arrived (the panel says CONNECTING until it does). */
  get remoteVideo(): boolean {
    return Boolean(this.remoteStream);
  }

  private emitPreview(): void {
    this.emit("stream", this.stream);
  }

  /** Send this camera's video to the device using it, or receive the remote camera's video. */
  private syncLink(): void {
    const next = (this.capturing || this.starting) && this.relayTo && this.camera.active ? `send:${this.relayTo}` : this.consumesRemote.length ? `recv:${this.consumesRemote[0]}` : "";
    if (next === this.linkMode) return;
    if (this.linkMode) this.link.stop();
    this.linkMode = next;
    if (next.startsWith("send:")) this.link.send(this.camera.stream!, this.relayTo!);
    else if (next.startsWith("recv:")) this.link.receive(this.consumesRemote[0]);
  }

  private reconcile(state: ArcState | null): void {
    if (!state) return;
    const routes = state.vision.routes;
    const shouldCapture = routes.some((r) => r.source === this.role);
    this.relay = routes.some((r) => r.source === this.role && r.consumer !== this.role);
    this.relayTo = routes.find((r) => r.source === this.role && r.consumer !== this.role)?.consumer ?? null;
    const wasRemote = this.consumesRemote.join();
    this.consumesRemote = routes.filter((r) => r.consumer === this.role && r.source !== this.role).map((r) => r.source);
    if (this.consumesRemote.join() !== wasRemote) this.emitPreview();
    this.syncLink();

    if (!shouldCapture) this.failed = false;
    if (shouldCapture && !this.capturing && !this.starting && !this.failed) void this.startCapture();
    else if (!shouldCapture && (this.capturing || this.starting)) this.stopCapture();
  }

  /** Called from UI (e.g. RECONNECT on a vision error). */
  retry(): void {
    this.failed = false;
    this.stopCapture();
    this.reconcile(useArc.getState().state);
  }

  private async startCapture(): Promise<void> {
    this.starting = true;
    setLocal({ camera: "starting", cameraError: undefined });
    this.send("STARTING");
    try {
      // the video can go to the PC as soon as the camera is open, while the hand model still loads
      const camera = this.camera.start(() => this.onCameraEnded()).then(() => this.starting && this.syncLink());
      await Promise.all([camera, this.loadTracker()]);
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
      this.emitPreview();
      this.syncLink();
      this.send("ACTIVE");
      this.loop();
      this.statusTimer = window.setInterval(() => this.reportStatus(false), 1000);
    } catch (err) {
      this.starting = false;
      this.failed = true;
      this.camera.stop();
      this.syncLink();
      const message = (err as Error).message || "Camera failed";
      setLocal({ camera: "error", cameraError: message });
      this.send("ERROR", message);
      notify({ level: "error", title: "VISION SOURCE UNAVAILABLE", text: `${this.role} CAMERA · ${message}`, code: "CAMERA" }, 0);
    }
  }

  /** The hand model, with a clear reason when it can't load (usually: setup never copied its files). */
  private async loadTracker(): Promise<void> {
    try {
      await this.tracker.load();
    } catch (err) {
      const missing = await Promise.all(
        ["/mediapipe/vision_wasm_internal.js", "/models/hand_landmarker.task"].map((u) =>
          fetch(u, { method: "HEAD" }).then((r) => !r.ok, () => false),
        ),
      );
      if (missing.some(Boolean)) throw new Error("Hand tracking files are missing on this PC: run npm run setup, then npm run build, and restart ARC");
      throw new Error(`Hand tracking couldn't start: ${(err as Error).message || "unknown error"}`);
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
    this.emitPreview();
    this.syncLink();
    this.send("IDLE");
  }

  private onCameraEnded(): void {
    if (!this.capturing) return;
    this.capturing = false;
    this.camera.stop();
    setLocal({ camera: "error", cameraError: "Camera disconnected" });
    this.send("ERROR", "Camera disconnected");
    this.emitPreview();
    this.syncLink();
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
    const now = performance.now();
    this.stats.camera++;
    const aspect = this.camera.aspect;
    const video = this.camera.video;
    // Hands and face run in parallel on separate workers; each skips frames while busy.
    if (this.handsWanted && !this.handsBusy && this.tracker.ready && this.frameIndex++ % this.handEvery === 0) {
      this.handsBusy = true;
      const t0 = performance.now();
      this.engine
        .runHands(video, now, aspect)
        .then((hands) => {
          this.stats.hands++;
          this.stats.handsMs = this.stats.handsMs * 0.8 + (performance.now() - t0) * 0.2;
          this.onResult(hands, undefined, now);
        })
        .catch((err) => console.warn("[vision] hands failed", err))
        .finally(() => (this.handsBusy = false));
    }
    if (this.faceWanted && !this.faceBusy && this.faceModel.ready) {
      this.faceBusy = true;
      const t0 = performance.now();
      this.engine
        .runFace(video, now, aspect)
        .then((r) => {
          this.stats.face++;
          this.stats.faceMs = this.stats.faceMs * 0.8 + (performance.now() - t0) * 0.2;
          if (r.bitmap) {
            if (!this.faceWanted || !this.capturing) r.bitmap.close();
            else {
              this.latestFrame?.bitmap.close();
              this.latestFrame = { bitmap: r.bitmap, at: performance.now(), mask: r.mask ?? null };
            }
          }
          if (this.capturing) for (const l of this.faceListeners) l(r.face, now);
        })
        .catch((err) => console.warn("[vision] face failed", err))
        .finally(() => (this.faceBusy = false));
    } else if (!this.faceWanted && this.latestFrame) {
      this.latestFrame.bitmap.close();
      this.latestFrame = null;
    }
    const st = this.stats;
    if (now - st.since >= 1000) {
      const k = 1000 / (now - st.since);
      setLocal({
        trackerFps: Math.round(st.hands * k),
        perf: { camera: Math.round(st.camera * k), hands: Math.round(st.hands * k), face: Math.round(st.face * k), handsMs: Math.round(st.handsMs), faceMs: Math.round(st.faceMs), handsWhere: this.tracker.where, faceWhere: this.faceModel.where },
      });
      Object.assign(st, { camera: 0, hands: 0, face: 0, since: now });
    }
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
      setLocal({ hands: hands.length });
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
