import type { DeviceRole, ServerMessageOf, VisorGaze, VisorHands } from "@shared/types";
import type { ArcClient } from "../core/ArcClient";
import type { VisionManager } from "../camera/VisionManager";
import type { GestureManager } from "../gestures/GestureManager";
import type { HandPointer } from "../gestures/HandPointer";
import { Emitter } from "../core/emitter";
import { savePref } from "../core/device";
import { useArc, setVisor } from "../core/store";
import { FaceTracker, type FaceFrame } from "./FaceTracker";
import { sampleGaze, type GazeSample } from "./EyeTracker";
import { CALIBRATION_POINTS, fitGazeModel, loadGazeModel, modelFitsScreen, predictGaze, saveGazeModel, type CalibrationSample, type GazeModel } from "./GazeCalibration";
import { GazeSmoother, type GazeSettings } from "./GazeSmoother";
import { GazeCursor } from "./GazeCursor";
import { TargetingManager } from "./TargetingManager";

const FACE_LOST_MS = 500;
const GAZE_LOST_MS = 700;
const POINT_SETTLE_MS = 450;
const POINT_MS = 1350;
/** Slow devices get more time per point: advance only once enough samples exist (or after POINT_MAX_MS). */
const POINT_MIN_SAMPLES = 6;
const POINT_MAX_MS = 5000;

export interface FaceEvent {
  face: FaceFrame;
  sample: GazeSample;
}

/**
 * VisorManager — owns VISOR on this device: face tracking, gaze estimation,
 * calibration, smoothing, the gaze cursor and targeting. Created once (in
 * services) and never destroyed; ARC mode changes only switch it on and off.
 *
 *   EYES → cursor     HANDS → pinch = click     VOICE → JARVIS
 */
export class VisorManager extends Emitter<{ face: FaceEvent | null }> {
  readonly face = new FaceTracker();
  readonly cursor = new GazeCursor();
  readonly targeting: TargetingManager;
  private smoother = new GazeSmoother();
  private model: GazeModel | null = null;
  private active = false;
  private fullVisor = false;
  private lastFaceAt = 0;
  private lastHandAt = 0;
  private confidenceEma = 0;
  private calib: { index: number; pointStart: number; pointSamples: number; samples: CalibrationSample[]; lastFrame: number } | null = null;
  private bootToken = 0;
  private statusTimer: number | null = null;
  private lastStatusKey = "";
  private lastStatusSent = 0;
  /** Smoothed gaze point in viewport px (null when unknown). */
  point: { x: number; y: number } | null = null;

  constructor(
    private readonly role: DeviceRole,
    private readonly arc: ArcClient,
    private readonly vision: VisionManager,
    gestures: GestureManager,
    private readonly pointer: HandPointer,
  ) {
    super();
    this.targeting = new TargetingManager(this.cursor, pointer, () => useArc.getState().visor.settings);
    this.targeting.onChange = (target) => setVisor({ target });
    this.model = loadGazeModel(role);
    setVisor({ calibrated: Boolean(this.model) });

    vision.onFrame((video, now, aspect) => this.onFrame(video, now, aspect));
    gestures.on("frame", ({ hands }) => {
      if (hands.length) this.lastHandAt = performance.now();
    });
    useArc.subscribe((s, prev) => {
      if (s.state !== prev.state) this.reconcile();
    });
    arc.on("VISOR_COMMAND", (m: ServerMessageOf<"VISOR_COMMAND">) => {
      if (m.command === "RECALIBRATE" && this.active) this.startCalibration();
    });
    arc.on("open", () => (this.lastStatusKey = "")); // re-report after reconnect
    window.addEventListener("resize", () => {
      if (this.active && this.model && !modelFitsScreen(this.model, innerWidth, innerHeight)) this.startCalibration();
    });
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Gaze runs in VISOR on the visor device, and in Playground on the PC when carried over from VISOR. */
  private wanted(): { on: boolean; full: boolean } {
    const s = useArc.getState().state;
    if (!s) return { on: false, full: false };
    if (s.mode === "VISOR" && s.visor.device === this.role) return { on: true, full: true };
    if (s.mode === "PLAYGROUND" && this.role === "PC" && s.visor.gazeInPlayground) return { on: true, full: false };
    return { on: false, full: false };
  }

  private reconcile(): void {
    const { on, full } = this.wanted();
    const wasFull = this.fullVisor;
    this.fullVisor = full;
    if (on && !this.active) this.activate(full);
    else if (!on && this.active) this.deactivate();
    else if (on && full && !wasFull) void this.boot(); // e.g. Playground → VISOR on the PC
  }

  private activate(full: boolean): void {
    this.active = true;
    this.smoother.reset();
    this.vision.handEvery = 2; // face + hands share the frame budget
    this.pointer.setDelegate({ press: () => this.targeting.press(), release: () => this.targeting.release() });
    this.cursor.show(true);
    this.statusTimer = window.setInterval(() => this.reportStatus(), 500);
    if (full) void this.boot();
    else void this.face.load().then(() => this.afterBoot()).catch(() => setVisor({ phase: "tracking", face: "OFF", message: "FACE TRACKING UNAVAILABLE" }));
  }

  private deactivate(): void {
    this.active = false;
    this.bootToken++;
    this.calib = null;
    this.vision.handEvery = 1;
    this.pointer.setDelegate(null);
    this.targeting.clear();
    this.cursor.show(false);
    this.point = null;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    setVisor({ phase: "off", face: "OFF", gaze: "OFF", hands: "OFF", confidence: null, message: null, target: null, boot: [] });
    this.emit("face", null);
  }

  // ─── Boot: real checks, fast ───

  private async boot(): Promise<void> {
    const token = ++this.bootToken;
    const lines: { label: string; state: "pending" | "ok" | "warn" | "fail"; note?: string }[] = [];
    const push = async (label: string, state: "pending" | "ok" | "warn" | "fail", note?: string) => {
      lines.push({ label, state, note });
      setVisor({ boot: [...lines] });
      await new Promise((r) => setTimeout(r, 170));
    };
    setVisor({ phase: "boot", boot: [], face: "SCANNING", message: null });

    let faceOk = false;
    try {
      await this.face.load();
      const start = performance.now();
      while (token === this.bootToken && performance.now() - start < 4000) {
        if (performance.now() - this.lastFaceAt < 300) {
          faceOk = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 60));
      }
    } catch {
      // reported below
    }
    if (token !== this.bootToken) return;
    await push("FACE TRACKING", faceOk ? "ok" : this.face.error ? "fail" : "warn", faceOk ? undefined : this.face.error ? "UNAVAILABLE" : "NO FACE · LOOK AT CAMERA");
    await push("GAZE TRACKING", this.validModel() ? "ok" : "warn", this.validModel() ? undefined : "CALIBRATION REQUIRED");
    await push("HAND TRACKING", this.vision.tracker.ready ? "ok" : this.vision.tracker.error ? "fail" : "warn", this.vision.tracker.ready ? undefined : this.vision.tracker.error ? "UNAVAILABLE" : "LOADING");
    await push("JARVIS", this.arc.online ? "ok" : "fail", this.arc.online ? "ONLINE" : "OFFLINE");
    await new Promise((r) => setTimeout(r, 380));
    if (token !== this.bootToken) return;
    this.afterBoot();
  }

