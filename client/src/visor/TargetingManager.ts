import type { GazeCursor, TargetPhase } from "./GazeCursor";
import type { HandPointer } from "../gestures/HandPointer";
import type { GazeSettings } from "./GazeSmoother";

export interface SceneTarget {
  id: string;
  label: string;
  x: number;
  y: number;
  r: number;
}

type Target =
  | { kind: "dom"; el: HTMLElement; label: string; type: string }
  | { kind: "object"; id: string; label: string; circle: { x: number; y: number; r: number } };

export interface TargetInfo {
  label: string;
  type: string;
  phase: TargetPhase;
}

const LOCK_MS = 450;
const CONFIRM_FLASH_MS = 650;

/**
 * TargetingManager — resolves what the user is looking at. DOM controls get
 * magnetic snapping (gaze is never pixel-accurate) with hysteresis so targets
 * don't flicker; when no control is near, a scene probe (the 3D playground)
 * can supply an object. Pinch (from the hand) activates the current target.
 */
export class TargetingManager {
  private target: Target | null = null;
  private since = 0;
  private confirmedUntil = 0;
  private dwellFired = false;
  private pressed: HTMLElement | null = null;
  private candidates: HTMLElement[] = [];
  private candidatesAt = 0;
  sceneProbe: ((x: number, y: number) => SceneTarget | null) | null = null;
  onChange: ((t: TargetInfo | null) => void) | null = null;
  private lastInfoKey = "";

  constructor(
    private readonly cursor: GazeCursor,
    private readonly pointer: HandPointer,
    private readonly settings: () => GazeSettings,
  ) {}

  update(p: { x: number; y: number } | null, t: number): void {
    const next = p ? this.findDom(p, t) ?? this.findObject(p) : null;
    if (!sameTarget(next, this.target)) {
      this.target = next;
      this.since = t;
      this.dwellFired = false;
    } else if (next && this.target) this.target = next; // refresh geometry
    this.pointer.overUI = this.target?.kind === "dom";

    const tg = this.target;
    if (!tg) {
      this.cursor.setTarget(null);
      this.emitInfo(null);
      return;
    }
    const held = t - this.since;
    const phase: TargetPhase = t < this.confirmedUntil ? "confirmed" : held >= LOCK_MS ? "locked" : "acquired";
    const s = this.settings();
    let dwell = 0;
    if (s.dwellEnabled && tg.kind === "dom") {
      dwell = Math.min(1, held / s.dwellMs);
      if (dwell >= 1 && !this.dwellFired) {
        this.dwellFired = true;
        this.activate();
      }
    }
    const rect = tg.kind === "dom" ? tg.el.getBoundingClientRect() : null;
    this.cursor.setTarget({
      rect: rect ? { x: rect.left, y: rect.top, w: rect.width, h: rect.height } : undefined,
      circle: tg.kind === "object" ? tg.circle : undefined,
      label: tg.label,
      kind: tg.kind === "dom" ? tg.type : "3D MODEL",
      phase,
      dwell,
    });
    this.emitInfo({ label: tg.label, type: tg.kind === "dom" ? tg.type : "3D MODEL", phase });
  }

  /** Pinch start. Returns true if a DOM control consumed it. */
  press(): boolean {
    const tg = this.target;
    if (!tg) return false;
    this.confirmedUntil = performance.now() + CONFIRM_FLASH_MS;
    if (tg.kind === "object") return false; // the playground handles selection / drag
    this.activate(true);
    return true;
  }

  release(): void {
    if (this.pressed) {
      this.pressed.dispatchEvent(new CustomEvent("arc-release", { bubbles: true }));
      this.pressed = null;
    }
  }

  clear(): void {
    this.release();
    this.target = null;
    this.pointer.overUI = false;
    this.cursor.setTarget(null);
    this.emitInfo(null);
  }

  private activate(fromPinch = false): void {
    const tg = this.target;
    if (!tg || tg.kind !== "dom") return;
    this.confirmedUntil = performance.now() + CONFIRM_FLASH_MS;
    if (tg.el.hasAttribute("data-hold")) {
      // HIGH-risk confirm: must be held — only a sustained pinch can do that.
      if (!fromPinch) return;
      this.pressed = tg.el;
      tg.el.dispatchEvent(new CustomEvent("arc-press", { bubbles: true }));
      return;
    }
    tg.el.classList.add("is-hand-press");
    setTimeout(() => tg.el.classList.remove("is-hand-press"), 220);
    tg.el.click();
  }

  private findDom(p: { x: number; y: number }, t: number): Target | null {
    if (t - this.candidatesAt > 250) {
      this.candidatesAt = t;
      this.candidates = Array.from(document.querySelectorAll<HTMLElement>("[data-gaze], button:not([disabled])")).filter(
        (el) => !el.closest("[data-gaze-ignore]") && el.offsetParent !== null,
      );
    }
    const magnet = Math.max(36, Math.min(window.innerWidth, window.innerHeight) * 0.06);
    let best: { el: HTMLElement; d: number } | null = null;
    for (const el of this.candidates) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.bottom < 0 || r.top > window.innerHeight) continue;
      const dx = Math.max(r.left - p.x, 0, p.x - r.right);
      const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
      const d = Math.hypot(dx, dy);
      if (d <= magnet && (!best || d < best.d)) best = { el, d };
    }
    // Hysteresis: keep the current control unless the gaze clearly left it.
    const cur = this.target?.kind === "dom" ? this.target.el : null;
    if (cur && cur.isConnected && (!best || best.d > 0)) {
      const r = cur.getBoundingClientRect();
      const d = Math.hypot(Math.max(r.left - p.x, 0, p.x - r.right), Math.max(r.top - p.y, 0, p.y - r.bottom));
      if (d <= magnet + 28) return { kind: "dom", el: cur, label: labelOf(cur), type: typeOf(cur) };
    }
    return best ? { kind: "dom", el: best.el, label: labelOf(best.el), type: typeOf(best.el) } : null;
  }

  private findObject(p: { x: number; y: number }): Target | null {
    const hit = this.sceneProbe?.(p.x, p.y);
    return hit ? { kind: "object", id: hit.id, label: hit.label, circle: { x: hit.x, y: hit.y, r: hit.r } } : null;
  }

  private emitInfo(info: TargetInfo | null): void {
    const key = info ? `${info.label}|${info.phase}` : "";
    if (key === this.lastInfoKey) return;
    this.lastInfoKey = key;
    this.onChange?.(info);
  }
}

function sameTarget(a: Target | null, b: Target | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "dom" && b.kind === "dom") return a.el === b.el;
  if (a.kind === "object" && b.kind === "object") return a.id === b.id;
  return false;
}

function labelOf(el: HTMLElement): string {
  return (el.dataset.gazeLabel ?? el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 36).toUpperCase() || "CONTROL";
}

function typeOf(el: HTMLElement): string {
  return el.dataset.gazeType ?? "CONTROL";
}
