import * as THREE from "three";
import type { DeepDivePart } from "@shared/types";
import type { PartAnchor } from "./objects/parts";
import { isLight } from "../core/theme";

/** The canvas only moves when the window resizes: read its rect once, not every frame (no forced layout). */
let canvasRect: DOMRect | null = null;
addEventListener("resize", () => (canvasRect = null));
const rectOf = (canvas: HTMLCanvasElement) => (canvasRect ??= canvas.getBoundingClientRect());
const labelInk = new THREE.Color();

const SVG_NS = "http://www.w3.org/2000/svg";
const CARD_W = 172;
const GAP = 8;

interface Item {
  part: PartAnchor;
  card: HTMLButtonElement;
  name: HTMLSpanElement;
  info: HTMLSpanElement;
  dot: HTMLDivElement;
  line: SVGPolylineElement;
  occluded: boolean;
  shown: boolean;
  infoText: string;
  /** Card height, measured only when what's on the card changes (measuring every frame forces a layout). */
  h: number;
  hKey: string;
}

const tmp = new THREE.Vector3();
const tmpWorld = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpEdge = new THREE.Vector3();

/** Bumped when the web fonts finish loading (text wraps differently then). */
let fontEpoch = 0;
void document.fonts?.ready.then(() => fontEpoch++);

function cardHeight(it: Item): number {
  const key = `${fontEpoch}|${it.card.classList.contains("has-info")}|${it.infoText}|${it.name.textContent}`;
  if (key !== it.hKey || !it.h) {
    const h = it.card.offsetHeight;
    if (h > 0) {
      it.h = h;
      it.hKey = key;
    }
  }
  return it.h || 30;
}

/**
 * AR labels for Deep Dive, drawn as DOM (crisp text, no GL cost) and positioned imperatively
 * every frame — React never re-renders per frame. Labels sit in two columns beside the model
 * with elbow leader lines to their anchor points, like an anatomy diagram.
 */
export class LabelLayer {
  readonly el: HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private items = new Map<string, Item>();
  private info = new Map<string, DeepDivePart>();
  private visible = false;

  constructor(private readonly onClick: (partId: string) => void) {
    this.el = document.createElement("div");
    this.el.className = "dd-labels";
    this.el.style.display = "none";
    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.classList.add("dd-labels__lines");
    this.el.appendChild(this.svg);
  }

  setParts(parts: PartAnchor[]): void {
    for (const it of this.items.values()) {
      it.card.remove();
      it.dot.remove();
      it.line.remove();
    }
    this.items.clear();
    for (const part of parts) {
      const card = document.createElement("button");
      card.className = "dd-label";
      card.type = "button";
      const name = document.createElement("span");
      name.className = "dd-label__name";
      name.textContent = part.name;
      const info = document.createElement("span");
      info.className = "dd-label__info";
      card.append(name, info);
      card.addEventListener("click", (e) => {
        e.stopPropagation();
        this.onClick(part.id);
      });
      const dot = document.createElement("div");
      dot.className = "dd-label__dot";
      const line = document.createElementNS(SVG_NS, "polyline");
      line.classList.add("dd-label__line");
      this.svg.appendChild(line);
      this.el.append(dot, card);
      const item: Item = { part, card, name, info, dot, line, occluded: false, shown: true, infoText: "", h: 0, hKey: "" };
      this.items.set(part.id, item);
      this.show(item, false);
    }
    this.setInfo(this.info);
  }

