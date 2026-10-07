import type { Hand } from "@shared/types";
import { Emitter } from "../core/emitter";
import { OneEuroFilter } from "./OneEuroFilter";

export type Pose = "NONE" | "POINT" | "PINCH" | "FIST" | "OPEN_PALM" | "OTHER";

export interface TrackedHand {
  key: number;
  handedness: "Left" | "Right";
  /** Raw landmarks (image space, not mirrored). */
  lm: number[];
  /** Smoothed pointer in screen space (0..1), mirrored to match the selfie view. */
  pointer: { x: number; y: number };
  /** Pinch midpoint in mirrored image space (for two-hand distance). */
  pinchPoint: { x: number; y: number };
  pose: Pose;
  pinching: boolean;
  /** 0 (open) … 1 (touching). */
  pinchStrength: number;
  /** In-plane hand rotation (radians), wrist → middle knuckle. */
  roll: number;
  palmSize: number;
  extended: [boolean, boolean, boolean, boolean, boolean];
}

export interface GestureEvents extends Record<string, unknown> {
  frame: { hands: TrackedHand[]; t: number };
  pointer: { x: number; y: number; pose: Pose; hand: TrackedHand };
  pinchstart: { x: number; y: number; hand: TrackedHand };
  pinchmove: { x: number; y: number; hand: TrackedHand; dRoll: number };
  pinchend: { x: number; y: number; hand: TrackedHand | null };
  grabstart: { x: number; y: number; hand: TrackedHand };
  grabmove: { x: number; y: number; dx: number; dy: number; dRoll: number; hand: TrackedHand };
  grabend: { x: number; y: number };
  palmhold: { hand: TrackedHand };
  swipe: { direction: "left" | "right" };
  twohandstart: { distance: number };
  twohand: { scale: number; distance: number };
  twohandend: void;
  pose: { pose: Pose; hand: TrackedHand };
  lost: void;
}

// Landmark indices
const WRIST = 0, THUMB_TIP = 4, INDEX_MCP = 5, INDEX_TIP = 8, MIDDLE_MCP = 9;
const FINGERS = [
  { mcp: 5, pip: 6, tip: 8 },
  { mcp: 9, pip: 10, tip: 12 },
  { mcp: 13, pip: 14, tip: 16 },
  { mcp: 17, pip: 18, tip: 20 },
];

const PINCH_ON = 0.26;
const PINCH_OFF = 0.4;
const POSE_STABLE_FRAMES = 3;
const LOST_AFTER_MS = 260;
const CLICK_LOCK_MS = 80;

/** Comfortable region of the camera frame mapped to the full screen. */
const REGION = { x0: 0.14, x1: 0.86, y0: 0.1, y1: 0.75 };

interface HandMemory {
  key: number;
  wrist: { x: number; y: number };
  fx: OneEuroFilter;
  fy: OneEuroFilter;
  pinching: boolean;
  pose: Pose;
  candidate: Pose;
  candidateFrames: number;
  lastRoll: number | null;
  palmSince: number;
  palmFired: boolean;
  swipeTrail: { t: number; x: number }[];
  lockUntil: number;
  lockedPointer: { x: number; y: number } | null;
  grabLast: { x: number; y: number } | null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * GestureManager — turns hand landmark frames into gestures. It is input-agnostic:
 * frames may come from this device's camera or be relayed from another device,
 * and any UI layer (DOM pointer, 3D playground) subscribes to the same events.
 */
export class GestureManager extends Emitter<GestureEvents> {
  private memories: HandMemory[] = [];
  private nextKey = 1;
  private primaryKey: number | null = null;
  private lastSeen = 0;
  private twoHand: { startDistance: number } | null = null;
  private swipeCooldownUntil = 0;
  hands: TrackedHand[] = [];
  enabled = true;

