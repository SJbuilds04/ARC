import * as THREE from "three";
import type { GestureManager } from "../gestures/GestureManager";
import type { HandPointer } from "../gestures/HandPointer";
import type { PlaygroundEngine } from "./PlaygroundEngine";
import type { ArcObject } from "./ObjectManager";
import type { DeepDive } from "./DeepDive";

const Y = new THREE.Vector3(0, 1, 0);

/**
 * Maps hand gestures and mouse input onto playground objects:
 *   point → hover        pinch → grab + move (hand roll rotates)
 *   fist → free rotate   two-hand pinch → scale
 *   open palm hold → release / pause      swipe → next / previous object
 *   pinch on empty space → orbit the view
 */
export class PlaygroundInteraction {
  private drag: { obj: ArcObject; offset: THREE.Vector3; hand?: { x: number; y: number }; start?: THREE.Vector3 } | null = null;
  /**
   * VISOR gaze mode: the eyes choose (hover / pick), the hand acts. Returns the
   * gaze point in viewport-normalized coordinates, or null when gaze is off.
   */
  gazePoint: (() => { x: number; y: number } | null) | null = null;
  private orbit: { x: number; y: number } | null = null;
  private rotating: ArcObject | null = null;
  private scaling: { obj: ArcObject; start: number } | null = null;
  private mouse: { mode: "drag" | "rotate" | "orbit"; x: number; y: number; obj: ArcObject | null; offset: THREE.Vector3; moved: number } | null = null;
  /** Deep Dive input: pinch / drag orbits, fist turns the model (or spins the carousel), two hands zoom. */
  private dd: { orbit: { x: number; y: number } | null; zoom: number | null; mouse: { x: number; y: number; rotate: boolean; moved: number } | null } = { orbit: null, zoom: null, mouse: null };

