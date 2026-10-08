import * as THREE from "three";

/**
 * Suit kit: analytic body surfaces + precisely cut armour plates.
 *
 * A Surface is a smooth tube defined by cross-sections along an axis (polar superellipse with
 * separate front/back depths, offsets and local bumps) — forearms, calves, a helmet.
 * A plate is an outline drawn in the surface's (θ, t) parameter space: it is inset by a gap
 * (the panel line), triangulated with its holes (eye slits!), subdivided until it follows the
 * curvature, lifted off the surface by a thickness and finished with a bevelled edge and side
 * walls — so plates have real thickness, crisp highlights and dark gaps between them.
 */

export type Fn = (t: number) => number;
export type P2 = [number, number];

export const TAU = Math.PI * 2;
export const smooth = (e0: number, e1: number, x: number) => {
  const k = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return k * k * (3 - 2 * k);
};
export const gauss = (x: number, m: number, s: number) => {
  const d = (x - m) / s;
  return d > 4 || d < -4 ? 0 : Math.exp(-0.5 * d * d);
};
/** Wrap an angle to (−π, π]. */
export const wrapAngle = (a: number) => a - TAU * Math.round(a / TAU);
/** 1 inside [a, b], 0 outside, soft edges of width `soft`. */
export const band = (x: number, a: number, b: number, soft: number) => smooth(a - soft, a + soft, x) * (1 - smooth(b - soft, b + soft, x));

/** Monotone cubic interpolation through (t, value) control points (no overshoot). */
export function curve(points: P2[]): Fn {
  const ts = points.map((p) => p[0]);
  const vs = points.map((p) => p[1]);
  const n = ts.length;
  if (n === 1) return () => vs[0];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((vs[i + 1] - vs[i]) / (ts[i + 1] - ts[i]));
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      m[i] = k * a * d[i];
      m[i + 1] = k * b * d[i];
    }
  }
  return (t: number) => {
    if (t <= ts[0]) return vs[0];
    if (t >= ts[n - 1]) return vs[n - 1];
    let i = 0;
    while (t > ts[i + 1]) i++;
    const h = ts[i + 1] - ts[i];
    const u = (t - ts[i]) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * vs[i] + (u3 - 2 * u2 + u) * h * m[i] + (-2 * u3 + 3 * u2) * vs[i + 1] + (u3 - u2) * h * m[i + 1];
  };
}

export const constant = (v: number): Fn => () => v;

/** Rounded end: multiplies a radius so it closes like a dome over the last `len` of t. */
export const dome = (f: Fn, len: number, atStart = false): Fn => (t) => {
  const x = atStart ? (len - t) / len : (t - (1 - len)) / len;
  return x <= 0 ? f(t) : f(t) * Math.sqrt(Math.max(0, 1 - x * x));
};

export interface SurfaceSpec {
  /** down: from the joint along −y (limbs) · up: along +y (torso, head) · forward: along +z (feet) */
  axis: "down" | "up" | "forward";
  length: number;
  /** Half-width (lateral, x). */
  a: Fn;
  /** Half-depth on the θ = 0 side (front; for "forward" surfaces: top). */
  bF: Fn;
  /** Half-depth on the opposite side (defaults to bF). */
  bB?: Fn;
  /** Superellipse exponent (2 = ellipse, higher = squarer); `nB` for the back half if given. */
  n?: Fn;
  nB?: Fn;
  /** Axis offsets: x and z (for "forward": x and y). */
  c1?: Fn;
  c2?: Fn;
  /** Radial displacement in metres (muscles, brow ridges…). */
  bump?: (theta: number, t: number) => number;
  /** "forward" surfaces: clamp the vertical coordinate (flat soles). */
  floor?: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _dir = new THREE.Vector3();

/** Cross-section parameters are cached per t (quantised to ~4 µm on a 0.5 m surface). */
const TQ = 131072;

export class Surface {
  private cache = new Map<number, Float64Array>();
  constructor(readonly s: SurfaceSpec) {}

  /** [a, bF, bB, nFront, nBack, c1, c2] at t. */
  private params(t: number): Float64Array {
    const key = Math.round(t * TQ);
    let p = this.cache.get(key);
    if (!p) {
      const s = this.s;
      const tt = key / TQ;
      const nF = s.n ? s.n(tt) : 2;
      p = new Float64Array([s.a(tt), s.bF(tt), (s.bB ?? s.bF)(tt), nF, s.nB ? s.nB(tt) : nF, s.c1 ? s.c1(tt) : 0, s.c2 ? s.c2(tt) : 0]);
      this.cache.set(key, p);
    }
    return p;
  }

  get length(): number {
    return this.s.length;
  }

  /** Mean radius at t (metric scale for θ). */
  radius(t: number): number {
    const s = this.s;
    return Math.max(0.004, (s.a(t) + (s.bF(t) + (s.bB ?? s.bF)(t)) / 2) / 2);
  }

  /** Cross-section radius in direction θ at t (before bumps). */
  r(theta: number, t: number): number {
    return this.rp(Math.sin(theta), Math.cos(theta), this.params(t));
  }

