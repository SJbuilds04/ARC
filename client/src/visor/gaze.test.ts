import { test } from "node:test";
import assert from "node:assert/strict";
import { CALIBRATION_POINTS, fitGazeModel, predictGaze, type CalibrationSample } from "./GazeCalibration";
import { DEFAULT_GAZE_SETTINGS, GazeSmoother } from "./GazeSmoother";

// Deterministic pseudo-random noise.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

/** Simulated eye: iris shifts ~0.12 across the screen horizontally, ~0.06 vertically, plus head drift. */
function simulate(x: number, y: number, noise = 0.004) {
  const head = { yaw: rand() * 0.05, pitch: rand() * 0.05, cx: 0.5 + rand() * 0.01, cy: 0.5 + rand() * 0.01 };
  return [0.44 + (x - 0.5) * 0.12 + head.yaw * 0.1 + rand() * noise, (y - 0.5) * 0.06 + rand() * noise, head.yaw, head.pitch, head.cx, head.cy];
}

const screen = { w: 1600, h: 900 };

test("calibration recovers the gaze mapping", () => {
  const samples: CalibrationSample[] = [];
  for (const p of CALIBRATION_POINTS) for (let i = 0; i < 20; i++) samples.push({ features: simulate(p.x, p.y), ...p });
  const fit = fitGazeModel(samples, screen);
  assert.ok(fit.ok, fit.ok ? "" : fit.reason);
  if (!fit.ok) return;
  // Unseen points
  for (const q of [{ x: 0.3, y: 0.7 }, { x: 0.75, y: 0.25 }, { x: 0.5, y: 0.5 }]) {
    let ex = 0, ey = 0;
    for (let i = 0; i < 20; i++) {
      const g = predictGaze(fit.model, simulate(q.x, q.y));
      ex += Math.abs(g.x - q.x) / 20;
      ey += Math.abs(g.y - q.y) / 20;
    }
    assert.ok(ex < 0.06 && ey < 0.1, `error too high at ${JSON.stringify(q)}: ${ex.toFixed(3)}, ${ey.toFixed(3)}`);
  }
});

test("calibration refuses a frozen eye signal (e.g. a photo, or eyes not following)", () => {
  const samples: CalibrationSample[] = [];
  for (const p of CALIBRATION_POINTS) for (let i = 0; i < 20; i++) samples.push({ features: [0.44, 0, 0, 0, 0.5, 0.5], ...p });
  const fit = fitGazeModel(samples, screen);
  assert.equal(fit.ok, false);
});

test("calibration refuses too few samples", () => {
  const fit = fitGazeModel([{ features: simulate(0.5, 0.5), x: 0.5, y: 0.5 }], screen);
  assert.equal(fit.ok, false);
});

test("smoother: fixation jitter stays put, real moves arrive, low confidence holds", () => {
  const s = new GazeSmoother();
  let t = 0;
  let out = s.update({ x: 0.5, y: 0.5 }, 1, t, screen, DEFAULT_GAZE_SETTINGS)!;
  for (let i = 0; i < 30; i++) out = s.update({ x: 0.5 + rand() * 0.01, y: 0.5 + rand() * 0.01 }, 1, (t += 33), screen, DEFAULT_GAZE_SETTINGS)!;
  assert.ok(Math.abs(out.x - 800) < 30 && Math.abs(out.y - 450) < 30, `drifted during fixation: ${out.x}, ${out.y}`);

  for (let i = 0; i < 40; i++) out = s.update({ x: 0.85, y: 0.2 }, 1, (t += 33), screen, DEFAULT_GAZE_SETTINGS)!;
  assert.ok(Math.abs(out.x - 1360) < 40 && Math.abs(out.y - 180) < 40, `didn't reach target: ${out.x}, ${out.y}`);

  const held = s.update({ x: 0.1, y: 0.9 }, 0.1, (t += 33), screen, DEFAULT_GAZE_SETTINGS)!;
  assert.deepEqual(held, out);
});