  private afterBoot(): void {
    if (!this.active) return;
    if (this.validModel()) setVisor({ phase: "tracking", calibrated: true });
    else this.startCalibration();
  }

  private validModel(): boolean {
    return Boolean(this.model && modelFitsScreen(this.model, innerWidth, innerHeight));
  }

  // ─── Calibration ───

  startCalibration(): void {
    if (!this.active) return;
    this.calib = { index: 0, pointStart: performance.now(), pointSamples: 0, samples: [], lastFrame: performance.now() };
    this.targeting.clear();
    setVisor({ phase: "calibrating", calib: { index: 0, total: CALIBRATION_POINTS.length, paused: false } });
  }

  private stepCalibration(sample: GazeSample | null, now: number): void {
    const c = this.calib!;
    const dt = now - c.lastFrame;
    c.lastFrame = now;
    const usable = sample && !sample.blink;
    if (!sample) {
      // Face not visible: pause this point's timer until it's back.
      c.pointStart += dt;
      setVisor({ calib: { index: c.index, total: CALIBRATION_POINTS.length, paused: true } });
      return;
    }
    const elapsed = now - c.pointStart;
    const point = CALIBRATION_POINTS[c.index];
    const collecting = elapsed > POINT_SETTLE_MS && (elapsed < POINT_MS || c.pointSamples < POINT_MIN_SAMPLES);
    if (usable && collecting) {
      c.samples.push({ features: sample.features, x: point.x, y: point.y });
      c.pointSamples++;
    }
    if ((elapsed >= POINT_MS && c.pointSamples >= POINT_MIN_SAMPLES) || elapsed >= POINT_MAX_MS) {
      c.index++;
      c.pointStart = now;
      c.pointSamples = 0;
      if (c.index >= CALIBRATION_POINTS.length) {
        this.finishCalibration();
        return;
      }
    }
    setVisor({ calib: { index: c.index, total: CALIBRATION_POINTS.length, paused: false } });
  }

  private finishCalibration(): void {
    const samples = this.calib!.samples;
    this.calib = null;
    const fit = fitGazeModel(samples, { w: innerWidth, h: innerHeight });
    if (!fit.ok) {
      setVisor({ phase: "calibration-failed", calib: { index: 0, total: CALIBRATION_POINTS.length, paused: false, reason: fit.reason } });
      return;
    }
    this.model = fit.model;
    saveGazeModel(this.role, fit.model);
    this.smoother.reset();
    const px = Math.round(fit.model.rms * Math.hypot(innerWidth, innerHeight) * 0.7);
    setVisor({ phase: "tracking", calibrated: true, calib: { index: CALIBRATION_POINTS.length, total: CALIBRATION_POINTS.length, paused: false, rms: px } });
  }

  // ─── Frames ───