  private rp(sin: number, cos: number, p: Float64Array): number {
    const front = cos >= 0;
    const n = front ? p[3] : p[4];
    const A = p[0] > 1e-6 ? p[0] : 1e-6;
    const Bv = front ? p[1] : p[2];
    const B = Bv > 1e-6 ? Bv : 1e-6;
    const x = Math.abs(sin) / A;
    const y = Math.abs(cos) / B;
    if (n === 2) return 1 / Math.sqrt(x * x + y * y || 1e-30);
    return Math.pow(Math.pow(x, n) + Math.pow(y, n) || 1e-30, -1 / n);
  }

  axisPoint(t: number, out = new THREE.Vector3()): THREE.Vector3 {
    const s = this.s;
    const p = this.params(t);
    if (s.axis === "down") return out.set(p[5], -t * s.length, p[6]);
    if (s.axis === "up") return out.set(p[5], t * s.length, p[6]);
    return out.set(p[5], p[6], t * s.length);
  }

  point(theta: number, t: number, out = new THREE.Vector3()): THREE.Vector3 {
    const s = this.s;
    const p = this.params(t);
    const sn = Math.sin(theta);
    const cs = Math.cos(theta);
    let r = this.rp(sn, cs, p);
    if (s.bump) r = Math.max(0, r + s.bump(theta, t));
    const u = r * sn;
    const v = r * cs;
    const o1 = p[5];
    const o2 = p[6];
    if (s.axis === "down") return out.set(o1 + u, -t * s.length, o2 + v);
    if (s.axis === "up") return out.set(o1 + u, t * s.length, o2 + v);
    let y = o2 + v;
    if (s.floor !== undefined) y = Math.max(y, s.floor);
    return out.set(o1 + u, y, t * s.length);
  }

  private axisDir(end: boolean, out: THREE.Vector3): THREE.Vector3 {
    const ax = this.s.axis;
    if (ax === "up") return out.set(0, end ? 1 : -1, 0);
    if (ax === "down") return out.set(0, end ? -1 : 1, 0);
    return out.set(0, 0, end ? 1 : -1);
  }

  normal(theta: number, t: number, out = new THREE.Vector3(), base?: THREE.Vector3): THREE.Vector3 {
    const h = 6e-4;
    if (base) _p.copy(base);
    else this.point(theta, t, _p);
    this.point(theta + h, t, _a);
    _a.sub(_p);
    // step in t away from the ends so the difference stays inside [0, 1]
    const dt = t + h <= 1 ? h : -h;
    this.point(theta, t + dt, _c);
    _c.sub(_p);
    if (dt < 0) _c.negate();
    out.crossVectors(_a, _c);
    const len = out.length();
    if (len < 1e-12) {
      // degenerate (pole): fall back to central differences, then the axis
      this.point(theta + h, t, _a);
      this.point(theta - h, t, _b);
      _a.sub(_b);
      this.point(theta, Math.min(1, t + h), _c);
      this.point(theta, Math.max(0, t - h), _d);
      _c.sub(_d);
      out.crossVectors(_a, _c);
      const l2 = out.length();
      if (l2 < 1e-12) return this.axisDir(t > 0.5, out);
      out.divideScalar(l2);
    } else out.divideScalar(len);
    this.axisPoint(t, _q);
    _q.subVectors(_p, _q);
    if (_q.lengthSq() > 1e-10) {
      if (out.dot(_q) < 0) out.negate();
    } else if (out.dot(this.axisDir(t > 0.5, _dir)) < 0) out.negate();
    return out;
  }
}

// ─── outlines ───

/** Mirror an outline left↔right (θ → −θ), keeping it a valid polygon. */
export const mirror = (pts: P2[]): P2[] => pts.map(([th, t]) => [-th, t] as P2).reverse();

/** Mirror a half outline (θ ≥ 0, listed from the centre line at the top round to the centre line at the bottom) into a full symmetric one. */
export const symmetric = (half: P2[]): P2[] => {
  const right = half.slice();
  const left = half
    .filter(([th]) => Math.abs(th) > 1e-6)
    .map(([th, t]) => [-th, t] as P2)
    .reverse();
  return [...right, ...left];
};

/** Rectangle in (θ, t) with optionally chamfered corners (chamfer in param units). */
export function rect(th0: number, th1: number, t0: number, t1: number, cth = 0, ct = 0): P2[] {
  if (!cth && !ct)
    return [
      [th0, t0],
      [th1, t0],
      [th1, t1],
      [th0, t1],
    ];
  return [
    [th0 + cth, t0],
    [th1 - cth, t0],
    [th1, t0 + ct],
    [th1, t1 - ct],
    [th1 - cth, t1],
    [th0 + cth, t1],
    [th0, t1 - ct],
    [th0, t0 + ct],
  ];
}

/** Ellipse in (θ, t). */
export function ellipse(thc: number, tc: number, rth: number, rt: number, n = 32): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out.push([thc + Math.sin(a) * rth, tc + Math.cos(a) * rt]);
  }
  return out;
}

/** Arc of an ellipse from angle a0 to a1 (radians, 0 = +t, π/2 = +θ). */
export function arc(thc: number, tc: number, rth: number, rt: number, a0: number, a1: number, n = 12): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([thc + Math.sin(a) * rth, tc + Math.cos(a) * rt]);
  }
  return out;
}