  /** Functions written by JARVIS / pinned by the user arrive through ARC state. */
  setInfo(info: Map<string, DeepDivePart>): void {
    this.info = info;
    for (const it of this.items.values()) {
      const text = info.get(it.part.id)?.info ?? it.part.info ?? "";
      if (text !== it.infoText) {
        it.infoText = text;
        it.info.textContent = text;
      }
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.el.style.display = "none";
  }

  clear(): void {
    this.setParts([]);
    this.hide();
  }

  private show(it: Item, on: boolean): void {
    if (it.shown === on) return;
    it.shown = on;
    const d = on ? "" : "none";
    it.card.style.display = d;
    it.dot.style.display = d;
    it.line.style.display = d;
  }

  layout(
    canvas: HTMLCanvasElement,
    camera: THREE.Camera,
    centre: THREE.Vector3,
    radius: number,
    include: (p: PartAnchor) => boolean,
    withInfo: boolean,
    focusId: string | null,
    color: string,
    occlusion: ((p: PartAnchor, world: THREE.Vector3) => boolean) | null,
    safe: { left: number; right: number } | null = null,
  ): void {
    if (!this.visible) {
      this.visible = true;
      this.el.style.display = "";
    }
    // light theme: the label colour as dark ink, so it reads on the light page
    this.el.style.setProperty("--dd-label", isLight() ? `#${labelInk.set(color).multiplyScalar(0.1).getHexString()}` : color);
    const rect = rectOf(canvas);
    const project = (v: THREE.Vector3) => {
      const p = tmp.copy(v).project(camera);
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, z: p.z };
    };
    const c = project(centre);
    const right = tmpRight.setFromMatrixColumn(camera.matrixWorld, 0);
    const edge = project(tmpEdge.copy(centre).addScaledVector(right, radius));
    const r = Math.max(60, Math.hypot(edge.x - c.x, edge.y - c.y));
    const minX = (safe?.left ?? rect.left + 16) + 4;
    const maxX = (safe?.right ?? rect.right - 16) - 4;
    const colLeft = Math.max(minX + CARD_W, c.x - r - 36);
    const colRight = Math.min(maxX - CARD_W, c.x + r + 36);

    const sides: Record<"L" | "R", { it: Item; x: number; y: number; h: number }[]> = { L: [], R: [] };
    for (const it of this.items.values()) {
      if (!include(it.part)) {
        this.show(it, false);
        continue;
      }
      const world = it.part.anchor.getWorldPosition(tmpWorld);
      const s = project(world);
      if (s.z > 1 || s.z < -1) {
        this.show(it, false);
        continue;
      }
      if (occlusion) it.occluded = occlusion(it.part, world);
      const focused = it.part.id === focusId;
      const big = (withInfo || focused) && Boolean(it.infoText);
      sides[s.x < c.x ? "L" : "R"].push({ it, x: s.x, y: s.y, h: 0 });
      it.card.classList.toggle("has-info", big);
      it.card.classList.toggle("is-focus", focused);
      it.card.classList.toggle("is-behind", it.occluded && !focused);
      it.dot.classList.toggle("is-focus", focused);
      it.dot.classList.toggle("is-behind", it.occluded && !focused);
      it.line.classList.toggle("is-behind", it.occluded && !focused);
      this.show(it, true);
    }

    // Card heights (names and functions wrap to several lines): re-measured only when a card changes.
    for (const e of [...sides.L, ...sides.R]) e.h = cardHeight(e.it);
    const top0 = rect.top + 100; // below the top bar
    const bottom0 = rect.bottom - 170; // above the reply + command bar
    for (const side of ["L", "R"] as const) {
      const list = sides[side].sort((a, b) => a.y - b.y);
      // Not enough room for every description: minor parts go compact first, then everyone but the focus.
      const room = bottom0 - top0;
      const total = () => list.reduce((n, e) => n + e.h + GAP, 0);
      for (const pass of [2, 1] as const) {
        if (total() <= room) break;
        const squeezed = list.filter((e) => e.it.part.id !== focusId && (pass === 1 || e.it.part.level === 2) && e.it.card.classList.contains("has-info"));
        for (const e of squeezed) e.it.card.classList.remove("has-info");
        for (const e of squeezed) e.h = cardHeight(e.it);
      }
      // Push cards apart vertically, then pull the stack back on screen if it overflows.
      let cursor = top0;
      const ys = list.map((e) => {
        const y = Math.max(e.y - e.h / 2, cursor);
        cursor = y + e.h + GAP;
        return y;
      });
      // Keep the column above the bottom controls, then below the top bar (two passes, no overlaps).
      let limit = bottom0;
      for (let i = list.length - 1; i >= 0; i--) {
        ys[i] = Math.min(ys[i], limit - list[i].h);
        limit = ys[i] - GAP;
      }
      let next = top0;
      for (let i = 0; i < list.length; i++) {
        ys[i] = Math.max(ys[i], next);
        next = ys[i] + list[i].h + GAP;
      }
      list.forEach((e, i) => {
        const top = ys[i];
        const midY = top + e.h / 2;
        const cardX = side === "L" ? colLeft - CARD_W : colRight;
        const edgeX = side === "L" ? colLeft : colRight;
        const elbowX = side === "L" ? colLeft + 18 : colRight - 18;
        e.it.card.style.transform = `translate3d(${cardX.toFixed(1)}px, ${top.toFixed(1)}px, 0)`;
        e.it.card.classList.toggle("is-left", side === "L");
        e.it.dot.style.transform = `translate3d(${e.x.toFixed(1)}px, ${e.y.toFixed(1)}px, 0)`;
        e.it.line.setAttribute("points", `${e.x.toFixed(1)},${e.y.toFixed(1)} ${elbowX.toFixed(1)},${midY.toFixed(1)} ${edgeX.toFixed(1)},${midY.toFixed(1)}`);
      });
    }
  }
}
