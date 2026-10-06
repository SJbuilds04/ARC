import { OneEuroFilter } from "../gestures/OneEuroFilter";

export interface GazeSettings {
  /** Gain around the screen centre (1 = calibrated mapping). */
  sensitivity: number;
  /** 0 = responsive … 1 = very smooth. */
  smoothing: number;
  dwellEnabled: boolean;
  dwellMs: number;
}

export const DEFAULT_GAZE_SETTINGS: GazeSettings = { sensitivity: 1, smoothing: 0.55, dwellEnabled: false, dwellMs: 1000 };

const WINDOW = 5;

/**
 * Raw gaze is noisy (iris landmarks jitter by a few pixels; screen error is
 * amplified ~30×). Stages: confidence gate → moving average → sensitivity →
 * One Euro filter → fixation dead zone → confidence-scaled step limit.
 */
export class GazeSmoother {
  private history: { x: number; y: number }[] = [];
  private fx = new OneEuroFilter();
  private fy = new OneEuroFilter();
  private current: { x: number; y: number } | null = null;
  private settingsKey = "";

  update(raw: { x: number; y: number }, confidence: number, t: number, screen: { w: number; h: number }, settings: GazeSettings): { x: number; y: number } | null {
    this.configure(settings);
    // Low confidence: hold the cursor rather than letting it jump.
    if (confidence < 0.35) return this.current;

    this.history.push(raw);
    if (this.history.length > WINDOW) this.history.shift();
    const avg = this.history.reduce((a, p) => ({ x: a.x + p.x / this.history.length, y: a.y + p.y / this.history.length }), { x: 0, y: 0 });

    const s = settings.sensitivity;
    const tx = clamp((0.5 + (avg.x - 0.5) * s) * screen.w, 0, screen.w);
    const ty = clamp((0.5 + (avg.y - 0.5) * s) * screen.h, 0, screen.h);
    const fx = this.fx.filter(tx, t);
    const fy = this.fy.filter(ty, t);

    if (!this.current) {
      this.current = { x: fx, y: fy };
      return this.current;
    }
    const dx = fx - this.current.x;
    const dy = fy - this.current.y;
    const dist = Math.hypot(dx, dy);
    // Fixation: small wobble around a point shouldn't move the cursor.
    const dead = (10 + settings.smoothing * 22) * (screen.w / 1400 + 0.4);
    if (dist < dead) return this.current;
    // Step limit scaled by confidence: shaky tracking moves the cursor more cautiously.
    const maxStep = screen.w * (0.04 + 0.12 * confidence);
    const k = Math.min(1, maxStep / dist);
    this.current = { x: this.current.x + dx * k, y: this.current.y + dy * k };
    return this.current;
  }

  reset(): void {
    this.history = [];
    this.fx.reset();
    this.fy.reset();
    this.current = null;
  }

  private configure(settings: GazeSettings): void {
    const key = settings.smoothing.toFixed(2);
    if (key === this.settingsKey) return;
    this.settingsKey = key;
    // Smoother → lower cutoff. beta lets fast saccades through with little lag.
    const minCutoff = 2.2 - settings.smoothing * 1.9;
    this.fx = new OneEuroFilter(minCutoff, 0.006, 1);
    this.fy = new OneEuroFilter(minCutoff, 0.006, 1);
  }
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