/** Smooth closed spline through control points (Catmull-Rom), for organic plate outlines. */
export function spline(pts: P2[], perSeg = 6): P2[] {
  const out: P2[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let k = 0; k < perSeg; k++) {
      const u = k / perSeg;
      const u2 = u * u;
      const u3 = u2 * u;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * u + (2 * a - 5 * b + 4 * c - d) * u2 + (-a + 3 * b - 3 * c + d) * u3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

/**
 * Polygon with rounded corners: each corner is replaced by a quadratic curve that starts
 * `r` (fraction of the shorter adjacent edge, 0..0.5) before it. Per-corner radii allowed.
 */
export function rounded(pts: P2[], r: number | number[] = 0.25, steps = 4): P2[] {
  const n = pts.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const a = pts[(i - 1 + n) % n];
    const b = pts[(i + 1) % n];
    const k = Array.isArray(r) ? (r[i] ?? 0) : r;
    if (k <= 0) {
      out.push(p);
      continue;
    }
    const s: P2 = [p[0] + (a[0] - p[0]) * k, p[1] + (a[1] - p[1]) * k];
    const e: P2 = [p[0] + (b[0] - p[0]) * k, p[1] + (b[1] - p[1]) * k];
    for (let j = 0; j <= steps; j++) {
      const u = j / steps;
      const w0 = (1 - u) * (1 - u);
      const w1 = 2 * u * (1 - u);
      const w2 = u * u;
      out.push([w0 * s[0] + w1 * p[0] + w2 * e[0], w0 * s[1] + w1 * p[1] + w2 * e[1]]);
    }
  }
  return out;
}

/** Round the interior corners of an open chain (end points stay sharp) — for outlines joined to arcs. */
export function roundChain(pts: P2[], r = 0.28, steps = 4): P2[] {
  if (pts.length < 3) return pts.slice();
  const out: P2[] = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const a = pts[i - 1];
    const b = pts[i + 1];
    const s: P2 = [p[0] + (a[0] - p[0]) * r, p[1] + (a[1] - p[1]) * r];
    const e: P2 = [p[0] + (b[0] - p[0]) * r, p[1] + (b[1] - p[1]) * r];
    for (let j = 0; j <= steps; j++) {
      const u = j / steps;
      const w0 = (1 - u) * (1 - u);
      const w1 = 2 * u * (1 - u);
      const w2 = u * u;
      out.push([w0 * s[0] + w1 * p[0] + w2 * e[0], w0 * s[1] + w1 * p[1] + w2 * e[1]]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Scale an outline about its centroid (eye glass slightly larger than the eye hole…). */
export function grow(pts: P2[], kth: number, kt = kth): P2[] {
  const c = pts.reduce((acc, p) => [acc[0] + p[0] / pts.length, acc[1] + p[1] / pts.length] as P2, [0, 0] as P2);
  return pts.map(([th, t]) => [c[0] + (th - c[0]) * kth, c[1] + (t - c[1]) * kt] as P2);
}

// ─── plates ───

export interface PlateOpts {
  holes?: P2[][];
  /** Plate thickness above its base (m). */
  thickness?: number;
  /** Offset of the plate's underside from the surface (m). */
  base?: number;
  /** Inset of the outline: half the panel-line width (m). */
  gap?: number;
  /** Bevel width (m). */
  bevel?: number;
  /** Max triangle edge (m) — the plate is subdivided until it follows the curvature. */
  maxEdge?: number;
  /** Close the plate underneath (for pieces that move away from the body). */
  bottom?: boolean;
  /** UV scale (texture repeats per metre). */
  uvScale?: number;
}

/** Global detail (1 = full; carousel previews build at lower detail). */
export const kitDetail = { value: 1 };

interface Loop {
  outer: P2[];
  inner: P2[];
}

function signedArea(pts: P2[], R: number, L: number): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * R * (q[1] * L) - q[0] * R * (p[1] * L);
  }
  return a / 2;
}

/** Drop repeated points (incl. a closing duplicate of the first point). */
function dedupe(pts: P2[]): P2[] {
  const out: P2[] = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > 1e-7 || Math.abs(q[1] - p[1]) > 1e-7) out.push(p);
  }
  while (out.length > 2) {
    const f = out[0];
    const l = out[out.length - 1];
    if (Math.abs(f[0] - l[0]) > 1e-7 || Math.abs(f[1] - l[1]) > 1e-7) break;
    out.pop();
  }
  return out;
}

function resample(poly: P2[], surf: Surface, maxLen: number): P2[] {
  const out: P2[] = [];
  const L = surf.length;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const r = surf.radius((a[1] + b[1]) / 2);
    const len = Math.hypot((b[0] - a[0]) * r, (b[1] - a[1]) * L);
    const n = Math.max(1, Math.ceil(len / maxLen));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    }
  }
  return out;
}

/** Inset a CCW polygon by d metres (local metric: θ scaled by the surface radius). */
function offsetPoly(poly: P2[], d: number, surf: Surface): P2[] {
  const n = poly.length;
  const L = surf.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const a = poly[(i - 1 + n) % n];
    const b = poly[(i + 1) % n];
    const r = surf.radius(p[1]);
    const e1x = (p[0] - a[0]) * r;
    const e1y = (p[1] - a[1]) * L;
    const e2x = (b[0] - p[0]) * r;
    const e2y = (b[1] - p[1]) * L;
    const l1 = Math.hypot(e1x, e1y) || 1;
    const l2 = Math.hypot(e2x, e2y) || 1;
    const n1x = -e1y / l1;
    const n1y = e1x / l1;
    const n2x = -e2y / l2;
    const n2y = e2x / l2;
    let mx = n1x + n2x;
    let my = n1y + n2y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-6) {
      mx = n1x;
      my = n1y;
    } else {
      mx /= ml;
      my /= ml;
    }
    const cosHalf = Math.max(0.4, mx * n1x + my * n1y);
    const k = d / cosHalf;
    out.push([p[0] + (mx * k) / r, p[1] + (my * k) / L]);
  }
  return out;
}

