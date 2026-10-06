import type { DeviceRole, ServerMessageOf, VisorGaze, VisorHands } from "@shared/types";
import type { ArcClient } from "../core/ArcClient";
import type { VisionManager } from "../camera/VisionManager";
import type { GestureManager } from "../gestures/GestureManager";
import type { HandPointer } from "../gestures/HandPointer";
import { Emitter } from "../core/emitter";
import { savePref } from "../core/device";
import { useArc, setVisor } from "../core/store";
import type { FaceFrame } from "./FaceTracker";
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
/** HUD status values that change continuously are pushed to React at most this often. */
const UI_THROTTLE_MS = 400;

export interface FaceEvent {
  face: FaceFrame;
  sample: GazeSample;
}

/**
 * VisorManager — owns VISOR on this device: face tracking for the helmet HUD,
 * and (optional, off by default) the eye-tracking cursor with calibration,
 * smoothing and targeting. Created once and never destroyed; ARC mode changes
 * only switch it on and off.
 */
export class VisorManager extends Emitter<{ face: FaceEvent | null }> {
  readonly cursor = new GazeCursor();
  readonly targeting: TargetingManager;
  private smoother = new GazeSmoother();
  private model: GazeModel | null = null;
  private active = false;
  private fullVisor = false;
  private gazeOn = false;
  private lastFaceAt = 0;
  private lastHandAt = 0;
  private confidenceEma = 0;
  private calib: { index: number; pointStart: number; pointSamples: number; samples: CalibrationSample[]; lastFrame: number } | null = null;
  private bootToken = 0;
  private statusTimer: number | null = null;
  private lastStatusKey = "";
  private lastStatusSent = 0;
  private lastUiPush = 0;
  /** Latest face event (for renderers that poll instead of subscribing). */
  latest: FaceEvent | null = null;
  /** Smoothed gaze point in viewport px (null when unknown / gaze off). */
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

