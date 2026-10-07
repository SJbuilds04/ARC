import { Surface, curve, constant, dome, gauss, band, wrapAngle, smooth, type Fn } from "./suitkit";

/**
 * The body every suit is built on: smooth anatomical surfaces (torso, pelvis, limbs, hands,
 * feet, head) and the joint positions that connect them. Metres, feet on y = 0, facing +z.
 * Limb surfaces are defined for the figure's left side (+x = lateral); the right side mirrors.
 */

export interface Proportions {
  /** Torso width / depth. */
  tw: number;
  td: number;
  /** Arm, leg, hand, head scale. */
  arm: number;
  leg: number;
  hand: number;
  head: number;
}

export const HEROIC: Proportions = { tw: 1, td: 1, arm: 1, leg: 1, hand: 1, head: 1 };

export interface FingerSpec {
  segs: Surface[];
  /** Knuckle position across the palm (z). */
  z: number;
  /** Fan angle (rotation about x). */
  splay: number;
  /** Relaxed curl per joint. */
  curl: number[];
}

export interface Anatomy {
  p: Proportions;
  torso: Surface;
  pelvis: Surface;
  neck: Surface;
  head: Surface;
  upperArm: Surface;
  forearm: Surface;
  palm: Surface;
  fingers: FingerSpec[];
  thumb: Surface[];
  pauldron: Surface;
  thigh: Surface;
  knee: Surface;
  shin: Surface;
  foot: Surface;
  j: {
    torsoY: number;
    pelvisY: number;
    hipX: number;
    hipY: number;
    thighLen: number;
    shinLen: number;
    ankleY: number;
    shoulderX: number;
    shoulderY: number;
    neckY: number;
    headY: number;
    upperLen: number;
    foreLen: number;
    palmLen: number;
    footBack: number;
    /** Arc reactor height on the torso surface (t). */
    reactorT: number;
  };
  /** Head profile helpers (for plates that follow the face). */
  headA: Fn;
}

const k = (f: Fn, s: number): Fn => (t) => f(t) * s;
/** Close both ends of a tube like a capsule. */
const capsule = (f: Fn, len = 0.22): Fn => dome(dome(f, len, true), len);

