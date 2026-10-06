export type TargetPhase = "acquired" | "locked" | "confirmed";

export interface TargetBox {
  /** Rect (DOM target) or circle (3D object), in viewport px. */
  rect?: { x: number; y: number; w: number; h: number };
  circle?: { x: number; y: number; r: number };
  label: string;
  kind: string;
  phase: TargetPhase;
  /** Dwell progress 0..1 (only when dwell is enabled). */
  dwell: number;
}

/**
 * The gaze reticle and targeting frame. Positioned imperatively every frame
 * (no React renders), like the hand cursor.
 */
export class GazeCursor {
  private root: HTMLDivElement;
  private reticle: HTMLDivElement;
  private dwellArc: SVGCircleElement;
  private frame: HTMLDivElement;
  private label: HTMLDivElement;
  private visible = false;
  private lastLabel = "";

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "gaze-layer";
    this.root.innerHTML = `
      <div class="gaze-frame"><i></i><i></i><i></i><i></i></div>
      <div class="gaze-label"></div>
      <div class="gaze-reticle">
        <svg viewBox="0 0 60 60">
          <circle class="gaze-reticle__ring" cx="30" cy="30" r="17"/>
          <circle class="gaze-reticle__dwell" cx="30" cy="30" r="22" pathLength="100" stroke-dasharray="0 100"/>
          <path class="gaze-reticle__cross" d="M30 6v9M30 45v9M6 30h9M45 30h9"/>
          <circle class="gaze-reticle__dot" cx="30" cy="30" r="2"/>
        </svg>
      </div>`;
    this.reticle = this.root.querySelector(".gaze-reticle")!;
    this.dwellArc = this.root.querySelector(".gaze-reticle__dwell")!;
    this.frame = this.root.querySelector(".gaze-frame")!;
    this.label = this.root.querySelector(".gaze-label")!;
    document.body.appendChild(this.root);
  }

  show(on: boolean): void {
    if (this.visible === on) return;
    this.visible = on;
    this.root.classList.toggle("is-visible", on);
    if (!on) this.setTarget(null);
  }

  /** `held` = tracking is momentarily unreliable (blink, low confidence): reticle dims. */
  move(x: number, y: number, held: boolean): void {
    this.reticle.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    this.reticle.classList.toggle("is-held", held);
  }

  setLost(lost: boolean): void {
    this.root.classList.toggle("is-lost", lost);
  }

  setTarget(t: TargetBox | null): void {
    this.reticle.classList.toggle("has-target", Boolean(t));
    if (!t) {
      this.frame.classList.remove("is-on", "is-locked", "is-confirmed");
      this.label.classList.remove("is-on");
      this.dwellArc.setAttribute("stroke-dasharray", "0 100");
      this.lastLabel = "";
      return;
    }
    const pad = 8;
    const box = t.rect
      ? { x: t.rect.x - pad, y: t.rect.y - pad, w: t.rect.w + pad * 2, h: t.rect.h + pad * 2 }
      : { x: t.circle!.x - t.circle!.r, y: t.circle!.y - t.circle!.r, w: t.circle!.r * 2, h: t.circle!.r * 2 };
    Object.assign(this.frame.style, { transform: `translate3d(${box.x}px, ${box.y}px, 0)`, width: `${box.w}px`, height: `${box.h}px` });
    this.frame.classList.add("is-on");
    this.frame.classList.toggle("is-locked", t.phase !== "acquired");
    this.frame.classList.toggle("is-confirmed", t.phase === "confirmed");
    const text = `${t.phase === "confirmed" ? "ACTION CONFIRMED" : t.phase === "locked" ? "TARGET LOCKED" : "TARGET ACQUIRED"}<b>${escapeHtml(t.label)}</b>`;
    if (text !== this.lastLabel) {
      this.label.innerHTML = text;
      this.lastLabel = text;
    }
    const below = box.y + box.h + 34 < window.innerHeight;
    const labelW = this.label.offsetWidth || 220;
    this.label.style.transform = `translate3d(${Math.max(8, Math.min(window.innerWidth - labelW - 8, box.x))}px, ${below ? box.y + box.h + 6 : box.y - 34}px, 0)`;
    this.label.classList.add("is-on");
    this.dwellArc.setAttribute("stroke-dasharray", `${Math.round(t.dwell * 100)} 100`);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]!);
}
