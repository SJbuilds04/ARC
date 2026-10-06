import { useState } from "react";
import { OBJECT_CATALOG } from "@shared/catalog";
import type { PlaygroundAction } from "@shared/types";
import { useArc, setLocal } from "../../core/store";
import { savePref } from "../../core/device";
import { arc, engage, voiceIn, voiceOut } from "../../core/services";
import { ArcLogo, JarvisOrb, Panel, Waveform } from "../primitives";
import { Icon, ObjectGlyph } from "../Icons";
import { CommandBar, ConfirmPanel, LatestExecution, ResponseBubble } from "../command";
import { CameraPreview, StatusHud } from "../vision";

const freq = new Uint8Array(128);
const level = () => {
  if (useArc.getState().local.speaking && voiceOut.analyser) {
    voiceOut.analyser.getByteFrequencyData(freq);
    return freq;
  }
  return voiceIn.level;
};

const pgAction = (action: PlaygroundAction) => arc.send({ type: "ACTION_REQUEST", action });

function PlaygroundRemote() {
  const scene = useArc((s) => s.state?.scene);
  const selected = scene?.objects.find((o) => o.id === scene.selectedId);
  const target = selected?.id ?? "selected";
  return (
    <div className="remote">
      <Panel title="PLAYGROUND ACTIVE ON PC" className="remote__status">
        <div className="remote__selected">
          {selected ? (
            <>
              <ObjectGlyph kind={selected.kind} size={28} />
              <span>{selected.name}</span>
              <span className="muted">{selected.scale.toFixed(2)}×</span>
            </>
          ) : (
            <span className="muted">No object selected · {scene?.objects.length ?? 0} in scene</span>
          )}
        </div>
        <div className="remote__controls">
          <button className="btn btn--tool" onClick={() => pgAction({ action: "SPIN_OBJECT", target, enabled: !(selected?.props.spin), speed: 0.5 })}>
            <Icon.Rotate width={16} height={16} /> ROTATE
          </button>
          <button className="btn btn--tool" onClick={() => pgAction({ action: "SCALE_OBJECT", target, factor: 1.25 })}>
            <Icon.Scale width={16} height={16} /> BIGGER
          </button>
          <button className="btn btn--tool" onClick={() => pgAction({ action: "SCALE_OBJECT", target, factor: 0.8 })}>
            <Icon.Scale width={16} height={16} /> SMALLER
          </button>
          <button className="btn btn--tool" onClick={() => pgAction({ action: "EXPLODE_OBJECT", target, enabled: !(selected?.props.explode) })}>
            <Icon.Explode width={16} height={16} /> EXPLODE
          </button>
          <button className="btn btn--tool btn--danger" onClick={() => pgAction({ action: "DELETE_OBJECT", target })}>
            <Icon.Trash width={16} height={16} /> DELETE
          </button>
        </div>
      </Panel>
      <div className="remote__shelf">
        {OBJECT_CATALOG.map((o) => (
          <button key={o.id} className="shelf__item" onClick={() => pgAction({ action: "SPAWN_OBJECT", object: o.id })}>
            <ObjectGlyph kind={o.id} size={30} />
            <span>{o.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SettingsSheet({ onClose }: { onClose: () => void }) {
  const local = useArc((s) => s.local);
  const s = useArc((x) => x.state);
  const toggle = (key: "handsFree" | "showFeed") => {
    const v = !local[key];
    setLocal({ [key]: v });
    savePref(key, v);
  };
  return (
    <div className="sheet" onClick={onClose}>
      <div className="sheet__body" onClick={(e) => e.stopPropagation()}>
        <div className="sheet__head">
          <span>SETTINGS</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon.Close width={18} height={18} />
          </button>
        </div>
        <Panel title="ARC STATUS">
          <StatusHud compact />
        </Panel>
        <div className="sheet__rows">
          <button className={`toggle ${local.handsFree ? "is-on" : ""}`} onClick={() => toggle("handsFree")}>
            <span>Hands-free listening</span>
            <i />
          </button>
          <button className={`toggle ${local.showFeed ? "is-on" : ""}`} onClick={() => toggle("showFeed")}>
            <span>Show camera feed</span>
            <i />
          </button>
          <div className="sheet__segment">
            <span>Vision source</span>
            {(["PHONE", "PC"] as const).map((d) => (
              <button key={d} className={`seg ${s?.vision.activeSource === d ? "is-on" : ""}`} onClick={() => arc.send({ type: "ACTION_REQUEST", action: { action: "SWITCH_CAMERA", to: d } })}>
                {d}
              </button>
            ))}
          </div>
          <button className="btn btn--deny" onClick={() => arc.forget()}>
            FORGET THIS PC
          </button>
        </div>
      </div>
    </div>
  );
}

export function PhoneApp() {
  const s = useArc((x) => x.state);
  const local = useArc((x) => x.local);
  const engaged = useArc((x) => x.engaged);
  const [settings, setSettings] = useState(false);
  const mode = s?.mode ?? "COMMAND";
  const desktop = s?.devices.PC.connected;
  const setMode = (m: "COMMAND" | "PLAYGROUND" | "VISOR") => arc.send({ type: "ACTION_REQUEST", action: { action: "SET_MODE", mode: m } });
  const switchCam = () => arc.send({ type: "ACTION_REQUEST", action: { action: "SWITCH_CAMERA", to: s?.vision.activeSource === "PHONE" ? "PC" : "PHONE" } });

  return (
    <div className={`phone is-${mode.toLowerCase()}`}>
      {local.showFeed && <CameraPreview className="phone__feed" />}
      <div className="phone__veil" />

      <header className="phone__top">
        <ArcLogo compact />
        <div className="phone__link">
          DESKTOP <i className={`dot dot--${desktop ? "ok" : "bad"}`} /> {desktop ? "CONNECTED" : "OFFLINE"}
        </div>
        <button className="icon-btn" onClick={() => setSettings(true)} aria-label="Settings">
          <Icon.Settings width={20} height={20} />
        </button>
      </header>

      <Panel className="phone__jarvis">
        <div className="phone__jarvis-row">
          <JarvisOrb activity={s?.jarvis.activity ?? "IDLE"} size={64} />
          <div className="phone__jarvis-meta">
            <div className="phone__jarvis-name">
              JARVIS <i className="dot dot--ok" /> <span>{s?.jarvis.activity === "IDLE" || !s ? "ONLINE" : s.jarvis.activity}</span>
            </div>
            <Waveform source={level} bars={30} className="phone__wave" />
          </div>
          <div className={`phone__track ${local.camera === "on" ? "is-on" : ""}`}>
            <span>HAND TRACKING</span>
            <b>{local.camera === "on" ? (local.hands ? local.gesture.replace("_", " ") : "ACTIVE") : s?.vision.activeSource === "PC" ? "PC CAMERA" : local.camera === "error" ? "ERROR" : "STANDBY"}</b>
          </div>
        </div>
      </Panel>

      <nav className="phone__modes">
        <button className={`mode-btn ${mode === "COMMAND" ? "is-active" : ""}`} onClick={() => setMode("COMMAND")}>
          <Icon.Command width={18} height={18} /> COMMAND
        </button>
        <button className={`mode-btn ${mode === "PLAYGROUND" ? "is-active" : ""}`} onClick={() => setMode("PLAYGROUND")}>
          <Icon.Cube width={18} height={18} /> PLAYGROUND
        </button>
        <button className={`mode-btn ${mode === "VISOR" ? "is-active" : ""}`} onClick={() => setMode("VISOR")}>
          <Icon.Eye width={18} height={18} /> VISOR
        </button>
        <button className="mode-btn mode-btn--icon" onClick={switchCam} aria-label={`Camera: ${s?.vision.activeSource ?? "none"}`}>
          <Icon.Camera width={18} height={18} />
        </button>
      </nav>

      <main className="phone__main">
        <ConfirmPanel large />
        {mode === "PLAYGROUND" ? <PlaygroundRemote /> : null}
        <ResponseBubble />
        <LatestExecution />
      </main>

      <footer className="phone__bottom">
        <CommandBar placeholder="Tap to speak" />
      </footer>

      {settings && <SettingsSheet onClose={() => setSettings(false)} />}

      {!engaged && (
        <div className="engage" onClick={() => void engage()}>
          <button className="engage__btn">
            <Icon.Mic width={28} height={28} />
            <span>ENGAGE ARC</span>
          </button>
          <p>Tap once to enable JARVIS's voice and your microphone.</p>
        </div>
      )}
    </div>
  );
}