export function anatomy(p: Proportions = HEROIC, opts: { slim?: boolean } = {}): Anatomy {
  const slim = opts.slim ? 0.9 : 1;
  const tw = p.tw * slim;
  const td = p.td * (opts.slim ? 0.92 : 1);
  const hip = 0.7 + 0.3 * p.tw;

  // ── torso: waist → neck base ──
  const torso = new Surface({
    axis: "up",
    length: 0.565,
    a: dome(k(curve([[0, 0.15], [0.12, 0.138], [0.28, 0.15], [0.46, 0.17], [0.62, 0.186], [0.76, 0.196], [0.86, 0.188], [0.93, 0.142], [0.975, 0.092], [1, 0.07]]), tw), 0.035),
    bF: dome(k(curve([[0, 0.104], [0.12, 0.098], [0.28, 0.106], [0.46, 0.122], [0.62, 0.134], [0.76, 0.126], [0.86, 0.108], [0.93, 0.08], [0.975, 0.062], [1, 0.058]]), td), 0.035),
    bB: dome(k(curve([[0, 0.112], [0.12, 0.1], [0.28, 0.098], [0.46, 0.104], [0.62, 0.112], [0.76, 0.118], [0.86, 0.112], [0.93, 0.09], [0.975, 0.068], [1, 0.062]]), td), 0.035),
    n: curve([[0, 2.3], [0.5, 2.6], [0.8, 2.5], [1, 2.1]]),
    c2: curve([[0, 0], [0.6, 0.005], [1, -0.01]]),
    bump: (th, t) => {
      const w = wrapAngle(th);
      const aw = Math.abs(w);
      let b = 0;
      b += 0.016 * gauss(t, 0.655, 0.085) * gauss(Math.max(aw, 0.45), 0.55, 0.36); // pectorals (+ reactor plateau)
      b -= 0.006 * gauss(w, 0, 0.11) * band(t, 0.28, 0.55, 0.05); // sternum groove
      b += 0.008 * gauss(aw, 1.45, 0.3) * gauss(t, 0.62, 0.14); // lats
      b += 0.007 * gauss(aw, 2.45, 0.38) * gauss(t, 0.74, 0.1); // shoulder blades
      b -= 0.006 * gauss(aw, Math.PI, 0.14) * band(t, 0.1, 0.9, 0.1); // spine
      b += 0.0045 * gauss(aw, 0.28, 0.16) * band(t, 0.15, 0.5, 0.05); // abs
      return b * Math.sqrt(tw);
    },
  });

  // ── pelvis: belt line → crotch ──
  const pelvis = new Surface({
    axis: "down",
    length: 0.235,
    a: dome(k(curve([[0, 0.14], [0.3, 0.158], [0.55, 0.16], [0.8, 0.125], [0.95, 0.07], [1, 0.05]]), hip * slim), 0.12),
    bF: dome(k(curve([[0, 0.1], [0.3, 0.104], [0.55, 0.1], [0.8, 0.082], [1, 0.05]]), td), 0.12),
    bB: dome(k(curve([[0, 0.102], [0.3, 0.115], [0.55, 0.122], [0.8, 0.095], [1, 0.05]]), td), 0.12),
    n: constant(2.3),
    bump: (th, t) => 0.006 * gauss(Math.abs(wrapAngle(th)), 2.6, 0.4) * gauss(t, 0.5, 0.18),
  });

  const neck = new Surface({ axis: "up", length: 0.13, a: constant(0.05 * Math.sqrt(p.tw)), bF: constant(0.047), bB: constant(0.052), n: constant(2.1) });

  // ── head / helmet: analytic cranium dome over an angular jaw ──
  const hs = p.head;
  const jawA = curve([[0, 0.06], [0.05, 0.064], [0.1, 0.068], [0.2, 0.079], [0.33, 0.091], [0.45, 0.0995], [0.56, 0.1]]);
  /** Superelliptic dome: flatter crown, fuller temples than a sphere. */
  const sdome = (x: number, p = 2.4) => Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.max(0, x)), p)), 1 / p);
  const headA: Fn = (t) => hs * (t <= 0.56 ? jawA(t) : 0.1 * sdome((t - 0.56) / 0.44, 2.9));
  const jawF = curve([[0, 0.058], [0.05, 0.076], [0.1, 0.1], [0.18, 0.11], [0.3, 0.1145], [0.45, 0.114]]);
  const headF: Fn = (t) => hs * (t <= 0.45 ? jawF(t) : 0.114 * sdome((t - 0.45) / 0.55, 2.6));
  const jawB = curve([[0, 0.062], [0.05, 0.068], [0.12, 0.08], [0.22, 0.093], [0.33, 0.104], [0.45, 0.112], [0.6, 0.118]]);
  const headB: Fn = (t) => hs * (t <= 0.6 ? jawB(t) : 0.118 * sdome((t - 0.6) / 0.4, 2.3));
  const head = new Surface({
    axis: "up",
    length: 0.3 * hs,
    a: headA,
    bF: headF,
    bB: headB,
    n: curve([[0, 2.3], [0.1, 3.3], [0.3, 3.3], [0.55, 3.0], [0.75, 2.5], [1, 2.0]]),
    nB: curve([[0, 2.2], [0.3, 2.3], [1, 2.0]]),
    c2: k(curve([[0, 0], [0.12, 0.012], [0.5, 0.008], [1, -0.004]]), hs),
    bump: (th, t) => {
      const w = wrapAngle(th);
      const aw = Math.abs(w);
      let b = 0;
      b += 0.006 * gauss(t, 0.622, 0.02) * gauss(aw, 0.34, 0.34); // brow ridge (sharp)
      b -= 0.0022 * gauss(t, 0.565, 0.025) * gauss(aw, 0.38, 0.2); // eye line
      b += 0.0018 * gauss(w, 0, 0.06) * band(t, 0.3, 0.8, 0.04); // centre crease
      b += 0.0018 * gauss(t, 0.45, 0.05) * gauss(aw, 0.62, 0.16); // cheek plane
      b += 0.004 * gauss(t, 0.15, 0.045) * gauss(w, 0, 0.24); // chin
      const x = Math.abs(Math.sin(th)) * headA(t);
      b += 0.0035 * gauss(x, 0, 0.016 * hs) * smooth(0.72, 0.8, t); // crest
      b -= 0.002 * gauss(aw, Math.PI / 2 + 0.12, 0.25) * gauss(t, 0.5, 0.08); // ear recess
      return b * hs;
    },
  });

  // ── arms ──
  const A = p.arm * (opts.slim ? 0.86 : 1);
  const upperArm = new Surface({
    axis: "down",
    length: 0.3,
    a: capsule(k(curve([[0, 0.05], [0.1, 0.058], [0.35, 0.057], [0.75, 0.049], [1, 0.044]]), A), 0.12),
    bF: capsule(k(curve([[0, 0.05], [0.1, 0.058], [0.38, 0.066], [0.75, 0.05], [1, 0.044]]), A), 0.12),
    bB: capsule(k(curve([[0, 0.05], [0.1, 0.06], [0.35, 0.063], [0.75, 0.052], [1, 0.046]]), A), 0.12),
    n: constant(2.15),
  });
  const FA = A * (opts.slim ? 1 : 1.08);
  const forearm = new Surface({
    axis: "down",
    length: 0.265,
    a: capsule(k(curve([[0, 0.05], [0.08, 0.054], [0.3, 0.052], [0.7, 0.04], [0.92, 0.032], [1, 0.03]]), FA), 0.1),
    bF: capsule(k(curve([[0, 0.05], [0.08, 0.052], [0.3, 0.054], [0.7, 0.045], [0.92, 0.038], [1, 0.036]]), FA), 0.1),
    bB: capsule(k(curve([[0, 0.054], [0.08, 0.056], [0.3, 0.056], [0.7, 0.044], [0.92, 0.037], [1, 0.035]]), FA), 0.1),
    n: constant(2.3),
  });
  const H = p.hand * (opts.slim ? 0.94 : 1);
  const palm = new Surface({
    axis: "down",
    length: 0.098 * H,
    a: dome(dome(k(curve([[0, 0.017], [0.25, 0.02], [0.75, 0.019], [0.93, 0.016], [1, 0.014]]), H), 0.12, true), 0.1),
    bF: dome(dome(k(curve([[0, 0.031], [0.3, 0.041], [0.8, 0.046], [0.95, 0.044], [1, 0.04]]), H), 0.12, true), 0.1),
    n: constant(3.0),
  });
  const seg = (len: number, r: number) =>
    new Surface({ axis: "down", length: len * H, a: capsule(constant(r * 0.9 * H), 0.26), bF: capsule(constant(r * H), 0.26), n: constant(2.5) });
  const fingers: FingerSpec[] = [
    { z: 0.029 * H, splay: -0.06, curl: [-0.18, -0.36, -0.26], segs: [seg(0.044, 0.0098), seg(0.027, 0.0094), seg(0.023, 0.0088)] },
    { z: 0.0095 * H, splay: -0.01, curl: [-0.22, -0.42, -0.3], segs: [seg(0.048, 0.0099), seg(0.03, 0.0095), seg(0.024, 0.0089)] },
    { z: -0.0095 * H, splay: 0.05, curl: [-0.28, -0.46, -0.32], segs: [seg(0.045, 0.0093), seg(0.028, 0.009), seg(0.023, 0.0085)] },
    { z: -0.027 * H, splay: 0.12, curl: [-0.36, -0.52, -0.34], segs: [seg(0.036, 0.0085), seg(0.021, 0.0082), seg(0.019, 0.0078)] },
  ];
  const thumb = [seg(0.044, 0.0128), seg(0.032, 0.0112), seg(0.026, 0.0098)];

  const pauldron = new Surface({
    axis: "down",
    length: 0.14 * A,
    a: k(curve([[0, 0.0], [0.04, 0.03], [0.16, 0.054], [0.4, 0.069], [0.7, 0.074], [1, 0.072]]), A),
    bF: k(curve([[0, 0.0], [0.04, 0.03], [0.16, 0.056], [0.4, 0.071], [0.7, 0.075], [1, 0.073]]), A),
    n: constant(2.5),
  });

  // ── legs ──
  const Lg = p.leg * (opts.slim ? 0.9 : 1);
  const thigh = new Surface({
    axis: "down",
    length: 0.43,
    a: dome(k(curve([[0, 0.086], [0.12, 0.09], [0.45, 0.08], [0.8, 0.066], [0.95, 0.058], [1, 0.054]]), Lg), 0.1),
    bF: dome(k(curve([[0, 0.084], [0.15, 0.094], [0.45, 0.088], [0.8, 0.068], [1, 0.057]]), Lg), 0.1),
    bB: dome(k(curve([[0, 0.09], [0.15, 0.092], [0.45, 0.082], [0.8, 0.062], [1, 0.052]]), Lg), 0.1),
    n: constant(2.15),
    bump: (th, t) => 0.004 * Lg * gauss(wrapAngle(th), 0.5, 0.4) * gauss(t, 0.4, 0.2),
  });
  const knee = new Surface({
    axis: "down",
    length: 0.12 * Lg,
    a: dome(dome(constant(0.052 * Lg), 0.2, true), 0.2),
    bF: dome(dome(constant(0.05 * Lg), 0.2, true), 0.2),
    bB: dome(dome(constant(0.02 * Lg), 0.2, true), 0.2),
    n: constant(2.6),
  });
  const shin = new Surface({
    axis: "down",
    length: 0.425,
    a: dome(k(curve([[0, 0.052], [0.2, 0.056], [0.45, 0.052], [0.75, 0.043], [0.92, 0.037], [1, 0.036]]), Lg), 0.1, true),
    bF: dome(k(curve([[0, 0.054], [0.3, 0.05], [0.7, 0.042], [1, 0.036]]), Lg), 0.1, true),
    bB: dome(k(curve([[0, 0.054], [0.25, 0.072], [0.45, 0.066], [0.75, 0.048], [1, 0.038]]), Lg), 0.1, true),
    n: constant(2.2),
    bump: (th, t) => 0.0045 * Lg * gauss(wrapAngle(th), 0, 0.13) * band(t, 0.08, 0.86, 0.06),
  });
  const ankleY = 0.0955;
  const F = Math.sqrt(p.leg) * (opts.slim ? 0.95 : 1);
  const foot = new Surface({
    axis: "forward",
    length: 0.27 * F,
    a: dome(dome(k(curve([[0, 0.04], [0.15, 0.044], [0.35, 0.047], [0.55, 0.049], [0.75, 0.05], [0.9, 0.046], [1, 0.034]]), F), 0.1, true), 0.07),
    bF: dome(dome(k(curve([[0, 0.06], [0.15, 0.085], [0.35, 0.07], [0.55, 0.045], [0.75, 0.032], [0.9, 0.026], [1, 0.02]]), F), 0.1, true), 0.07),
    bB: dome(dome(k(curve([[0, 0.05], [0.15, 0.075], [0.35, 0.065], [0.55, 0.05], [0.75, 0.04], [0.9, 0.032], [1, 0.022]]), F), 0.1, true), 0.07),
    n: curve([[0, 2.4], [0.5, 2.8], [1, 2.4]]),
    c2: k(curve([[0, -0.035], [0.15, -0.02], [0.35, -0.025], [0.55, -0.045], [0.75, -0.058], [0.9, -0.066], [1, -0.072]]), F),
    floor: -ankleY + 0.002,
  });

  return {
    p,
    torso,
    pelvis,
    neck,
    head,
    upperArm,
    forearm,
    palm,
    fingers,
    thumb,
    pauldron,
    thigh,
    knee,
    shin,
    foot,
    headA,
    j: {
      torsoY: 1.0,
      pelvisY: 1.065,
      hipX: 0.098 * hip * slim,
      hipY: 0.95,
      thighLen: 0.43,
      shinLen: 0.425,
      ankleY,
      shoulderX: 0.207 * tw + (p.arm - 1) * 0.03,
      shoulderY: 1.465,
      neckY: 1.49,
      headY: 1.575,
      upperLen: 0.3,
      foreLen: 0.265,
      palmLen: 0.098 * H,
      footBack: 0.068 * F,
      reactorT: 0.675,
    },
  };
}