    vision.onFace((face, now) => this.onFace(face, now));
    gestures.on("frame", ({ hands }) => {
      if (hands.length) this.lastHandAt = performance.now();
    });
    useArc.subscribe((s, prev) => {
      if (s.state !== prev.state) this.reconcile();
    });
    arc.on("VISOR_COMMAND", (m: ServerMessageOf<"VISOR_COMMAND">) => {
      if (m.command !== "RECALIBRATE" || !this.active) return;
      if (!this.settings.gazeEnabled) this.updateSettings({ gazeEnabled: true });
      this.startCalibration();
    });
    arc.on("open", () => (this.lastStatusKey = ""));
    window.addEventListener("resize", () => {
      if (this.gazeOn && this.model && !modelFitsScreen(this.model, innerWidth, innerHeight)) this.startCalibration();
    });
  }

  get isActive(): boolean {
    return this.active;
  }

  private get settings(): GazeSettings {
    return useArc.getState().visor.settings;
  }

  /** VISOR on the visor device (face HUD); Playground on the PC only when the gaze cursor is enabled. */
  private wanted(): { on: boolean; full: boolean } {
    const s = useArc.getState().state;
    if (!s) return { on: false, full: false };
    if (s.mode === "VISOR" && s.visor.device === this.role) return { on: true, full: true };
    if (s.mode === "PLAYGROUND" && this.role === "PC" && s.visor.gazeInPlayground && this.settings.gazeEnabled) return { on: true, full: false };
    return { on: false, full: false };
  }

  private reconcile(): void {
    const { on, full } = this.wanted();
    const wasFull = this.fullVisor;
    this.fullVisor = full;
    if (on && !this.active) this.activate(full);
    else if (!on && this.active) this.deactivate();
    else if (on && full && !wasFull) void this.boot();
  }

  private activate(full: boolean): void {
    this.active = true;
    this.vision.faceWanted = true;
    this.statusTimer = window.setInterval(() => this.reportStatus(), 500);
    this.applyGaze();
    if (full) void this.boot();
    else void this.vision.faceModel.load().then(() => this.afterBoot()).catch(() => setVisor({ phase: "tracking", face: "OFF", message: "FACE TRACKING UNAVAILABLE" }));
  }

  private deactivate(): void {
    this.active = false;
    this.bootToken++;
    this.calib = null;
    this.vision.faceWanted = false;
    this.setGaze(false);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.latest = null;
    setVisor({ phase: "off", face: "OFF", gaze: "OFF", hands: "OFF", confidence: null, message: null, target: null, boot: [] });
    this.emit("face", null);
  }

  /** Gaze cursor on/off follows the setting while VISOR is active. */
  private applyGaze(): void {
    this.setGaze(this.active && this.settings.gazeEnabled);
  }

  private setGaze(on: boolean): void {
    if (this.gazeOn === on) return;
    this.gazeOn = on;
    this.smoother.reset();
    this.point = null;
    if (on) {
      this.pointer.setDelegate({ press: () => this.targeting.press(), release: () => this.targeting.release() });
      this.cursor.show(true);
    } else {
      this.calib = null;
      this.pointer.setDelegate(null);
      this.targeting.clear();
      this.cursor.show(false);
    }
  }

  // ─── Boot: real checks, fast ───

  private async boot(): Promise<void> {
    const token = ++this.bootToken;
    const lines: { label: string; state: "pending" | "ok" | "warn" | "fail"; note?: string }[] = [];
    const push = async (label: string, state: "pending" | "ok" | "warn" | "fail", note?: string) => {
      lines.push({ label, state, note });
      setVisor({ boot: [...lines] });
      await new Promise((r) => setTimeout(r, 140));
    };
    setVisor({ phase: "boot", boot: [], face: "SCANNING", message: null });

    let faceOk = false;
    try {
      await this.vision.faceModel.load();
      const start = performance.now();
      while (token === this.bootToken && performance.now() - start < 4000) {
        if (performance.now() - this.lastFaceAt < 400) {
          faceOk = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    } catch {
      // reported below
    }
    if (token !== this.bootToken) return;
    const fm = this.vision.faceModel;
    await push("FACE TRACKING", faceOk ? "ok" : fm.error ? "fail" : "warn", faceOk ? undefined : fm.error ? "UNAVAILABLE" : "NO FACE · LOOK AT CAMERA");
    await push("HAND TRACKING", this.vision.tracker.ready ? "ok" : this.vision.tracker.error ? "fail" : "warn", this.vision.tracker.ready ? undefined : this.vision.tracker.error ? "UNAVAILABLE" : "LOADING");
    if (this.settings.gazeEnabled) await push("GAZE CURSOR", this.validModel() ? "ok" : "warn", this.validModel() ? undefined : "CALIBRATION REQUIRED");
    await push("JARVIS", this.arc.online ? "ok" : "fail", this.arc.online ? "ONLINE" : "OFFLINE");
    await new Promise((r) => setTimeout(r, 300));
    if (token !== this.bootToken) return;
    this.afterBoot();
  }

  private afterBoot(): void {
    if (!this.active) return;
    if (!this.gazeOn || this.validModel()) setVisor({ phase: "tracking", calibrated: Boolean(this.model) });
    else this.startCalibration();
  }

  private validModel(): boolean {
    return Boolean(this.model && modelFitsScreen(this.model, innerWidth, innerHeight));
  }

  // ─── Calibration (gaze cursor only) ───

  startCalibration(): void {
    if (!this.active || !this.gazeOn) return;
    this.calib = { index: 0, pointStart: performance.now(), pointSamples: 0, samples: [], lastFrame: performance.now() };
    this.targeting.clear();
    setVisor({ phase: "calibrating", calib: { index: 0, total: CALIBRATION_POINTS.length, paused: false } });
  }

  private stepCalibration(sample: GazeSample | null, now: number): void {
    const c = this.calib!;
    const dt = now - c.lastFrame;
    c.lastFrame = now;
    if (!sample) {
      c.pointStart += dt;
      setVisor({ calib: { index: c.index, total: CALIBRATION_POINTS.length, paused: true } });
      return;
    }
    const elapsed = now - c.pointStart;
    const point = CALIBRATION_POINTS[c.index];
    const collecting = elapsed > POINT_SETTLE_MS && (elapsed < POINT_MS || c.pointSamples < POINT_MIN_SAMPLES);
    if (!sample.blink && collecting) {
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

  // ─── Per-frame ───

  private onFace(frame: FaceFrame | null, now: number): void {
    if (!this.active) return;
    const sample = frame ? sampleGaze(frame) : null;
    if (frame && sample) {
      this.lastFaceAt = now;
      this.latest = { face: frame, sample };
      this.emit("face", this.latest);
    } else if (now - this.lastFaceAt > FACE_LOST_MS && this.latest) {
      this.latest = null;
      this.emit("face", null);
    }

    const ui = useArc.getState().visor;
    const faceState = sample ? "TRACKING" : now - this.lastFaceAt > FACE_LOST_MS ? "LOST" : ui.face;

    if (this.calib) {
      this.stepCalibration(sample, now);
      setVisor({ face: faceState, gaze: "CALIBRATING", hands: this.handsState() });
      return;
    }

    let gaze: VisorGaze = "OFF";
    let message: string | null = null;
    if (this.gazeOn) {
      gaze = this.model ? "LOST" : "UNCALIBRATED";
      if (this.model && ui.phase === "tracking") {
        if (sample) {
          const conf = confidence(sample);
          if (!sample.blink) this.confidenceEma = this.confidenceEma * 0.85 + conf * 0.15;
          const p = this.smoother.update(predictGaze(this.model, sample.features), sample.blink ? 0 : conf, now, { w: innerWidth, h: innerHeight }, this.settings);
          if (p) {
            this.point = p;
            this.cursor.move(p.x, p.y, sample.blink || conf < 0.35);
          }
          gaze = this.confidenceEma >= 0.5 ? "ACTIVE" : "LOW";
          if (gaze === "LOW") message = farAway(sample) ? "MOVE CLOSER TO CAMERA" : "GAZE CONFIDENCE LOW · FACE THE SCREEN";
        }
        if (!sample && now - this.lastFaceAt > GAZE_LOST_MS) gaze = "LOST";
        this.cursor.setLost(gaze === "LOST");
        this.targeting.update(gaze === "LOST" ? null : this.point, now);
      }
    } else if (sample && farAway(sample)) message = "MOVE CLOSER TO CAMERA";
    if (!sample && now - this.lastFaceAt > GAZE_LOST_MS && ui.phase === "tracking") message = "FACE LOST · LOOK AT THE CAMERA";
    const hands = this.handsState(); // shown in the status panel; not worth a banner every time a hand drops

    // Discrete states immediately; continuous values throttled (avoids React work every frame).
    const patch = { face: faceState, gaze, hands, message } as const;
    const discreteChanged = ui.face !== patch.face || ui.gaze !== patch.gaze || ui.hands !== patch.hands || ui.message !== patch.message;
    if (discreteChanged || now - this.lastUiPush > UI_THROTTLE_MS) {
      this.lastUiPush = now;
      setVisor({ ...patch, confidence: sample && this.gazeOn ? Math.round(this.confidenceEma * 20) / 20 : null });
    }
  }

  private handsState(): VisorHands {
    if (this.vision.tracker.error) return "UNAVAILABLE";
    const since = performance.now() - this.lastHandAt;
    if (since < 400) return "TRACKING";
    if (since < 4000 && this.lastHandAt > 0) return "LOST";
    return "STANDBY";
  }

  /** Summary to ARC Core: state changes promptly. Gaze coordinates and video never leave the device. */
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
    const settings = { ...this.settings, ...patch };
    settings.sensitivity = Math.min(1.6, Math.max(0.6, settings.sensitivity));
    settings.smoothing = Math.min(0.95, Math.max(0, settings.smoothing));
    settings.dwellMs = Math.min(1600, Math.max(600, settings.dwellMs));
    setVisor({ settings });
    savePref("gazeSettings", settings);
    if ("gazeEnabled" in patch) {
      this.reconcile();
      this.applyGaze();
      if (this.gazeOn && !this.validModel()) this.startCalibration();
      if (!this.gazeOn && useArc.getState().visor.phase !== "off") setVisor({ phase: "tracking" });
    }
  }

  forgetCalibration(): void {
    this.model = null;
    saveGazeModel(this.role, null);
    setVisor({ calibrated: false });
  }
}

function confidence(s: GazeSample): number {
  let c = 1;
  const w = (s.left.width + s.right.width) / 2;
  if (w < 0.03) c *= Math.max(0, w / 0.03);
  const yaw = Math.abs(s.head.yaw);
  const pitch = Math.abs(s.head.pitch);
  if (yaw > 25) c *= Math.max(0, 1 - (yaw - 25) / 20);
  if (pitch > 22) c *= Math.max(0, 1 - (pitch - 22) / 18);
  if (Math.abs(s.left.h - s.right.h) > 0.18) c *= 0.6;
  return c;
}

function farAway(s: GazeSample): boolean {
  return (s.left.width + s.right.width) / 2 < 0.022;
}
