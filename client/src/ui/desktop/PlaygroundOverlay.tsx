import { useEffect, useState } from "react";
import { OBJECT_CATALOG, catalogEntry } from "@shared/catalog";
import type { PlaygroundAction } from "@shared/types";
import { useArc } from "../../core/store";
import { arc, playground } from "../../core/services";
import type { ArcObject } from "../../playground/ObjectManager";
import { Panel, StatusRow } from "../primitives";
import { Icon, ObjectGlyph } from "../Icons";
import { CameraPreview } from "../vision";

export const playgroundAction = (action: PlaygroundAction) => arc.send({ type: "ACTION_REQUEST", action });

function useSelected(): ArcObject | null {
  const [sel, setSel] = useState<ArcObject | null>(playground?.objects.selected ?? null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!playground) return;
    const off = playground.objects.on("selection", setSel);
    const id = setInterval(() => tick((n) => n + 1), 250); // live transform readout
    return () => {
      off();
      clearInterval(id);
    };
  }, []);
  return sel && sel.removing === null ? sel : null;
}

function ObjectPanel() {
  const obj = useSelected();
  if (!obj) {
    return (
      <Panel title="3D PLAYGROUND" className="object-panel">
        <p className="muted">Say “Spawn a 3D Earth”, pick a model below, or pinch to grab an object.</p>
        <div className="gesture-legend">
          <span>PINCH</span> grab · move <span>TWIST</span> rotate <span>FIST</span> free rotate <span>TWO HANDS</span> scale <span>PALM</span> release <span>SWIPE</span> next
        </div>
      </Panel>
    );
  }
  const entry = catalogEntry(obj.kind);
  const p = obj.root.position;
  const e = obj.root.rotation;
  const deg = (r: number) => `${Math.round((r * 180) / Math.PI)}°`;
  const canExplode = Boolean(obj.built.explode);
  const target = obj.id;
  return (
    <Panel title={entry?.category.toUpperCase() ?? "OBJECT"} className="object-panel">
      <div className="object-panel__name">{obj.name}</div>
      <div className="object-panel__facts">
        {entry?.facts.map((f) => <StatusRow key={f.label} label={f.label.toUpperCase()} value={f.value} />)}
        <StatusRow label="POSITION" value={`${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`} />
        <StatusRow label="ROTATION" value={`${deg(e.x)}, ${deg(e.y)}, ${deg(e.z)}`} />
        <StatusRow label="SCALE" value={`${obj.root.scale.x.toFixed(2)}×`} />
      </div>
      <div className="object-panel__actions">
        <button className={`btn btn--tool ${obj.spin ? "is-on" : ""}`} onClick={() => playgroundAction({ action: "SPIN_OBJECT", target, enabled: !obj.spin, speed: 0.5 })}>
          <Icon.Rotate width={16} height={16} /> ROTATE
        </button>
        <button className="btn btn--tool" onClick={() => playgroundAction({ action: "SCALE_OBJECT", target, factor: 1.25 })}>
          <Icon.Scale width={16} height={16} /> SCALE +
        </button>
        <button className="btn btn--tool" onClick={() => playgroundAction({ action: "SCALE_OBJECT", target, factor: 0.8 })}>
          <Icon.Scale width={16} height={16} /> SCALE −
        </button>
        {canExplode && (
          <button className={`btn btn--tool ${obj.explodeTarget ? "is-on" : ""}`} onClick={() => playgroundAction({ action: "EXPLODE_OBJECT", target, enabled: !obj.explodeTarget })}>
            <Icon.Explode width={16} height={16} /> EXPLODE
          </button>
        )}
        {Object.entries(obj.props)
          .filter(([, v]) => typeof v === "boolean")
          .map(([k, v]) => (
            <button key={k} className={`btn btn--tool ${v ? "is-on" : ""}`} onClick={() => playgroundAction({ action: "SET_PROPERTY", target, property: k as "atmosphere", value: !v })}>
              {k.toUpperCase()}
            </button>
          ))}
        <button className="btn btn--tool btn--danger" onClick={() => playgroundAction({ action: "DELETE_OBJECT", target })}>
          <Icon.Trash width={16} height={16} /> DELETE
        </button>
      </div>
    </Panel>
  );
}

function LocationPanel() {
  const location = useArc((s) => s.location);
  if (!location) return null;
  return (
    <Panel title="LOCATION" className="location-panel" right={<button className="icon-btn" onClick={() => useArc.setState({ location: null })} aria-label="Close"><Icon.Close width={14} height={14} /></button>}>
      <div className="location-panel__name">{location.name.toUpperCase()}</div>
      {location.items.map((i) => (
        <StatusRow key={i.label} label={i.label.toUpperCase()} value={i.value} />
      ))}
    </Panel>
  );
}

function VisionCard() {
  const s = useArc((x) => x.state);
  const local = useArc((x) => x.local);
  if (!s) return null;
  const src = s.vision.activeSource;
  return (
    <Panel title={`${src} CAMERA`} className="vision-card" right={<span className={`pill ${s.vision.sources[src].status === "ACTIVE" ? "is-ok" : ""}`}>{s.vision.sources[src].status}</span>}>
      <CameraPreview className="vision-card__feed" showVideo={src === "PC"} />
      <div className="vision-card__meta">
        <span>{local.gesture !== "NONE" ? local.gesture.replace("_", " ") : "NO HAND"}</span>
        <span>{src === "PC" && local.trackerFps ? `${local.trackerFps} FPS` : ""}</span>
      </div>
    </Panel>
  );
}

function Shelf() {
  const [offset, setOffset] = useState(0);
  const visible = 9;
  const items = OBJECT_CATALOG;
  const page = items.slice(offset, offset + visible);
  return (
    <div className="shelf arc-ui-block">
      <button className="shelf__nav" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - 3))} aria-label="Previous models">
        <Icon.Chevron width={18} height={18} style={{ transform: "scaleX(-1)" }} />
      </button>
      {page.map((o) => (
        <button key={o.id} className="shelf__item" onClick={() => playgroundAction({ action: "SPAWN_OBJECT", object: o.id })} title={`Spawn ${o.name}`}>
          <ObjectGlyph kind={o.id} />
          <span>{o.name}</span>
        </button>
      ))}
      <button className="shelf__nav" disabled={offset + visible >= items.length} onClick={() => setOffset((o) => Math.min(items.length - visible, o + 3))} aria-label="More models">
        <Icon.Chevron width={18} height={18} />
      </button>
    </div>
  );
}

export function PlaygroundOverlay() {
  return (
    <div className="pg-overlay">
      <div className="pg-overlay__left">
        <ObjectPanel />
        <div className="pg-overlay__tools">
          <button className="btn btn--tool" onClick={() => playgroundAction({ action: "RESET_VIEW" })}>
            <Icon.Reset width={16} height={16} /> RESET VIEW
          </button>
          <button className="btn btn--tool" onClick={() => playgroundAction({ action: "CLEAR_SCENE" })}>
            <Icon.Trash width={16} height={16} /> CLEAR
          </button>
        </div>
      </div>
      <div className="pg-overlay__right">
        <VisionCard />
        <LocationPanel />
      </div>
      <Shelf />
    </div>
  );
}