const _tn = new THREE.Vector3();

class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  idx: number[] = [];
  vertex(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number): number {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    return this.pos.length / 3 - 1;
  }
  /** Triangle, flipped if needed so its winding matches `want`. */
  tri(a: number, b: number, c: number, want: THREE.Vector3): void {
    const P = this.pos;
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
    const vx = P[c * 3] - ax, vy = P[c * 3 + 1] - ay, vz = P[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * want.x + ny * want.y + nz * want.z < 0) this.idx.push(a, c, b);
    else this.idx.push(a, b, c);
  }
  /** Triangle oriented by the sum of its vertex normals. */
  triByNormals(a: number, b: number, c: number): void {
    const N = this.nor;
    _tn.set(N[a * 3] + N[b * 3] + N[c * 3], N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1], N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2]);
    this.tri(a, b, c, _tn);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

const _n2 = new THREE.Vector3();
const _w = new THREE.Vector3();

interface Row {
  p: THREE.Vector3;
  n: THREE.Vector3;
  uv: P2;
}

/** Bevel (outer@hBev → inner@hTop) and wall (outer@hBev → outer@hBot) strips around a loop. */
function edgeStrips(gb: GeoBuilder, surf: Surface, outer: P2[], inner: P2[], hTop: number, hBev: number, hBot: number, R0: number, L: number, uvs: number, closed = true): void {
  const n = outer.length;
  const segs = closed ? n : n - 1;
  const rows = (pts: P2[], h: number): Row[] =>
    pts.map((p) => {
      const v = surf.point(p[0], p[1], new THREE.Vector3());
      const nn = surf.normal(p[0], p[1], new THREE.Vector3());
      return { p: v.addScaledVector(nn, h), n: nn, uv: p };
    });
  const A = rows(outer, hBev);
  const B = rows(inner, hTop);
  const D = A.map((r) => ({ p: r.p.clone().addScaledVector(r.n, hBot - hBev), n: r.n, uv: r.uv }));
  const out = A.map((r, i) => new THREE.Vector3().subVectors(r.p, B[i].p).normalize());
  const strip = (top: Row[], bottom: Row[], outward: (i: number) => THREE.Vector3) => {
    const fn: THREE.Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const j = closed ? (i + 1) % n : Math.min(i + 1, n - 1);
      const jj = j === i ? i - 1 : j;
      const e1 = j === i ? new THREE.Vector3().subVectors(top[i].p, top[jj].p) : new THREE.Vector3().subVectors(top[j].p, top[i].p);
      const e2 = new THREE.Vector3().subVectors(bottom[i].p, top[i].p);
      const f = new THREE.Vector3().crossVectors(e1, e2);
      if (f.lengthSq() < 1e-16) f.copy(outward(i));
      f.normalize();
      if (f.dot(outward(i)) < 0) f.negate();
      fn.push(f);
    }
    const cols: number[][] = [];
    for (let i = 0; i < n; i++) {
      const prev = closed ? fn[(i - 1 + n) % n] : fn[Math.max(0, i - 1)];
      const nn = _n2.copy(fn[i]).add(prev).normalize();
      const it = gb.vertex(top[i].p, nn, top[i].uv[0] * R0 * uvs, top[i].uv[1] * L * uvs);
      const ib = gb.vertex(bottom[i].p, nn, bottom[i].uv[0] * R0 * uvs, bottom[i].uv[1] * L * uvs + 0.002);
      cols.push([it, ib]);
    }
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const w = outward(i);
      gb.tri(cols[i][0], cols[j][0], cols[j][1], w);
      gb.tri(cols[i][0], cols[j][1], cols[i][1], w);
    }
  };
  // chamfer: faces up-and-out
  strip(A, B, (i) => _w.copy(out[i]).add(A[i].n).normalize().clone());
  // wall: faces out
  strip(A, D, (i) => out[i]);
}

// ─── grid-clipped tessellation ───

interface TPoint {
  x: number;
  y: number;
  key: string;
}
/** Edge tag: 0 = original edge (a < b), 1 = vertical grid line a, 2 = horizontal grid line a. */
interface TTag {
  kind: 0 | 1 | 2;
  a: number;
  b: number;
}

/**
 * Split a coarse triangulation along a square grid (metric param space): every triangle is
 * clipped into convex cells and fanned. Points on shared edges get identical keys, so the mesh
 * is conforming (no T-junction cracks) and triangle size is bounded by the cell size.
 */
