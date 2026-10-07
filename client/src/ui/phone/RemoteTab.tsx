import { useEffect, useRef, useState } from "react";
import { catalogEntry } from "@shared/catalog";
import type { PlaygroundAction } from "@shared/types";
import { useArc } from "../../core/store";
import { prefs, savePref } from "../../core/device";
import { arc } from "../../core/services";
import { Panel } from "../primitives";
import { Icon } from "../Icons";
import { DeepDiveControls, PartsList, ddAction, useDeepDiveTitle } from "../deepdive";
import type { PhoneTab } from "./PhoneApp";

const act = (action: PlaygroundAction) => arc.send({ type: "ACTION_REQUEST", action });
const EMPTY: never[] = [];

/**
 * Touchpad: one finger orbits / turns, two fingers pinch to zoom. Movement is batched per
 * animation frame and sent as volatile CONTROL messages (stale input is dropped, never queued).
 */
function Touchpad({ hint }: { hint: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current!;
    const pts = new Map<number, { x: number; y: number }>();
    let acc = { dx: 0, dy: 0, zoom: 0 };
    let raf = 0;
    let lastPinch = 0;
    const flush = () => {
      raf = 0;
      const t = performance.now();
      if (acc.dx || acc.dy) arc.sendVolatile({ type: "CONTROL", kind: "orbit", dx: clamp(acc.dx), dy: clamp(acc.dy), t });
      if (acc.zoom) arc.sendVolatile({ type: "CONTROL", kind: "zoom", dx: 0, dy: clamp(acc.zoom), t });
      acc = { dx: 0, dy: 0, zoom: 0 };
    };
    const queue = () => (raf ||= requestAnimationFrame(flush));
    const pinchDist = () => {
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const down = (e: PointerEvent) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) lastPinch = pinchDist();
      el.classList.add("is-active");
    };
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      const w = el.clientWidth || 1;
      if (pts.size === 1) {
        acc.dx += (e.clientX - p.x) / w;
        acc.dy += (e.clientY - p.y) / w;
      }
      p.x = e.clientX;
      p.y = e.clientY;
      if (pts.size === 2) {
        const d = pinchDist();
        if (lastPinch > 0 && d > 0) acc.zoom += -Math.log(d / lastPinch);
        lastPinch = d;
      }
      queue();
    };
    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) lastPinch = 0;
      if (!pts.size) {
        el.classList.remove("is-active");
        arc.sendVolatile({ type: "CONTROL", kind: "end", dx: 0, dy: 0, t: performance.now() });
      }
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, []);
  return (
    <div className="ph-pad" ref={ref}>
      <div className="ph-pad__grid" />
      <span>{hint}</span>
    </div>
  );
}

const clamp = (v: number) => Math.max(-10, Math.min(10, v));

type OrientationPermission = { requestPermission?: () => Promise<"granted" | "denied"> };

/** Tilt the phone to turn the model on the PC (device orientation → CONTROL "tilt"). */
function TiltToggle() {
  const [on, setOn] = useState(() => prefs("tilt", false));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    let prev: { b: number; g: number } | null = null;
    let last = 0;
    const handler = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return;
      const now = performance.now();
      if (prev && now - last > 30) {
        let dg = e.gamma - prev.g;
        let db = e.beta - prev.b;
        if (Math.abs(dg) > 45) dg = 0; // wrap-around jumps
        if (Math.abs(db) > 45) db = 0;
        if (Math.abs(dg) + Math.abs(db) > 0.4) arc.sendVolatile({ type: "CONTROL", kind: "tilt", dx: clamp(dg / 140), dy: clamp(db / 140), t: now });
        prev = { b: e.beta, g: e.gamma };
        last = now;
      } else if (!prev) prev = { b: e.beta, g: e.gamma };
    };
    window.addEventListener("deviceorientation", handler);
    return () => window.removeEventListener("deviceorientation", handler);
  }, [on]);
  const toggle = async () => {
    setError(null);
    if (!on) {
      // iOS asks for motion permission, and only from a tap.
      const req = (window.DeviceOrientationEvent as unknown as OrientationPermission | undefined)?.requestPermission;
      if (req) {
        try {
          if ((await req()) !== "granted") return setError("Motion access was denied");
        } catch {
          return setError("Motion access needs HTTPS and a tap");
        }
      }
    }
    setOn(!on);
    savePref("tilt", !on);
  };
  return (
    <>
      <button className={`toggle ${on ? "is-on" : ""}`} onClick={toggle}>
        <span>
          <Icon.Tilt width={18} height={18} /> Tilt to turn
        </span>
        <i />
      </button>
      {error && <p className="ph-error">{error}</p>}
    </>
  );
}

