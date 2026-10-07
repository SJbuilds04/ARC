import { useEffect, useRef, useState } from "react";
import { catalogEntry } from "@shared/catalog";
import type { DeepDiveSettings, PlaygroundAction } from "@shared/types";
import { useArc } from "../core/store";
import { arc } from "../core/services";

export const ddAction = (action: PlaygroundAction) => arc.send({ type: "ACTION_REQUEST", action });
export const ddSet = (patch: Partial<DeepDiveSettings>) => ddAction({ action: "DEEP_DIVE_SET", ...patch });

const EMPTY_PARTS: never[] = [];

export const BG_SWATCHES = [
  { name: "Space", value: "#02070f" },
  { name: "Black", value: "#000000" },
  { name: "Navy", value: "#04102e" },
  { name: "Graphite", value: "#1c2129" },
  { name: "Plum", value: "#14062a" },
  { name: "Forest", value: "#062914" },
];
export const HOLO_SWATCHES = [
  { name: "Cyan", value: "#5fd8ff" },
  { name: "Blue", value: "#3b8bff" },
  { name: "Green", value: "#2fe07a" },
  { name: "Amber", value: "#ffb000" },
  { name: "Red", value: "#ff3b4a" },
  { name: "Purple", value: "#9b4dff" },
  { name: "White", value: "#e6f4ff" },
];

/** A range slider that updates live locally and sends to ARC at most ~12×/s. */
function LiveSlider({ value, min, max, step, onCommit, label }: { value: number; min: number; max: number; step: number; onCommit: (v: number) => void; label: string }) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  const timer = useRef<number | null>(null);
  const latest = useRef(value);
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);
  const push = (v: number) => {
    latest.current = v;
    setLocal(v);
    if (timer.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      onCommit(latest.current);
    }, 80);
  };
  return (
    <label className="dd-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onPointerDown={() => (dragging.current = true)}
        onPointerUp={() => (dragging.current = false)}
        onChange={(e) => push(Number(e.target.value))}
      />
      <b>{Math.round(((local - min) / (max - min)) * 100)}%</b>
    </label>
  );
}

function Swatches({ list, value, onPick, label }: { list: { name: string; value: string }[]; value: string; onPick: (v: string) => void; label: string }) {
  return (
    <div className="dd-swatches">
      <span>{label}</span>
      <div className="dd-swatches__row">
        {list.map((s) => (
          <button key={s.value} className={`dd-swatch ${value.toLowerCase() === s.value ? "is-on" : ""}`} style={{ background: s.value }} onClick={() => onPick(s.value)} aria-label={`${label} ${s.name}`} title={s.name} />
        ))}
        <label className="dd-swatch dd-swatch--custom" title="Custom colour">
          <input type="color" value={value} onChange={(e) => onPick(e.target.value)} aria-label={`${label} custom colour`} />
        </label>
      </div>
    </div>
  );
}

/** AR · style · explode · spin · label detail · colours. Used on the PC panel and the phone's second screen. */
export function DeepDiveControls({ compact = false }: { compact?: boolean }) {
  const s = useArc((x) => x.state?.deepDive.settings);
  const hasModel = useArc((x) => Boolean(x.state?.deepDive.modelId));
  if (!s || !hasModel) return null;
  return (
    <div className={`dd-controls ${compact ? "is-compact" : ""}`}>
      <button className={`dd-ar ${s.ar ? "is-on" : ""}`} onClick={() => ddSet({ ar: !s.ar })}>
        <i />
        <span>AR MODE</span>
        <b>{s.ar ? "ON" : "OFF"}</b>
      </button>
      <div className="dd-seg" role="group" aria-label="View style">
        {(["solid", "wireframe", "xray"] as const).map((v) => (
          <button key={v} className={s.style === v ? "is-on" : ""} onClick={() => ddSet({ style: v })}>
            {v === "xray" ? "X-RAY" : v.toUpperCase()}
          </button>
        ))}
      </div>
      {s.ar && (
        <div className="dd-seg" role="group" aria-label="Label detail">
          {(["auto", "few", "all"] as const).map((v) => (
            <button key={v} className={s.detail === v ? "is-on" : ""} onClick={() => ddSet({ detail: v })}>
              {v === "auto" ? "LABELS: ZOOM" : v === "few" ? "MAIN" : "ALL"}
            </button>
          ))}
        </div>
      )}
      <LiveSlider label="EXPLODE" value={s.explode} min={0} max={1} step={0.01} onCommit={(v) => ddSet({ explode: v })} />
      <LiveSlider label="SPIN" value={s.spin} min={0} max={1.5} step={0.05} onCommit={(v) => ddSet({ spin: v })} />
      <Swatches label="BACKGROUND" list={BG_SWATCHES} value={s.bg} onPick={(v) => ddSet({ bg: v })} />
      <Swatches label="HOLOGRAM" list={HOLO_SWATCHES} value={s.color} onPick={(v) => ddSet({ color: v })} />
      {s.ar && <Swatches label="LABELS" list={HOLO_SWATCHES} value={s.labelColor} onPick={(v) => ddSet({ labelColor: v })} />}
    </div>
  );
}

/** Tap a part → the PC flies to it and highlights it. */
export function PartsList({ max, namesOnly = false }: { max?: number; namesOnly?: boolean }) {
  const parts = useArc((x) => x.state?.deepDive.parts ?? EMPTY_PARTS);
  const focus = useArc((x) => x.state?.deepDive.focusPart ?? null);
  if (!parts.length) return <p className="muted small">No labelled parts on this model. {" "}Imported models get parts from their mesh names, or pin your own labels.</p>;
  return (
    <div className="dd-parts">
      {parts.slice(0, max).map((p) => (
        <button key={p.id} className={`dd-part ${focus === p.id ? "is-on" : ""} ${p.level === 2 ? "is-minor" : ""}`} onClick={() => ddAction({ action: "FOCUS_PART", part: focus === p.id ? null : p.id })}>
          <span className="dd-part__name">{p.name}</span>
          {(focus === p.id || (!max && !namesOnly)) && p.info && <span className="dd-part__info">{p.info}</span>}
        </button>
      ))}
    </div>
  );
}

export function useDeepDiveTitle(): { name: string; category: string } | null {
  const id = useArc((x) => x.state?.deepDive.modelId ?? null);
  const name = useArc((x) => x.state?.deepDive.modelName ?? null);
  if (!id) return null;
  return { name: name ?? catalogEntry(id)?.name ?? id, category: id.startsWith("m-") ? "YOUR MODEL" : (catalogEntry(id)?.category.toUpperCase() ?? "MODEL") };
}