function gridTessellate(P: [number, number][], faces: number[][], cell: number): { verts: [number, number][]; tris: number[] } {
  const keyIndex = new Map<string, number>();
  const verts: [number, number][] = [];
  const tris: number[] = [];
  const idx = (p: TPoint) => {
    let i = keyIndex.get(p.key);
    if (i === undefined) {
      i = verts.length;
      verts.push([p.x, p.y]);
      keyIndex.set(p.key, i);
    }
    return i;
  };
  const EPS = 1e-9;
  const cross = (A: TPoint, B: TPoint, tag: TTag, axis: 0 | 1, c: number, line: number): TPoint => {
    const ca = axis === 0 ? A.x : A.y;
    const cb = axis === 0 ? B.x : B.y;
    if (Math.abs(ca - c) < EPS) return A;
    if (Math.abs(cb - c) < EPS) return B;
    if (tag.kind === 0) {
      // canonical: from the lower original index, so both neighbours compute the same point
      const p0 = P[tag.a];
      const p1 = P[tag.b];
      const d = axis === 0 ? p1[0] - p0[0] : p1[1] - p0[1];
      const u = d === 0 ? 0 : (c - (axis === 0 ? p0[0] : p0[1])) / d;
      return { x: p0[0] + (p1[0] - p0[0]) * u, y: p0[1] + (p1[1] - p0[1]) * u, key: `e${tag.a}_${tag.b}_${axis}_${line}` };
    }
    // a grid-line edge meets the perpendicular grid line: a grid point
    const i = axis === 0 ? line : tag.a;
    const j = axis === 0 ? tag.a : line;
    return { x: i * cell, y: j * cell, key: `g${i}_${j}` };
  };
  const clip = (pts: TPoint[], tags: TTag[], axis: 0 | 1, c: number, line: number, keepLow: boolean) => {
    const out: TPoint[] = [];
    const outTags: TTag[] = [];
    const inside = (p: TPoint) => {
      const v = axis === 0 ? p.x : p.y;
      return keepLow ? v <= c + EPS : v >= c - EPS;
    };
    const clipTag: TTag = { kind: axis === 0 ? 1 : 2, a: line, b: 0 };
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const A = pts[i];
      const B = pts[(i + 1) % n];
      const tag = tags[i];
      const inA = inside(A);
      const inB = inside(B);
      if (inA) {
        out.push(A);
        outTags.push(tag);
      }
      if (inA !== inB) {
        const I = cross(A, B, tag, axis, c, line);
        if (I !== A && I !== B) {
          out.push(I);
          outTags.push(inA ? clipTag : tag);
        } else if (I === A && inA) {
          // A lies on the line and the polygon leaves here: the next output edge runs along the line
          outTags[outTags.length - 1] = clipTag;
        }
      }
    }
    return { pts: out, tags: outTags };
  };
  const emit = (pts: TPoint[]) => {
    const q: TPoint[] = [];
    for (const p of pts) if (!q.length || q[q.length - 1].key !== p.key) q.push(p);
    while (q.length > 1 && q[0].key === q[q.length - 1].key) q.pop();
    if (q.length < 3) return;
    const i0 = idx(q[0]);
    for (let k = 1; k < q.length - 1; k++) {
      const a = q[0];
      const b = q[k];
      const c = q[k + 1];
      const area = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
      if (Math.abs(area) < 1e-14) continue;
      tris.push(i0, idx(b), idx(c));
    }
  };
  for (const f of faces) {
    let pts: TPoint[] = f.map((i) => ({ x: P[i][0], y: P[i][1], key: `p${i}` }));
    let tags: TTag[] = f.map((i, k) => {
      const j = f[(k + 1) % f.length];
      return { kind: 0 as const, a: Math.min(i, j), b: Math.max(i, j) };
    });
    const xs = pts.map((p) => p.x);
    const x0 = Math.floor(Math.min(...xs) / cell) + 1;
    const x1 = Math.ceil(Math.max(...xs) / cell) - 1;
    const slabs: { pts: TPoint[]; tags: TTag[] }[] = [];
    for (let i = x0; i <= x1; i++) {
      const lo = clip(pts, tags, 0, i * cell, i, true);
      const hi = clip(pts, tags, 0, i * cell, i, false);
      if (lo.pts.length >= 3) slabs.push(lo);
      pts = hi.pts;
      tags = hi.tags;
      if (pts.length < 3) break;
    }
    if (pts.length >= 3) slabs.push({ pts, tags });
    for (const sl of slabs) {
      let sp = sl.pts;
      let st = sl.tags;
      const ys = sp.map((p) => p.y);
      const y0 = Math.floor(Math.min(...ys) / cell) + 1;
      const y1 = Math.ceil(Math.max(...ys) / cell) - 1;
      for (let j = y0; j <= y1; j++) {
        const lo = clip(sp, st, 1, j * cell, j, true);
        const hi = clip(sp, st, 1, j * cell, j, false);
        emit(lo.pts);
        sp = hi.pts;
        st = hi.tags;
        if (sp.length < 3) break;
      }
      emit(sp);
    }
  }
  return { verts, tris };
}

/** Lift a grid-tessellated (θ, t) region onto the surface at height h. */
function surfaceFace(
  gb: GeoBuilder,
  surf: Surface,
  flat: P2[],
  faces: number[][],
  height: number,
  flip: boolean,
  cell: number,
  R0: number,
  L: number,
  uvs: number,
): { center: THREE.Vector3; normal: THREE.Vector3; count: number } {
  const P = flat.map(([th, t]) => [th * R0, t * L] as [number, number]);
  const { verts, tris } = gridTessellate(P, faces, cell);
  const base = gb.pos.length / 3;
  const center = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const [x, y] of verts) {
    const th = x / R0;
    const t = y / L;
    surf.point(th, t, p);
    surf.normal(th, t, n, p);
    p.addScaledVector(n, height);
    center.add(p);
    normal.add(n);
    if (flip) n.negate();
    gb.vertex(p, n, x * uvs, y * uvs);
  }
  for (let i = 0; i < tris.length; i += 3) gb.triByNormals(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
  if (verts.length) center.divideScalar(verts.length);
  return { center, normal, count: verts.length };
}