  /** Ingest one frame. `aspect` = video width / height. */
  ingest(raw: Hand[], t: number, aspect: number, mirror = true): void {
    if (!this.enabled) raw = [];
    if (!raw.length) {
      if (this.hands.length && t - this.lastSeen > LOST_AFTER_MS) this.reset();
      return;
    }
    this.lastSeen = t;

    const used = new Set<HandMemory>();
    const tracked: TrackedHand[] = [];

    for (const hand of raw) {
      const lm = hand.lm;
      const px = (i: number) => (mirror ? 1 - lm[i * 3] : lm[i * 3]);
      const py = (i: number) => lm[i * 3 + 1];
      const dist = (a: number, b: number) => Math.hypot((px(a) - px(b)) * aspect, py(a) - py(b));
      const wrist = { x: px(WRIST), y: py(WRIST) };

      // Associate with the nearest remembered hand.
      let mem: HandMemory | undefined;
      let best = 0.25;
      for (const m of this.memories) {
        if (used.has(m)) continue;
        const d = Math.hypot(m.wrist.x - wrist.x, m.wrist.y - wrist.y);
        if (d < best) {
          best = d;
          mem = m;
        }
      }
      if (!mem) mem = this.newMemory(wrist);
      used.add(mem);
      mem.wrist = wrist;

      const palm = Math.max(1e-4, dist(WRIST, MIDDLE_MCP));
      const extended = FINGERS.map((f) => dist(f.tip, WRIST) > dist(f.pip, WRIST) * 1.12) as boolean[];
      const curled = FINGERS.map((f) => dist(f.tip, WRIST) < dist(f.mcp, WRIST) * 1.12);
      const thumbOut = dist(THUMB_TIP, INDEX_MCP) / palm > 0.6;
      const pinchRatio = dist(THUMB_TIP, INDEX_TIP) / palm;
      const indexForward = dist(INDEX_TIP, WRIST) > dist(INDEX_MCP, WRIST) * 1.05;

      // Pinch uses hysteresis directly (responsiveness matters most here).
      mem.pinching = mem.pinching ? pinchRatio < PINCH_OFF : pinchRatio < PINCH_ON && indexForward;

      let candidate: Pose;
      if (mem.pinching) candidate = "PINCH";
      else if (curled.every(Boolean)) candidate = "FIST";
      else if (extended.every(Boolean) && thumbOut) candidate = "OPEN_PALM";
      else if (extended[0] && !extended[1] && !extended[2] && !extended[3]) candidate = "POINT";
      else candidate = "OTHER";

      if (candidate === "PINCH") {
        mem.pose = "PINCH";
        mem.candidateFrames = 0;
      } else if (candidate === mem.candidate) {
        if (++mem.candidateFrames >= POSE_STABLE_FRAMES) mem.pose = candidate;
      } else {
        mem.candidate = candidate;
        mem.candidateFrames = 1;
        if (mem.pose === "PINCH") mem.pose = "OTHER"; // leaving pinch is immediate
      }

      // Pointer anchor: mostly the index knuckle (stable while pinching) + some fingertip for precision.
      const ax = px(INDEX_MCP) * 0.65 + px(INDEX_TIP) * 0.35;
      const ay = py(INDEX_MCP) * 0.65 + py(INDEX_TIP) * 0.35;
      const sx = clamp01((ax - REGION.x0) / (REGION.x1 - REGION.x0));
      const sy = clamp01((ay - REGION.y0) / (REGION.y1 - REGION.y0));
      let pointer = { x: mem.fx.filter(sx, t), y: mem.fy.filter(sy, t) };
      if (t < mem.lockUntil && mem.lockedPointer) pointer = mem.lockedPointer;

      const roll = Math.atan2(py(MIDDLE_MCP) - py(WRIST), (px(MIDDLE_MCP) - px(WRIST)) * aspect);

      tracked.push({
        key: mem.key,
        handedness: hand.handedness,
        lm,
        pointer,
        pinchPoint: { x: (px(THUMB_TIP) + px(INDEX_TIP)) / 2, y: (py(THUMB_TIP) + py(INDEX_TIP)) / 2 },
        pose: mem.pose,
        pinching: mem.pinching,
        pinchStrength: clamp01(1 - (pinchRatio - PINCH_ON) / (0.9 - PINCH_ON)),
        roll,
        palmSize: palm,
        extended: [thumbOut, ...extended] as TrackedHand["extended"],
      });
    }

    // Hands that disappeared end their interactions.
    for (const m of this.memories) if (!used.has(m)) this.endHand(m, null);
    this.memories = this.memories.filter((m) => used.has(m));
    this.hands = tracked;
    this.processEvents(tracked, t);
    this.emit("frame", { hands: tracked, t });
  }

  get primary(): TrackedHand | null {
    return this.hands.find((h) => h.key === this.primaryKey) ?? null;
  }

  reset(): void {
    for (const m of this.memories) this.endHand(m, null);
    this.memories = [];
    this.hands = [];
    this.primaryKey = null;
    if (this.twoHand) {
      this.twoHand = null;
      this.emit("twohandend", undefined);
    }
    this.emit("frame", { hands: [], t: performance.now() });
    this.emit("lost", undefined);
  }

  private newMemory(wrist: { x: number; y: number }): HandMemory {
    const m: HandMemory = {
      key: this.nextKey++,
      wrist,
      // Steady when still, near-zero lag when moving (high beta).
      fx: new OneEuroFilter(2.2, 60, 1.5),
      fy: new OneEuroFilter(2.2, 60, 1.5),
      pinching: false,
      pose: "NONE",
      candidate: "NONE",
      candidateFrames: 0,
      lastRoll: null,
      palmSince: 0,
      palmFired: false,
      swipeTrail: [],
      lockUntil: 0,
      lockedPointer: null,
      grabLast: null,
    };
    this.memories.push(m);
    return m;
  }

