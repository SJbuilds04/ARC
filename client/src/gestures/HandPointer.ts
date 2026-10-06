import type { GestureManager, Pose } from "./GestureManager";

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
    this.x = nx * window.innerWidth;
    this.y = ny * window.innerHeight;
    if (!this.visible) {
      this.visible = true;
      this.cursor.classList.add("is-visible");
    }
    this.cursor.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
    this.cursor.dataset.pose = pose;

    const target = this.targetAt(this.x, this.y);
    this.overUI = Boolean(target) || this.isOverPanel(this.x, this.y);
    if (target !== this.hovered) {
      this.hovered?.classList.remove("is-hand-hover");
      target?.classList.add("is-hand-hover");
      this.hovered = target;
      this.cursor.classList.toggle("is-over-target", Boolean(target));
    }
  }

  private targetAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    if (!el || this.cursor.contains(el)) return null;
    const t = el.closest<HTMLElement>("button:not([disabled]), [data-hand]");
    return t && !t.closest("[data-hand-ignore]") ? t : null;
  }

  private isOverPanel(x: number, y: number): boolean {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return Boolean(el?.closest(".panel, .arc-ui-block"));
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