  constructor(
    private readonly engine: PlaygroundEngine,
    gestures: GestureManager,
    private readonly pointer: HandPointer,
    private readonly isActive: () => boolean,
    private readonly deepDive: DeepDive | null = null,
  ) {
    const om = engine.objects;
    const diving = () => this.isActive() && Boolean(this.deepDive?.active);
    const dd = this.deepDive;

    // ── Deep Dive routing (runs before the object handlers below, which skip while diving) ──
    if (dd) {
      gestures.on("pinchstart", ({ x, y }) => {
        if (!diving() || this.pointer.overUI) return;
        if (!dd.click(x, y)) this.dd.orbit = { x, y };
      });
      gestures.on("pinchmove", ({ x, y }) => {
        if (!diving() || !this.dd.orbit) return;
        dd.orbit(x - this.dd.orbit.x, y - this.dd.orbit.y);
        this.dd.orbit = { x, y };
      });
      gestures.on("pinchend", () => void (this.dd.orbit = null));
      gestures.on("grabmove", ({ dx, dy }) => diving() && dd.grab(dx, dy));
      gestures.on("grabend", () => diving() && dd.release());
      gestures.on("twohandstart", () => void (this.dd.zoom = diving() ? 1 : null));
      gestures.on("twohand", ({ scale }) => {
        if (this.dd.zoom === null) return;
        dd.zoom(this.dd.zoom / scale);
        this.dd.zoom = scale;
      });
      gestures.on("twohandend", () => void (this.dd.zoom = null));
      gestures.on("swipe", ({ direction }) => diving() && dd.step(direction === "right" ? -1 : 1));
    }

    gestures.on("pointer", ({ x, y }) => {
      if (!this.isActive() || diving() || this.gazePoint?.()) return; // in gaze mode hover follows the eyes
      if (!this.drag && !this.rotating) om.setHovered(this.pointer.overUI ? null : engine.pick(x, y));
    });

    gestures.on("pinchstart", ({ x, y }) => {
      if (!this.isActive() || diving() || this.pointer.overUI) return;
      const gaze = this.gazePoint?.();
      if (gaze) {
        // Look at an object + pinch = select it; then the hand moves it (relative motion).
        const obj = engine.pick(gaze.x, gaze.y);
        if (obj) {
          om.select(obj);
          this.drag = { obj, offset: new THREE.Vector3(), hand: { x, y }, start: obj.target.position.clone() };
        } else this.orbit = { x, y };
        return;
      }
      const obj = engine.pick(x, y);
      if (obj) {
        om.select(obj);
        const hit = engine.pointOnPlane(x, y, obj.target.position);
        this.drag = { obj, offset: hit ? obj.target.position.clone().sub(hit) : new THREE.Vector3() };
      } else this.orbit = { x, y };
    });

    gestures.on("pinchmove", ({ x, y, dRoll }) => {
      if (this.drag?.hand && this.drag.start) {
        const { obj, hand, start } = this.drag;
        const k = engine.camera.position.distanceTo(start) * 1.1;
        const next = start.clone().addScaledVector(engine.cameraRight(), (x - hand.x) * k).addScaledVector(engine.cameraUp(), -(y - hand.y) * k * 0.7);
        obj.target.position.copy(next).setY(Math.max(-0.9, Math.min(3, next.y)));
        if (Math.abs(dRoll) > 0.004) obj.target.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(engine.viewAxis(), -dRoll));
      } else if (this.drag) {
        const { obj, offset } = this.drag;
        const hit = engine.pointOnPlane(x, y, obj.target.position);
        if (hit) obj.target.position.copy(hit.add(offset)).setY(Math.max(-0.9, Math.min(3, hit.y)));
        if (Math.abs(dRoll) > 0.004) obj.target.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(engine.viewAxis(), -dRoll));
      } else if (this.orbit) {
        engine.orbitBy(-(x - this.orbit.x) * 3.2, (y - this.orbit.y) * 2);
        this.orbit = { x, y };
      }
    });

    gestures.on("pinchend", () => {
      if (this.drag) om.changed();
      this.drag = null;
      this.orbit = null;
    });

    gestures.on("grabstart", () => {
      if (!this.isActive() || diving()) return;
      this.rotating = om.hovered ?? om.selected;
      if (this.rotating) om.select(this.rotating);
    });

    gestures.on("grabmove", ({ dx, dy, dRoll }) => {
      const obj = this.rotating;
      if (!obj) return;
      this.rotate(obj, dx * 7, dy * 7);
      if (Math.abs(dRoll) > 0.004) obj.target.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(engine.viewAxis(), -dRoll));
    });

    gestures.on("grabend", () => {
      if (this.rotating) om.changed();
      this.rotating = null;
    });

    gestures.on("twohandstart", () => {
      if (!this.isActive() || diving()) return;
      const obj = om.selected ?? om.hovered;
      this.drag = null;
      this.orbit = null;
      this.scaling = obj ? { obj, start: obj.target.scale } : null;
    });

    gestures.on("twohand", ({ scale }) => {
      if (this.scaling) this.scaling.obj.target.scale = THREE.MathUtils.clamp(this.scaling.start * scale, 0.2, 5);
    });

    gestures.on("twohandend", () => {
      if (this.scaling) om.changed();
      this.scaling = null;
    });

    gestures.on("palmhold", () => {
      if (!this.isActive() || diving()) return;
      // Cancel / pause: drop anything held and stop motion.
      this.drag = null;
      this.rotating = null;
      this.scaling = null;
      if (om.selected) {
        om.selected.spin = 0;
        om.changed();
      }
    });

    gestures.on("swipe", ({ direction }) => {
      if (!this.isActive() || diving()) return;
      this.cycle(direction === "right" ? 1 : -1);
    });

    this.bindMouse();
  }

  cycle(step: number): void {
    const om = this.engine.objects;
    const live = om.live();
    if (!live.length) return;
    const i = om.selected ? live.indexOf(om.selected) : -1;
    om.select(live[(i + step + live.length) % live.length]);
  }

  private rotate(obj: ArcObject, yaw: number, pitch: number): void {
    const q = new THREE.Quaternion().setFromAxisAngle(Y, yaw).multiply(new THREE.Quaternion().setFromAxisAngle(this.engine.cameraRight(), pitch));
    obj.target.quaternion.premultiply(q);
  }

  private bindMouse(): void {
    const canvas = this.engine.canvas;
    const om = this.engine.objects;
    const norm = (e: PointerEvent | MouseEvent) => ({ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight });

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    const dd = this.deepDive;
    const diving = () => Boolean(dd?.active);
    canvas.addEventListener("pointerdown", (e) => {
      const { x, y } = norm(e);
      if (dd && diving()) {
        canvas.setPointerCapture(e.pointerId);
        // Picking (cards, pins, model parts) happens on release if the pointer didn't move.
        this.dd.mouse = { x, y, rotate: e.button === 2 || e.shiftKey, moved: 0 };
        return;
      }
      const obj = this.engine.pick(x, y);
      canvas.setPointerCapture(e.pointerId);
      if (obj) om.select(obj);
      const rotate = e.button === 2 || e.shiftKey;
      const hit = obj ? this.engine.pointOnPlane(x, y, obj.target.position) : null;
      this.mouse = {
        mode: obj ? (rotate ? "rotate" : "drag") : "orbit",
        x,
        y,
        obj,
        offset: obj && hit ? obj.target.position.clone().sub(hit) : new THREE.Vector3(),
        moved: 0,
      };
    });
    canvas.addEventListener("pointermove", (e) => {
      const { x, y } = norm(e);
      if (dd && diving()) {
        const m = this.dd.mouse;
        if (!m) return;
        if (dd.picking || m.rotate) dd.grab(x - m.x, m.rotate ? y - m.y : 0);
        else dd.orbit(x - m.x, y - m.y);
        m.moved += Math.abs(x - m.x) + Math.abs(y - m.y);
        m.x = x;
        m.y = y;
        return;
      }
      if (!this.mouse) {
        om.setHovered(this.engine.pick(x, y));
        return;
      }
      const m = this.mouse;
      if (m.mode === "drag" && m.obj) {
        const hit = this.engine.pointOnPlane(x, y, m.obj.target.position);
        if (hit) m.obj.target.position.copy(hit.add(m.offset)).setY(Math.max(-0.9, Math.min(3, hit.y)));
      } else if (m.mode === "rotate" && m.obj) this.rotate(m.obj, (x - m.x) * 7, (y - m.y) * 7);
      else this.engine.orbitBy(-(x - m.x) * 3.2, (y - m.y) * 2);
      m.moved += Math.abs(x - m.x) + Math.abs(y - m.y);
      m.x = x;
      m.y = y;
    });
    const end = () => {
      if (dd && diving()) {
        const m = this.dd.mouse;
        if (m && m.moved < 0.008) dd.click(m.x, m.y);
        else if (m) dd.release();
        this.dd.mouse = null;
        return;
      }
      if (this.mouse?.obj) om.changed();
      else if (this.mouse && this.mouse.moved < 0.01) om.select(null); // plain click on empty space
      this.mouse = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * 0.0012);
        if (dd && diving()) {
          if (dd.picking) dd.step(e.deltaY > 0 ? 1 : -1);
          else dd.zoom(1 / factor);
          return;
        }
        if (om.selected && !e.altKey) {
          om.selected.target.scale = THREE.MathUtils.clamp(om.selected.target.scale * factor, 0.2, 5);
          om.changed();
        } else this.engine.zoomBy(1 / factor);
      },
      { passive: false },
    );
    canvas.addEventListener("dblclick", () => {
      if (dd && diving()) dd.onFocus(null);
      else this.engine.resetView();
    });
  }
}