/**
 * A plate: outline (and holes) in the surface's (θ, t) space → solid armour piece with
 * thickness, bevel and side walls. Returns the geometry plus its centre/normal (used to
 * fly the plate outward when the armour opens).
 */
export function plateGeometry(surf: Surface, outline: P2[], o: PlateOpts = {}): { geometry: THREE.BufferGeometry; center: THREE.Vector3; normal: THREE.Vector3 } {
  const thickness = o.thickness ?? 0.004;
  const base = o.base ?? 0.002;
  const gap = o.gap ?? 0.0016;
  const bevel = Math.min(o.bevel ?? 0.0016, thickness * 0.8);
  const maxEdge = (o.maxEdge ?? 0.012) / Math.max(0.2, kitDetail.value);
  const uvs = o.uvScale ?? 1;
  const L = surf.length;
  const R0 = surf.radius(0.5);
  const hTop = base + thickness;
  const hBev = hTop - bevel * 0.9;
  const hBot = base - 0.0015;

  // Orientation: contour CCW, holes CW (in the metric-ish w space).
  let contour = dedupe(outline);
  if (signedArea(contour, R0, L) < 0) contour.reverse();
  const holes = (o.holes ?? []).map((h) => {
    const hh = dedupe(h);
    if (signedArea(hh, R0, L) > 0) hh.reverse();
    return hh;
  });
  const edgeLen = Math.max(0.0025, maxEdge * 0.8);
  contour = resample(contour, surf, edgeLen);
  const loops: Loop[] = [contour, ...holes.map((h) => resample(h, surf, edgeLen))].map((poly) => {
    const outer = gap > 0 ? offsetPoly(poly, gap, surf) : poly;
    const inner = offsetPoly(outer, bevel, surf);
    return { outer, inner };
  });

  const gb = new GeoBuilder();
  const center = new THREE.Vector3();
  const avgN = new THREE.Vector3();
  let centerCount = 0;
  const cellSize = maxEdge;

  // ── top face (grid-clipped so it follows the surface, crack-free) ──
  const toV2 = (p: P2) => new THREE.Vector2(p[0] * R0, p[1] * L);
  const topContour = loops[0].inner.map(toV2);
  const topHoles = loops.slice(1).map((l) => l.inner.map(toV2));
  const flat: P2[] = [...loops[0].inner, ...loops.slice(1).flatMap((l) => l.inner)];
  const faces = THREE.ShapeUtils.triangulateShape(topContour, topHoles);

  const top = surfaceFace(gb, surf, flat, faces, hTop, false, cellSize, R0, L, uvs);
  center.copy(top.center);
  avgN.copy(top.normal);
  centerCount = top.count;

  // ── bevel + side walls around every loop ──
  for (const loop of loops) edgeStrips(gb, surf, loop.outer, loop.inner, hTop, hBev, hBot, R0, L, uvs);

  // ── optional underside ──
  if (o.bottom) {
    const bottomContour = loops[0].outer.map(toV2);
    const bottomHoles = loops.slice(1).map((l) => l.outer.map(toV2));
    const flatB: P2[] = [...loops[0].outer, ...loops.slice(1).flatMap((l) => l.outer)];
    const fb = THREE.ShapeUtils.triangulateShape(bottomContour, bottomHoles);
    surfaceFace(gb, surf, flatB, fb, hBot, true, cellSize, R0, L, uvs);
  }

  if (centerCount) avgN.normalize();
  return { geometry: gb.build(), center, normal: avgN };
}

/**
 * A cap plate over a pole of the surface (the crown of a helmet, the top of a shoulder):
 * covers t ∈ [tEdge, 1] (or [0, tEdge] with `start`), with the same bevel/wall edge as plates.
 */
