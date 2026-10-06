/**
 * Gaze calibration: a ridge regression from eye/head features to normalized
 * screen coordinates, fitted from samples collected while the user looks at
 * known points. Pure math (no DOM) so it can be unit-tested.
 */

export interface CalibrationSample {
  features: number[];
  /** Target, normalized screen coordinates 0..1. */
  x: number;
  y: number;
}

export interface GazeModel {
  version: 1;
  mean: number[];
  std: number[];
  wx: number[];
  wy: number[];
  /** RMS fit error, normalized screen units. */
  rms: number;
  screen: { w: number; h: number };
  createdAt: number;
}

/** 9-point grid (centre first). Margins keep points clear of screen edges. */
export const CALIBRATION_POINTS: { x: number; y: number }[] = [
  { x: 0.5, y: 0.5 },
  { x: 0.1, y: 0.1 },
  { x: 0.5, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.5 },
  { x: 0.9, y: 0.9 },
  { x: 0.5, y: 0.9 },
  { x: 0.1, y: 0.9 },
  { x: 0.1, y: 0.5 },
];

const RIDGE = 0.02;

/** Solve (A + λI) w = b with Gaussian elimination (small systems only). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    [M[c], M[pivot]] = [M[pivot], M[c]];
    const d = M[c][c] || 1e-12;
    for (let k = c; k <= n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row[n]);
}

function design(features: number[], mean: number[], std: number[]): number[] {
  return [1, ...features.map((f, i) => (f - mean[i]) / std[i])];
}

export type FitResult = { ok: true; model: GazeModel } | { ok: false; reason: string };

export function fitGazeModel(samples: CalibrationSample[], screen: { w: number; h: number }): FitResult {
  const targets = new Set(samples.map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)}`));
  if (targets.size < 5 || samples.length < 30) return { ok: false, reason: "Not enough stable samples — keep your face in view" };
  const dims = samples[0].features.length;
  const mean = new Array(dims).fill(0);
  const std = new Array(dims).fill(0);
  for (const s of samples) s.features.forEach((f, i) => (mean[i] += f / samples.length));
  for (const s of samples) s.features.forEach((f, i) => (std[i] += (f - mean[i]) ** 2 / samples.length));
  for (let i = 0; i < dims; i++) std[i] = Math.sqrt(std[i]) || 1;
  // The eye signal (h, v) must actually move, otherwise the "fit" would only track head position.
  const eyeSpread = Math.max(std[0], std[1]);
  if (eyeSpread < 0.004) return { ok: false, reason: "No eye movement detected — follow each point with your eyes" };

  const X = samples.map((s) => design(s.features, mean, std));
  const k = X[0].length;
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  const Xty2 = new Array(k).fill(0);
  X.forEach((row, n) => {
    for (let i = 0; i < k; i++) {
      Xty[i] += row[i] * samples[n].x;
      Xty2[i] += row[i] * samples[n].y;
      for (let j = 0; j < k; j++) XtX[i][j] += row[i] * row[j];
    }
  });
  for (let i = 1; i < k; i++) XtX[i][i] += RIDGE * samples.length; // don't penalise the intercept
  const wx = solve(XtX, Xty);
  const wy = solve(XtX, Xty2);

  let se = 0;
  X.forEach((row, n) => {
    const px = dot(row, wx);
    const py = dot(row, wy);
    se += (px - samples[n].x) ** 2 + (py - samples[n].y) ** 2;
  });
  const rms = Math.sqrt(se / samples.length);
  if (!Number.isFinite(rms) || rms > 0.3) return { ok: false, reason: "Calibration was too noisy — hold your head still and try again" };
  return { ok: true, model: { version: 1, mean, std, wx, wy, rms, screen, createdAt: Date.now() } };
}

export function predictGaze(model: GazeModel, features: number[]): { x: number; y: number } {
  const row = design(features, model.mean, model.std);
  return { x: dot(row, model.wx), y: dot(row, model.wy) };
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// ─── Persistence (per device; calibration depends on that device's camera + screen) ───

const key = (role: string) => `arc.gazeModel.${role}`;

export function loadGazeModel(role: string): GazeModel | null {
  try {
    const m = JSON.parse(localStorage.getItem(key(role)) ?? "null") as GazeModel | null;
    return m?.version === 1 ? m : null;
  } catch {
    return null;
  }
}

export function saveGazeModel(role: string, model: GazeModel | null): void {
  try {
    if (model) localStorage.setItem(key(role), JSON.stringify(model));
    else localStorage.removeItem(key(role));
  } catch {
    // storage unavailable — calibration lasts for this page session only
  }
}

/** A stored calibration is stale if the screen changed shape substantially (rotation, new monitor). */
export function modelFitsScreen(model: GazeModel, w: number, h: number): boolean {
  const ar = (a: number, b: number) => a / b;
  return Math.abs(ar(model.screen.w, model.screen.h) - ar(w, h)) < 0.25 && Math.abs(model.screen.w - w) / model.screen.w < 0.35;
}
