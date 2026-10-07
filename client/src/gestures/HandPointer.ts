import type { GestureManager, Pose } from "./GestureManager";

/** How far ahead (ms) the cursor is extrapolated to cancel camera + inference delay. */
const LEAD_MS = 30;

/**
 * HandPointer — bridges gestures to the DOM. Any <button> (or element with
 * [data-hand]) becomes hand-interactive: point to hover, pinch to click.
 * Elements with [data-hold] receive `arc-press` / `arc-release` events instead,
 * so they can require a sustained pinch (used for HIGH-risk confirmations).
 *
 * The cursor is positioned directly on the DOM each frame — no React renders.
 */
export class HandPointer {
  private cursor: HTMLDivElement;
  private hovered: HTMLElement | null = null;
  private pressed: HTMLElement | null = null;
  private visible = false;
  private x = 0;
  private y = 0;
  /** True while the pointer is over interactive UI (3D layers should ignore the pinch). */
  overUI = false;
  /** When set (VISOR gaze mode), the eyes own the cursor: the hand only supplies pinches. */
  private delegate: { press(): void; release(): void } | null = null;

  constructor(gestures: GestureManager) {
    this.cursor = document.createElement("div");
    this.cursor.className = "hand-cursor";
    this.cursor.innerHTML = `<div class="hand-cursor__ring"></div><div class="hand-cursor__dot"></div>`;
    document.body.appendChild(this.cursor);

    gestures.on("pointer", ({ x, y, pose }) => !this.delegate && this.move(x, y, pose));
    gestures.on("pinchstart", () => (this.delegate ? this.delegate.press() : this.press()));
    gestures.on("pinchend", () => (this.delegate ? this.delegate.release() : this.release()));
    gestures.on("lost", () => this.hide());
    gestures.on("frame", ({ hands }) => {
      if (!hands.length) this.hide();
    });
  }

  setDelegate(delegate: { press(): void; release(): void } | null): void {
    if (this.delegate === delegate) return;
    this.delegate = delegate;
    this.overUI = false;
    if (delegate) this.hide();
  }

  private move(nx: number, ny: number, pose: Pose): void {
    const now = performance.now();
    const x = nx * window.innerWidth;
    const y = ny * window.innerHeight;
    // Velocity from consecutive samples (px/ms), lightly smoothed — used to predict between camera frames.
    if (this.visible && this.lastSampleAt) {
      const dt = Math.max(8, now - this.lastSampleAt);
      this.vx = this.vx * 0.3 + ((x - this.x) / dt) * 0.7;
      this.vy = this.vy * 0.3 + ((y - this.y) / dt) * 0.7;
    }
    this.x = x;
    this.y = y;
    this.lastSampleAt = now;
    // Draw the new sample immediately instead of waiting for the next display frame.
    if (this.visible) this.cursor.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    if (!this.visible) {
      this.visible = true;
      this.cx = x;
      this.cy = y;
      this.vx = this.vy = 0;
      this.cursor.classList.add("is-visible");
      this.startGlide();
    }
    this.cursor.dataset.pose = pose;

    // One hit-test per hand update (not per display frame).
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const hit = el && !this.cursor.contains(el) ? el.closest<HTMLElement>("button:not([disabled]), [data-hand]") : null;
    const target = hit && !hit.closest("[data-hand-ignore]") ? hit : null;
    this.overUI = Boolean(target) || Boolean(el?.closest(".panel, .arc-ui-block, .vpanel, .visor__dock, .visor__bottom, .vglass"));
    if (target !== this.hovered) {
      this.hovered?.classList.remove("is-hand-hover");
      target?.classList.add("is-hand-hover");
      this.hovered = target;
      this.cursor.classList.toggle("is-over-target", Boolean(target));
    }
  }

  private cx = 0;
  private cy = 0;
  private vx = 0;
  private vy = 0;
  private lastSampleAt = 0;
  private glideRaf = 0;
  /**
   * Latency first: every display frame the cursor jumps straight to the predicted position
   * (last sample + velocity × (age + one camera frame of lead)), no easing. The lead hides part
   * of the camera → model delay; it only applies while the hand is actually moving.
   */
  private startGlide(): void {
    cancelAnimationFrame(this.glideRaf);
    const step = (now: number) => {
      if (!this.visible) return;
      const lead = Math.min(70, now - this.lastSampleAt + LEAD_MS);
      const moving = Math.hypot(this.vx, this.vy) > 0.05; // px/ms
      this.cx = this.x + (moving ? this.vx * lead : 0);
      this.cy = this.y + (moving ? this.vy * lead : 0);
      this.cursor.style.transform = `translate3d(${this.cx.toFixed(1)}px, ${this.cy.toFixed(1)}px, 0)`;
      this.glideRaf = requestAnimationFrame(step);
    };
    this.glideRaf = requestAnimationFrame(step);
  }

  private press(): void {
    this.cursor.classList.add("is-pinching");
    const target = this.hovered;
    if (!target) return;
    if (target.hasAttribute("data-hold")) {
      this.pressed = target;
      target.dispatchEvent(new CustomEvent("arc-press", { bubbles: true }));
    } else {
      target.classList.add("is-hand-press");
      setTimeout(() => target.classList.remove("is-hand-press"), 220);
      target.click();
    }
  }

  private release(): void {
    this.cursor.classList.remove("is-pinching");
    if (this.pressed) {
      this.pressed.dispatchEvent(new CustomEvent("arc-release", { bubbles: true }));
      this.pressed = null;
    }
  }

  private hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.overUI = false;
    this.release();
    this.cursor.classList.remove("is-visible");
    this.hovered?.classList.remove("is-hand-hover");
    this.hovered = null;
  }
}