export function capGeometry(surf: Surface, tEdge: number, o: Omit<PlateOpts, "holes" | "bottom"> & { start?: boolean; th0?: number; th1?: number } = {}): { geometry: THREE.BufferGeometry; center: THREE.Vector3; normal: THREE.Vector3 } {
  const thickness = o.thickness ?? 0.004;
  const base = o.base ?? 0.002;
  const gap = o.gap ?? 0.0016;
  const bevel = Math.min(o.bevel ?? 0.0016, thickness * 0.8);
  const det = Math.max(0.2, kitDetail.value);
  const maxEdge = (o.maxEdge ?? 0.012) / det;
  const uvs = o.uvScale ?? 1;
  const L = surf.length;
  const R0 = surf.radius(0.5);
  const hTop = base + thickness;
  const hBev = hTop - bevel * 0.9;
  const hBot = base - 0.0015;
  const dir = o.start ? -1 : 1;
  const tE = tEdge + (dir * gap) / L;
  const tB = tE + (dir * bevel) / L;
  const tEnd = o.start ? 0 : 1;
  const th0 = o.th0 ?? -Math.PI;
  const th1 = o.th1 ?? Math.PI;
  const segU = Math.max(16, Math.ceil(((th1 - th0) * surf.radius(tEdge)) / Math.min(maxEdge, 0.008 / det)));
  const segV = Math.max(3, Math.ceil((Math.abs(tEnd - tB) * L) / maxEdge) + 2);
  const gb = new GeoBuilder();
  const p = new THREE.Vector3();
  const nn = new THREE.Vector3();
  const want = new THREE.Vector3();
  const center = new THREE.Vector3();
  const avgN = new THREE.Vector3();
  let count = 0;
  // top surface rows from tB to the pole
  const row = segU + 1;
  for (let j = 0; j <= segV; j++) {
    const t = tB + ((tEnd - tB) * j) / segV;
    for (let i = 0; i <= segU; i++) {
      const th = th0 + ((th1 - th0) * i) / segU;
      surf.point(th, t, p);
      surf.normal(th, t, nn);
      p.addScaledVector(nn, hTop);
      gb.vertex(p, nn, th * R0 * uvs, t * L * uvs);
      center.add(p);
      avgN.add(nn);
      count++;
    }
  }
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * row + i;
      surf.normal(th0 + ((th1 - th0) * (i + 0.5)) / segU, tB + ((tEnd - tB) * (j + 0.5)) / segV, want);
      gb.tri(a, a + 1, a + row + 1, want);
      gb.tri(a, a + row + 1, a + row, want);
    }
  }
  // edge ring (open strip, not a closed loop, if the cap is partial)
  const ringOuter: P2[] = [];
  const ringInner: P2[] = [];
  for (let i = 0; i <= segU; i++) {
    const th = th0 + ((th1 - th0) * i) / segU;
    ringOuter.push([th, tE]);
    ringInner.push([th, tB]);
  }
  const full = Math.abs(th1 - th0 - TAU) < 1e-6;
  if (full) {
    ringOuter.pop();
    ringInner.pop();
  }
  edgeStrips(gb, surf, ringOuter, ringInner, hTop, hBev, hBot, R0, L, uvs, full);
  if (count) {
    center.divideScalar(count);
    avgN.normalize();
  }
  return { geometry: gb.build(), center, normal: avgN };
}

/** The undersuit / base skin of a surface: a smooth grid with analytic normals. */
export function skinGeometry(
  surf: Surface,
  o: { t0?: number; t1?: number; th0?: number; th1?: number; segU?: number; segV?: number; offset?: number; uvScale?: number; unitUV?: boolean } = {},
): THREE.BufferGeometry {
  const t0 = o.t0 ?? 0;
  const t1 = o.t1 ?? 1;
  const th0 = o.th0 ?? -Math.PI;
  const th1 = o.th1 ?? Math.PI;
  const det = Math.max(0.25, kitDetail.value);
  const segU = Math.max(8, Math.round((o.segU ?? 48) * det));
  const segV = Math.max(4, Math.round((o.segV ?? 24) * det));
  const off = o.offset ?? 0;
  const uvs = o.uvScale ?? 1;
  const R0 = surf.radius(0.5);
  const L = surf.length;
  const gb = new GeoBuilder();
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let j = 0; j <= segV; j++) {
    const t = t0 + ((t1 - t0) * j) / segV;
    for (let i = 0; i <= segU; i++) {
      const th = th0 + ((th1 - th0) * i) / segU;
      surf.point(th, t, p);
      surf.normal(th, t, n, p);
      p.addScaledVector(n, off);
      if (o.unitUV) gb.vertex(p, n, i / segU, j / segV);
      else gb.vertex(p, n, th * R0 * uvs, t * L * uvs);
    }
  }
  const row = segU + 1;
  for (let j = 0; j < segV; j++) {
    for (let i = 0; i < segU; i++) {
      const a = j * row + i;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      gb.triByNormals(a, b, d);
      gb.triByNormals(a, d, c);
    }
  }
  return gb.build();
}

// ─── textures ───

const texCache = new Map<string, THREE.Texture>();

/** Metallic-paint flake: tiny random normals so the clear coat sparkles. */
export function flakeNormalMap(): THREE.Texture {
  const hit = texCache.get("flake");
  if (hit) return hit;
  const s = 128;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const img = g.createImageData(s, s);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < s * s; i++) {
    const nx = (rnd() - 0.5) * 0.7;
    const ny = (rnd() - 0.5) * 0.7;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    img.data[i * 4] = (nx * 0.5 + 0.5) * 255;
    img.data[i * 4 + 1] = (ny * 0.5 + 0.5) * 255;
    img.data[i * 4 + 2] = nz * 255;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(26, 26);
  t.colorSpace = THREE.NoColorSpace;
  texCache.set("flake", t);
  return t;
}