function SpaceSwitch() {
  const space = useArc((s) => s.state?.spaces.PC ?? "COMMAND");
  const diving = useArc((s) => Boolean(s.state?.deepDive.active));
  const current = space === "PLAYGROUND" ? (diving ? "DIVE" : "PLAYGROUND") : space;
  const go = (to: "COMMAND" | "PLAYGROUND" | "DIVE") => {
    if (to === "DIVE") act({ action: "DEEP_DIVE", enabled: true });
    else if (to === "PLAYGROUND" && diving) act({ action: "DEEP_DIVE", enabled: false });
    else arc.send({ type: "ACTION_REQUEST", action: { action: "SET_MODE", mode: to } });
  };
  return (
    <div className="ph-seg" role="group" aria-label="PC space">
      {(
        [
          ["COMMAND", "Console"],
          ["PLAYGROUND", "Playground"],
          ["DIVE", "Deep Dive"],
        ] as const
      ).map(([id, label]) => (
        <button key={id} className={current === id ? "is-on" : ""} onClick={() => go(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function DeepDiveRemote({ go }: { go: (t: PhoneTab) => void }) {
  const title = useDeepDiveTitle();
  const focus = useArc((s) => s.state?.deepDive.focusPart ?? null);
  const parts = useArc((s) => s.state?.deepDive.parts ?? EMPTY);
  const ar = useArc((s) => s.state?.deepDive.settings.ar ?? false);
  if (!title)
    return (
      <Panel title="PICK A MODEL ON THE PC" className="ph-card">
        <div className="ph-carousel">
          <button className="btn btn--tool" onClick={() => act({ action: "CAROUSEL", command: "previous" })} aria-label="Previous">
            <Icon.Chevron width={20} height={20} style={{ transform: "scaleX(-1)" }} />
          </button>
          <button className="btn" onClick={() => act({ action: "CAROUSEL", command: "select" })}>
            OPEN THIS ONE
          </button>
          <button className="btn btn--tool" onClick={() => act({ action: "CAROUSEL", command: "next" })} aria-label="Next">
            <Icon.Chevron width={20} height={20} />
          </button>
        </div>
        <Touchpad hint="Swipe to spin the carousel" />
        <button className="ph-link" onClick={() => go("library")}>
          Or choose from the Library →
        </button>
      </Panel>
    );
  const focused = parts.find((p) => p.id === focus);
  return (
    <>
      <Panel className="ph-card ph-dive-head">
        <span className="ph-kicker">{title.category} · DEEP DIVE</span>
        <b className="ph-title">{title.name}</b>
        {focused && (
          <div className="ph-focus">
            <span>FOCUSED</span>
            <b>{focused.name}</b>
            {focused.info && <p>{focused.info}</p>}
            <button className="btn btn--small" onClick={() => ddAction({ action: "FOCUS_PART", part: null })}>
              SHOW WHOLE MODEL
            </button>
          </div>
        )}
      </Panel>
      <Touchpad hint="Drag to turn · pinch to zoom" />
      <TiltToggle />
      <Panel title={`PARTS${parts.length ? ` · ${parts.length}` : ""}`} className="ph-card">
        {!ar && parts.length > 0 && (
          <button className="ph-link" onClick={() => ddAction({ action: "DEEP_DIVE_SET", ar: true })}>
            Turn on AR mode to label every part →
          </button>
        )}
        <PartsList namesOnly />
      </Panel>
      <Panel title="LOOK" className="ph-card">
        <DeepDiveControls compact />
      </Panel>
    </>
  );
}

function PlaygroundRemote() {
  const scene = useArc((s) => s.state?.scene);
  const selected = scene?.objects.find((o) => o.id === scene.selectedId);
  const target = selected?.id ?? "selected";
  return (
    <>
      <Panel title="SELECTED" className="ph-card">
        {selected ? (
          <div className="ph-selected">
            <b>{selected.name}</b>
            <span className="muted">{selected.scale.toFixed(2)}×</span>
          </div>
        ) : (
          <p className="muted small">Nothing selected · {scene?.objects.length ?? 0} in the scene. Spawn something from the Library.</p>
        )}
        <div className="ph-tools">
          <button className="btn btn--tool" onClick={() => act({ action: "SPIN_OBJECT", target, enabled: !selected?.props.spin, speed: 0.5 })}>
            <Icon.Rotate width={16} height={16} /> SPIN
          </button>
          <button className="btn btn--tool" onClick={() => act({ action: "SCALE_OBJECT", target, factor: 1.25 })}>
            <Icon.Scale width={16} height={16} /> BIGGER
          </button>
          <button className="btn btn--tool" onClick={() => act({ action: "SCALE_OBJECT", target, factor: 0.8 })}>
            <Icon.Scale width={16} height={16} /> SMALLER
          </button>
          <button className="btn btn--tool" onClick={() => act({ action: "EXPLODE_OBJECT", target, enabled: !selected?.props.explode })}>
            <Icon.Explode width={16} height={16} /> EXPLODE
          </button>
          {selected && (
            <button className="btn btn--tool" onClick={() => act({ action: "DEEP_DIVE", enabled: true, model: selected.kind })}>
              <Icon.Dive width={16} height={16} /> DEEP DIVE
            </button>
          )}
          <button className="btn btn--tool btn--danger" onClick={() => act({ action: "DELETE_OBJECT", target })}>
            <Icon.Trash width={16} height={16} /> DELETE
          </button>
        </div>
      </Panel>
      <Touchpad hint={selected ? "Drag to turn it · pinch to resize" : "Drag to look around · pinch to zoom"} />
      <TiltToggle />
      {scene && scene.objects.length > 1 && (
        <Panel title="IN THE SCENE" className="ph-card">
          <div className="ph-chips">
            {scene.objects.map((o) => (
              <button key={o.id} className={`ph-chip ${o.id === scene.selectedId ? "is-on" : ""}`} onClick={() => act({ action: "SELECT_OBJECT", target: o.id })}>
                {o.name || catalogEntry(o.kind)?.name || o.kind}
              </button>
            ))}
          </div>
        </Panel>
      )}
    </>
  );
}

export function RemoteTab({ go }: { go: (t: PhoneTab) => void }) {
  const pcOnline = useArc((s) => Boolean(s.state?.devices.PC.connected));
  const space = useArc((s) => s.state?.spaces.PC ?? "COMMAND");
  const diving = useArc((s) => Boolean(s.state?.deepDive.active));
  if (!pcOnline)
    return (
      <div className="ph-stack">
        <Panel title="PC OFFLINE" className="ph-card">
          <p className="muted small">Open ARC on the PC (https://localhost:7777). The phone reconnects to it automatically.</p>
        </Panel>
      </div>
    );
  return (
    <div className="ph-stack">
      <SpaceSwitch />
      {space === "PLAYGROUND" && diving ? (
        <DeepDiveRemote go={go} />
      ) : space === "PLAYGROUND" ? (
        <PlaygroundRemote />
      ) : (
        <Panel title={space === "VISOR" ? "PC IS IN VISOR" : "PC IS ON THE CONSOLE"} className="ph-card">
          <p className="muted small">Anything you say or type on the phone runs on the PC: “open VS Code”, “search for…”, “system status”.</p>
          <div className="ph-tools">
            <button className="btn btn--tool" onClick={() => arc.send({ type: "ACTION_REQUEST", action: { action: "SET_MODE", mode: "PLAYGROUND" } })}>
              <Icon.Cube width={16} height={16} /> OPEN PLAYGROUND
            </button>
            <button className="btn btn--tool" onClick={() => act({ action: "DEEP_DIVE", enabled: true })}>
              <Icon.Dive width={16} height={16} /> DEEP DIVE
            </button>
          </div>
        </Panel>
      )}
    </div>
  );
}
