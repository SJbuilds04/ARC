import type { FaceFrame, Point3 } from "./FaceTracker";

/** MediaPipe face-mesh indices used by VISOR (subject's perspective). */
export const LM = {
  rightEye: { outer: 33, inner: 133, upper: 159, lower: 145, iris: 468, ring: [469, 470, 471, 472] },
  leftEye: { outer: 263, inner: 362, upper: 386, lower: 374, iris: 473, ring: [474, 475, 476, 477] },
  noseTip: 1,
  forehead: 10,
  chin: 152,
  faceOval: [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
  rightBrow: [70, 63, 105, 66, 107],
  leftBrow: [300, 293, 334, 296, 336],
} as const;

export interface EyeMeasure {
  /** Iris position along the eye, measured left → right in the image for BOTH eyes (≈0.3…0.7). */
  h: number;
  /** Iris offset from the lid midline, in eye widths (down = positive). */
  v: number;
  /** Lid opening / eye width. ~0.25 open, < 0.12 closed. */
  open: number;
  /** Eye width as a fraction of the frame width (distance proxy). */
  width: number;
}

export interface HeadPose {
  yaw: number;
  pitch: number;
  roll: number;
}

export interface GazeSample {
  left: EyeMeasure;
  right: EyeMeasure;
  head: HeadPose;
  /** Face centre (nose tip), raw image coordinates 0..1. */
  cx: number;
  cy: number;
  blink: boolean;
  /** Regression features (see GazeCalibration). */
  features: number[];
}

/** `from`/`to` are the image-left and image-right eye corners, so both eyes move the same way. */
function measureEye(p: readonly Point3[], eye: typeof LM.rightEye | typeof LM.leftEye, from: number, to: number, aspect: number): EyeMeasure {
  const P = (i: number) => ({ x: p[i].x * aspect, y: p[i].y });
  const o = P(from);
  const n = P(to);
  const up = P(eye.upper);
  const lo = P(eye.lower);
  const iris = P(eye.iris);
  const ex = n.x - o.x;
  const ey = n.y - o.y;
  const len = Math.hypot(ex, ey) || 1e-6;
  const ux = ex / len;
  const uy = ey / len;
  // Perpendicular, pointing "down" the face.
  const px = -uy;
  const py = ux;
  const sign = (lo.x - up.x) * px + (lo.y - up.y) * py >= 0 ? 1 : -1;
  const mx = (up.x + lo.x) / 2;
  const my = (up.y + lo.y) / 2;
  return {
    h: ((iris.x - o.x) * ux + (iris.y - o.y) * uy) / len,
    v: (sign * ((iris.x - mx) * px + (iris.y - my) * py)) / len,
    open: Math.hypot(lo.x - up.x, lo.y - up.y) / len,
    width: len / aspect,
  };
}

const DEG = 180 / Math.PI;

/** Head pose from the facial transformation matrix (column-major 4×4). */
export function headPose(matrix: number[] | null, p: readonly Point3[]): HeadPose {
  if (matrix && matrix.length === 16) {
    // Rotation part, column-major: r(row, col) = m[col * 4 + row]
    const r = (row: number, col: number) => matrix[col * 4 + row];
    const pitch = Math.asin(Math.max(-1, Math.min(1, -r(1, 2))));
    const yaw = Math.atan2(r(0, 2), r(2, 2));
    const roll = Math.atan2(r(1, 0), r(1, 1));
    return { yaw: yaw * DEG, pitch: pitch * DEG, roll: roll * DEG };
  }
  // Fallback from landmarks: rough but real.
  const l = p[LM.rightEye.outer];
  const rr = p[LM.leftEye.outer];
  const nose = p[LM.noseTip];
  const mid = (l.x + rr.x) / 2;
  const span = Math.abs(rr.x - l.x) || 1e-6;
  return {
    yaw: ((nose.x - mid) / span) * 90,
    pitch: ((nose.y - (p[LM.forehead].y + p[LM.chin].y) / 2) / span) * 90,
    roll: Math.atan2(rr.y - l.y, rr.x - l.x) * DEG,
  };
}

/**
 * EyeTracker — turns a face frame into gaze features: iris position inside each
 * eye (eye-in-head) plus head pose and face position (head-in-world). The
 * calibration regression maps these to screen coordinates.
 */
export function sampleGaze(face: FaceFrame): GazeSample {
  const p = face.points;
  // Subject's right eye is image-left (outer → inner); subject's left eye is image-right (inner → outer).
  const right = measureEye(p, LM.rightEye, LM.rightEye.outer, LM.rightEye.inner, face.aspect);
  const left = measureEye(p, LM.leftEye, LM.leftEye.inner, LM.leftEye.outer, face.aspect);
  const head = headPose(face.matrix, p);
  const nose = p[LM.noseTip];
  const blink = Math.max(face.blinkLeft, face.blinkRight) > 0.5 || Math.min(left.open, right.open) < 0.11;
  const h = (left.h + right.h) / 2;
  const v = (left.v + right.v) / 2;
  return {
    left,
    right,
    head,
    cx: nose.x,
    cy: nose.y,
    blink,
    features: [h, v, head.yaw / 30, head.pitch / 30, nose.x, nose.y],
  };
}