/** Low-frequency smudges / wear for roughness maps (green channel), values ~0.7–1.15. */
export function smudgeMap(): THREE.Texture {
  const hit = texCache.get("smudge");
  if (hit) return hit;
  const s = 256;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const img = g.createImageData(s, s);
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // tileable value noise on a few octaves
  const lattice = (n: number) => {
    const v = new Float32Array(n * n);
    for (let i = 0; i < v.length; i++) v[i] = rnd();
    return (x: number, y: number) => {
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      const fx = x - xi;
      const fy = y - yi;
      const ux = fx * fx * (3 - 2 * fx);
      const uy = fy * fy * (3 - 2 * fy);
      const at = (i: number, j: number) => v[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
      const a = at(xi, yi);
      const b = at(xi + 1, yi);
      const cc = at(xi, yi + 1);
      const d = at(xi + 1, yi + 1);
      return a + (b - a) * ux + (cc - a) * uy + (a - b - cc + d) * ux * uy;
    };
  };
  const octs = [lattice(4), lattice(8), lattice(16), lattice(32)];
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let v = 0;
      let amp = 0.5;
      let norm = 0;
      octs.forEach((o, k) => {
        const f = 4 << k;
        v += o((x / s) * f, (y / s) * f) * amp;
        norm += amp;
        amp *= 0.55;
      });
      v /= norm;
      const r = 0.7 + 0.45 * Math.pow(v, 1.4);
      const i = (y * s + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(Math.min(1, r / 1.15) * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1.6, 1.6);
  t.colorSpace = THREE.NoColorSpace;
  texCache.set("smudge", t);
  return t;
}

/** Height field → tangent-space normal map. */
function heightToNormal(height: Float32Array, s: number, strength: number): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d")!;
  const img = g.createImageData(s, s);
  const H = (x: number, y: number) => height[((y + s) % s) * s + ((x + s) % s)];
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
      const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * s + x) * 4;
      img.data[i] = (-dx / l) * 127.5 + 127.5;
      img.data[i + 1] = (-dy / l) * 127.5 + 127.5;
      img.data[i + 2] = (1 / l) * 127.5 + 127.5;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Undersuit mechanics: segmented pads, grooves and rivets. */
export function mechNormalMap(): THREE.Texture {
  const hit = texCache.get("mech");
  if (hit) return hit;
  const s = 256;
  const h = new Float32Array(s * s);
  const box = (x0: number, y0: number, w: number, hh: number, v: number) => {
    for (let y = y0; y < y0 + hh; y++) for (let x = x0; x < x0 + w; x++) h[((y + s) % s) * s + ((x + s) % s)] = v;
  };
  // horizontal segment bands with grooves
  for (let y = 0; y < s; y += 32) {
    box(0, y, s, 28, 1);
    for (let x = 0; x < s; x += 64) box(x + ((y / 32) % 2) * 32, y + 4, 2, 20, 0.2);
  }
  // rivets
  for (let y = 16; y < s; y += 64) {
    for (let x = 16; x < s; x += 64) {
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (dx * dx + dy * dy <= 9) h[((y + dy + s) % s) * s + ((x + dx + s) % s)] = 1.4;
    }
  }
  const t = heightToNormal(h, s, 2.2);
  t.repeat.set(9, 9);
  texCache.set("mech", t);
  return t;
}

/** Fine nano-hex pattern (Mark 50 / 85 nanotech plates). */
export function hexNormalMap(): THREE.Texture {
  const hit = texCache.get("hex");
  if (hit) return hit;
  const s = 256;
  const h = new Float32Array(s * s);
  // axial hex grid: distance to the nearest cell edge
  const size = 16;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const qx = ((2 / 3) * x) / size;
      const ry = ((-1 / 3) * x + (Math.sqrt(3) / 3) * y) / size;
      // cube rounding
      let cx = qx;
      let cz = ry;
      let cy = -cx - cz;
      let rx = Math.round(cx);
      let ryy = Math.round(cy);
      let rz = Math.round(cz);
      const dx = Math.abs(rx - cx);
      const dy = Math.abs(ryy - cy);
      const dz = Math.abs(rz - cz);
      if (dx > dy && dx > dz) rx = -ryy - rz;
      else if (dy > dz) ryy = -rx - rz;
      else rz = -rx - ryy;
      cx -= rx;
      cy -= ryy;
      cz -= rz;
      const d = Math.max(Math.abs(cx), Math.abs(cy), Math.abs(cz)); // 0 centre … 0.5 edge
      h[y * s + x] = d > 0.44 ? 0 : 1;
    }
  }
  const t = heightToNormal(h, s, 1.2);
  t.repeat.set(30, 30);
  texCache.set("hex", t);
  return t;
}

/** Faint HUD glyphs on the inside of the helmet (seen when the faceplate opens). */
export function hudTexture(): THREE.Texture {
  const hit = texCache.get("hud");
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = "rgba(110,214,255,0.9)";
  g.lineWidth = 2;
  for (const [x, y, r] of [
    [170, 150, 46],
    [342, 150, 46],
  ]) {
    g.beginPath();
    g.arc(x, y, r, 0.3, Math.PI * 1.7);
    g.stroke();
    g.beginPath();
    g.arc(x, y, r * 0.55, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(x - r * 1.3, y);
    g.lineTo(x - r * 0.75, y);
    g.moveTo(x + r * 0.75, y);
    g.lineTo(x + r * 1.3, y);
    g.stroke();
  }
  g.font = "15px monospace";
  g.fillStyle = "rgba(110,214,255,0.9)";
  const vals = ["PWR 400%", "ALT 1.2K", "THR 82", "SYS OK", "REP RDY", "FLT STB", "O2 98", "TMP 36"];
  vals.forEach((v, i) => g.fillText(v, 18 + (i % 2) * 400, 70 + Math.floor(i / 2) * 26));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set("hud", t);
  return t;
}
