import { useArc, setLocal } from "../../core/store";
import { savePref } from "../../core/device";
import { arc } from "../../core/services";
import { Panel, StatusRow } from "../primitives";
import { Icon } from "../Icons";
import { StatusHud } from "../vision";

export function VisorTab() {
  const visorDevice = useArc((s) => s.state?.visor.device ?? null);
  const enter = () => arc.send({ type: "ACTION_REQUEST", action: { action: "SET_MODE", mode: "VISOR" } });
  return (
    <div className="ph-stack">
      <Panel className="ph-card ph-visor">
        <svg className="ph-visor__art" viewBox="0 0 200 120" aria-hidden="true">
          <path d="M20 70 Q20 18 100 14 Q180 18 180 70 L168 104 Q100 118 32 104 Z" />
          <path d="M44 62 Q72 52 92 62 M108 62 Q128 52 156 62" />
          <circle cx="68" cy="60" r="9" />
          <circle cx="132" cy="60" r="9" />
          <path d="M60 92 Q100 100 140 92" />
        </svg>
        <span className="ph-kicker">ARC VISOR</span>
        <b className="ph-title">Step inside the helmet</b>
        <p className="muted small">Your face with the Iron Man HUD around it. Turn the phone sideways. The front camera only tracks your face; you control the HUD by touch.</p>
        <button className="btn ph-wide" onClick={enter}>
          <Icon.Eye width={18} height={18} /> ENTER VISOR
        </button>
        {visorDevice === "PC" && <p className="muted small">The visor is open on the PC right now. Entering here moves it to the phone.</p>}
      </Panel>
    </div>
  );
}

export function SettingsTab() {
  const local = useArc((s) => s.local);
  const s = useArc((x) => x.state);
  const toggle = (key: "handsFree" | "showFeed") => {
    const v = !local[key];
    setLocal({ [key]: v });
    savePref(key, v);
  };
  const voice = s?.services.voice;
  return (
    <div className="ph-stack">
      <Panel title="LISTENING" className="ph-card">
        <button className={`toggle ${local.handsFree ? "is-on" : ""}`} onClick={() => toggle("handsFree")}>
          <span>Hands-free (“JARVIS…”)</span>
          <i />
        </button>
        <StatusRow label="MIC" value={local.mic === "error" ? (local.micError ?? "ERROR") : local.mic.toUpperCase()} tone={local.mic === "error" ? "bad" : local.mic === "off" ? "off" : "ok"} />
        <StatusRow label="VOICE" value={voice?.engine === "GROQ" ? "GROQ · MALE" : voice?.engine === "LOCAL" ? "WINDOWS · GEORGE" : "BROWSER"} tone={voice?.engine === "BROWSER" ? "warn" : "ok"} />
      </Panel>
      <Panel title="CAMERA" className="ph-card">
        <button
          className={`toggle ${s?.vision.phoneHands ? "is-on" : ""}`}
          onClick={() => arc.send({ type: "ACTION_REQUEST", action: { action: "SET_PHONE_HANDS", enabled: !s?.vision.phoneHands } })}
        >
          <span>Hand tracking on the phone</span>
          <i />
        </button>
        <button className={`toggle ${local.showFeed ? "is-on" : ""}`} onClick={() => toggle("showFeed")}>
          <span>Show camera behind the UI</span>
          <i />
        </button>
        <p className="muted small">The phone is touch-first. Hand tracking runs on the PC webcam; the visor uses the phone’s front camera for your face only.</p>
      </Panel>
      <Panel title="ARC STATUS" className="ph-card">
        <StatusHud compact />
      </Panel>
      <button className="btn btn--deny ph-wide" onClick={() => arc.forget()}>
        FORGET THIS PC
      </button>
    </div>
  );
}