  private endHand(m: HandMemory, hand: TrackedHand | null): void {
    const p = this.hands.find((h) => h.key === m.key)?.pointer ?? { x: 0.5, y: 0.5 };
    if (m.lockedPointer || m.pose === "PINCH") this.emit("pinchend", { ...p, hand });
    if (m.grabLast) this.emit("grabend", p);
    m.pose = "NONE";
    m.pinching = false;
    m.lockedPointer = null;
    m.grabLast = null;
  }

  private prevPose = new Map<number, Pose>();

  private processEvents(hands: TrackedHand[], t: number): void {
    // Primary hand: keep the current one while present, else the closest (largest) hand.
    if (!hands.some((h) => h.key === this.primaryKey)) {
      this.primaryKey = hands.reduce((a, b) => (b.palmSize > a.palmSize ? b : a)).key;
    }

    const pinchers = hands.filter((h) => h.pinching);
    if (pinchers.length === 2) {
      const [a, b] = pinchers;
      const d = Math.hypot(a.pinchPoint.x - b.pinchPoint.x, a.pinchPoint.y - b.pinchPoint.y);
      if (!this.twoHand) {
        this.twoHand = { startDistance: Math.max(0.02, d) };
        this.emit("twohandstart", { distance: d });
      } else this.emit("twohand", { scale: d / this.twoHand.startDistance, distance: d });
    } else if (this.twoHand) {
      this.twoHand = null;
      this.emit("twohandend", undefined);
    }

    for (const hand of hands) {
      const mem = this.memories.find((m) => m.key === hand.key)!;
      const prev = this.prevPose.get(hand.key) ?? "NONE";
      const isPrimary = hand.key === this.primaryKey;
      const dRoll = mem.lastRoll === null ? 0 : wrapAngle(hand.roll - mem.lastRoll);
      mem.lastRoll = hand.roll;

      if (hand.pose !== prev) {
        if (prev === "PINCH" && isPrimary && !this.twoHand) {
          mem.lockedPointer = null;
          this.emit("pinchend", { ...hand.pointer, hand });
        }
        if (prev === "FIST" && mem.grabLast) {
          mem.grabLast = null;
          this.emit("grabend", hand.pointer);
        }
        if (hand.pose === "PINCH" && isPrimary && !this.twoHand) {
          mem.lockUntil = t + CLICK_LOCK_MS;
          mem.lockedPointer = { ...hand.pointer };
          this.emit("pinchstart", { ...hand.pointer, hand });
        }
        if (hand.pose === "FIST" && isPrimary) {
          mem.grabLast = { ...hand.pointer };
          this.emit("grabstart", { ...hand.pointer, hand });
        }
        if (hand.pose === "OPEN_PALM") {
          mem.palmSince = t;
          mem.palmFired = false;
          mem.swipeTrail = [];
        }
        if (isPrimary) this.emit("pose", { pose: hand.pose, hand });
        this.prevPose.set(hand.key, hand.pose);
      }

      if (t >= mem.lockUntil) mem.lockedPointer = null;

      if (isPrimary) {
        this.emit("pointer", { ...hand.pointer, pose: hand.pose, hand });
        if (hand.pose === "PINCH" && !this.twoHand) this.emit("pinchmove", { ...hand.pointer, hand, dRoll });
        if (hand.pose === "FIST" && mem.grabLast) {
          const dx = hand.pointer.x - mem.grabLast.x;
          const dy = hand.pointer.y - mem.grabLast.y;
          mem.grabLast = { ...hand.pointer };
          this.emit("grabmove", { ...hand.pointer, dx, dy, dRoll, hand });
        }
      }

      if (hand.pose === "OPEN_PALM") {
        // Swipe: fast horizontal travel of an open palm.
        const wx = mem.wrist.x; // mirrored wrist x
        mem.swipeTrail.push({ t, x: wx });
        while (mem.swipeTrail.length && t - mem.swipeTrail[0].t > 280) mem.swipeTrail.shift();
        const first = mem.swipeTrail[0];
        const dx = wx - first.x;
        const dt = (t - first.t) / 1000;
        if (t > this.swipeCooldownUntil && dt > 0.08 && Math.abs(dx) > 0.2 && Math.abs(dx) / dt > 0.9) {
          this.swipeCooldownUntil = t + 800;
          mem.swipeTrail = [];
          mem.palmFired = true; // a swipe is not a palm-hold
          this.emit("swipe", { direction: dx > 0 ? "right" : "left" });
        } else if (!mem.palmFired && t - mem.palmSince > 550 && Math.abs(dx) < 0.06) {
          mem.palmFired = true;
          this.emit("palmhold", { hand });
        }
      }
    }
    for (const key of [...this.prevPose.keys()]) if (!hands.some((h) => h.key === key)) this.prevPose.delete(key);
  }
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