  private onFrame(video: HTMLVideoElement, now: number, aspect: number): void {
    if (!this.active || !this.face.ready) return;
    let frame: FaceFrame | null = null;
    try {
      frame = this.face.detect(video, now, aspect);
    } catch (err) {
      console.warn("[visor] face detect failed", err);
    }
    const sample = frame ? sampleGaze(frame) : null;
    if (frame && sample) {
      this.lastFaceAt = now;
      this.emit("face", { face: frame, sample });
    } else if (now - this.lastFaceAt > FACE_LOST_MS) this.emit("face", null);

    const faceState = sample ? "TRACKING" : now - this.lastFaceAt > FACE_LOST_MS ? "LOST" : useArc.getState().visor.face;
    const phase = useArc.getState().visor.phase;

    if (this.calib) {
      this.stepCalibration(sample, now);
      setVisor({ face: phase === "boot" ? "SCANNING" : faceState, gaze: "CALIBRATING", hands: this.handsState() });
      return;
    }

    let gaze: VisorGaze = this.model ? "LOST" : "UNCALIBRATED";
    let message: string | null = null;
    if (this.model && phase === "tracking") {
      if (sample) {
        const conf = confidence(sample);
        if (!sample.blink) this.confidenceEma = this.confidenceEma * 0.85 + conf * 0.15;
        const raw = predictGaze(this.model, sample.features);
        const p = this.smoother.update(raw, sample.blink ? 0 : conf, now, { w: innerWidth, h: innerHeight }, useArc.getState().visor.settings);
        if (p) {
          this.point = p;
          this.cursor.move(p.x, p.y, sample.blink || conf < 0.35);
        }
        gaze = this.confidenceEma >= 0.5 ? "ACTIVE" : "LOW";
        if (gaze === "LOW") message = farAway(sample) ? "MOVE CLOSER TO CAMERA" : "GAZE CONFIDENCE LOW · FACE THE SCREEN";
      }
      if (!sample && now - this.lastFaceAt > GAZE_LOST_MS) {
        gaze = "LOST";
        message = "FACE LOST · LOOK AT CAMERA TO RESUME";
      }
      this.cursor.setLost(gaze === "LOST");
      this.targeting.update(gaze === "LOST" ? null : this.point, now);
    }
    const hands = this.handsState();
    if (!message && hands === "LOST") message = "HAND TRACKING LOST · VOICE STILL ACTIVE";
    setVisor({
      face: phase === "boot" && faceState !== "TRACKING" ? "SCANNING" : faceState,
      gaze,
      hands,
      message,
      confidence: sample ? Math.round(this.confidenceEma * 100) / 100 : null,
    });
  }

  private handsState(): VisorHands {
    if (this.vision.tracker.error) return "UNAVAILABLE";
    const since = performance.now() - this.lastHandAt;
    if (since < 300) return "TRACKING";
    if (since < 4000 && this.lastHandAt > 0) return "LOST";
    return "STANDBY";
  }

  /** Summary to ARC Core: state changes promptly, confidence every few seconds. Gaze coordinates stay local. */
  private reportStatus(): void {
    const v = useArc.getState().visor;
    const key = `${v.face}|${v.gaze}|${v.hands}|${v.calibrated}|${v.target?.label ?? ""}`;
    const now = performance.now();
    if (key === this.lastStatusKey && now - this.lastStatusSent < 3000) return;
    this.lastStatusKey = key;
    this.lastStatusSent = now;
    this.arc.send({ type: "VISOR_STATUS", face: v.face, gaze: v.gaze, hands: v.hands, confidence: v.confidence, calibrated: v.calibrated, target: v.target?.label ?? null });
  }

  // ─── Settings ───

  updateSettings(patch: Partial<GazeSettings>): void {
    const settings = { ...useArc.getState().visor.settings, ...patch };
    settings.sensitivity = Math.min(1.6, Math.max(0.6, settings.sensitivity));
    settings.smoothing = Math.min(0.95, Math.max(0, settings.smoothing));
    settings.dwellMs = Math.min(1600, Math.max(600, settings.dwellMs));
    setVisor({ settings });
    savePref("gazeSettings", settings);
  }

  forgetCalibration(): void {
    this.model = null;
    saveGazeModel(this.role, null);
    setVisor({ calibrated: false });
  }
}

/** 0..1: how much to trust this gaze sample. */
function confidence(s: GazeSample): number {
  let c = 1;
  const w = (s.left.width + s.right.width) / 2;
  if (w < 0.03) c *= Math.max(0, w / 0.03); // too far from the camera
  const yaw = Math.abs(s.head.yaw);
  const pitch = Math.abs(s.head.pitch);
  if (yaw > 25) c *= Math.max(0, 1 - (yaw - 25) / 20);
  if (pitch > 22) c *= Math.max(0, 1 - (pitch - 22) / 18);
  const asym = Math.abs(s.left.h - s.right.h);
  if (asym > 0.18) c *= 0.6; // eyes disagree → likely a bad landmark fit
  return c;
}

function farAway(s: GazeSample): boolean {
  return (s.left.width + s.right.width) / 2 < 0.03;
}
