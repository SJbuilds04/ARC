import { useEffect, useRef, useState, type ReactNode } from "react";
import { useArc } from "../../core/store";
import { arc, voiceIn, voiceOut } from "../../core/services";
import type { ArcAction } from "@shared/types";
import { ArcLogo, Clock, JarvisOrb, Waveform, type DotTone } from "../primitives";
import { Icon, ObjectGlyph } from "../Icons";
import { CameraPreview } from "../vision";
import { CommandBar, ConfirmPanel, LatestExecution } from "../command";
import { FaceHud } from "./FaceHud";
import { VisorBoot, VisorCalibration, VisorSettings } from "./VisorOverlays";

const send = (action: ArcAction) => arc.send({ type: "ACTION_REQUEST", action });

const MODELS = [
  { id: "earth", name: "Earth" },
  { id: "mars", name: "Mars" },
  { id: "moon", name: "Moon" },
  { id: "saturn", name: "Saturn" },
  { id: "solar_system", name: "Solar System" },
  { id: "heart", name: "Human Heart" },
  { id: "car", name: "Car Model" },
  { id: "engine", name: "V8 Engine" },
];

const APPS: { target: string; label: string; glyph: ReactNode }[] = [
  { target: "Visual Studio Code", label: "VS Code", glyph: <path d="M16 3 7 11l-3-2-2 1v4l2 1 3-2 9 8 4-2V5zM16 8v8l-5-4z" /> },
  { target: "Google Chrome", label: "Chrome", glyph: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" /><path d="M12 8.5h8.5M8.9 13.8 4.6 6.4M15 13.8l-4.3 7.4" /></> },
  { target: "File Explorer", label: "Files", glyph: <path d="M3 6h7l2 2h9v11H3z" /> },
  { target: "Spotify", label: "Spotify", glyph: <><circle cx="12" cy="12" r="9" /><path d="M7 9.5c3.5-1 7-.6 10 1M7.8 12.6c2.8-.7 5.6-.4 8 .9M8.6 15.5c2-.5 4.1-.3 6 .7" /></> },
  { target: "Calculator", label: "Calculator", glyph: <><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M8 7h8M8 11h2M12 11h2M16 11h0M8 15h2M12 15h2M8 18h2M12 18h4" /></> },
  { target: "Settings", label: "Settings", glyph: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></> },
];

const freq = new Uint8Array(128);
const level = () => {
  if (useArc.getState().local.speaking && voiceOut.analyser) {
    voiceOut.analyser.getByteFrequencyData(freq);
    return freq;
  }
  return voiceIn.level;
};

function Row({ label, value, tone }: { label: string; value: string; tone: DotTone }) {
  return (
    <div className="vrow">
      <span>{label}</span>
      <b className={`is-${tone}`}>
        <i className={`dot dot--${tone}`} />
        {value}
      </b>
    </div>
  );
}

function StatusPanel() {
  const v = useArc((s) => s.visor);
  const s = useArc((x) => x.state);
  const role = useArc((x) => x.role);
  const conn = useArc((x) => x.conn.status);
  const tone = (ok: boolean, warn = false): DotTone => (ok ? "ok" : warn ? "warn" : "bad");
  const desktop = role === "PC" ? true : Boolean(s?.devices.PC.connected);
  return (
    <section className="vpanel">
      <header>SYSTEM STATUS</header>
      <Row label="FACE" value={v.face} tone={tone(v.face === "TRACKING", v.face === "SCANNING")} />
      <Row label="GAZE" value={v.gaze} tone={tone(v.gaze === "ACTIVE", v.gaze === "LOW" || v.gaze === "CALIBRATING" || v.gaze === "UNCALIBRATED")} />
      <Row label="HANDS" value={v.hands} tone={tone(v.hands === "TRACKING", v.hands === "STANDBY" || v.hands === "LOST")} />
      <Row label="JARVIS" value={conn === "online" ? (s?.jarvis.activity === "IDLE" ? "ONLINE" : s?.jarvis.activity ?? "ONLINE") : "OFFLINE"} tone={tone(conn === "online")} />
      <Row label="GROQ" value={s?.services.ai.status ?? "—"} tone={tone(s?.services.ai.status === "ONLINE", s?.services.ai.status === "DEGRADED")} />
      <Row label="DESKTOP" value={desktop ? "CONNECTED" : "OFFLINE"} tone={tone(desktop)} />
      <Row label="CAMERA" value="FRONT" tone="ok" />
    </section>
  );
}

function ModelsPanel() {
  return (
    <section className="vpanel">
      <header>3D MODELS</header>
      <div className="vlist">
        {MODELS.map((m) => (
          <button
            key={m.id}
            className="vlist__item"
            data-gaze-type="3D MODEL"
            data-gaze-label={m.name.toUpperCase()}
            onClick={() => {
              send({ action: "SPAWN_OBJECT", object: m.id });
            }}
          >
            <ObjectGlyph kind={m.id} size={20} />
            <span>{m.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ContextPanel() {
  const v = useArc((s) => s.visor);
  const pending = useArc((s) => s.state?.pending);
  const speaking = useArc((s) => s.local.speaking);
  const activity = useArc((s) => s.state?.jarvis.activity);
  let kicker = "SYSTEM MODE";
  let title = "READY";
  let sub = "Look to target · pinch to act";
  if (pending) {
    kicker = "AWAITING CONFIRMATION";
    title = pending.title.replace(/\?$/, "").toUpperCase();
    sub = "Look at YES · pinch";
  } else if (v.target) {
    kicker = v.target.phase === "locked" ? "TARGET LOCKED" : v.target.phase === "confirmed" ? "ACTION CONFIRMED" : "TARGET ACQUIRED";
    title = v.target.label;
    sub = v.target.type;
  } else if (speaking || activity === "SPEAKING") {
    kicker = "JARVIS";
    title = "RESPONDING";
    sub = "";
  } else if (activity === "THINKING") {
    kicker = "JARVIS";
    title = "ANALYZING";
    sub = "";
  }
  return (
    <section className={`vpanel vcontext ${v.target ? `is-${v.target.phase}` : ""}`}>
      <header>CONTEXT</header>
      <div className="vcontext__kicker">{kicker}</div>
      <div className="vcontext__title">{title}</div>
      {sub && <div className="vcontext__sub">{sub}</div>}
    </section>
  );
}

function AppsPanel() {
  return (
    <section className="vpanel">
      <header>APPLICATIONS</header>
      <div className="vapps">
        {APPS.map((a) => (
          <button key={a.target} className="vapp" data-gaze-type="APPLICATION" data-gaze-label={a.target.toUpperCase()} onClick={() => send({ action: "OPEN_APPLICATION", target: a.target })}>
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              {a.glyph}
            </svg>
            <span>{a.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** JARVIS response near the chin; minimizes when the reply is done. */
function JarvisPanel() {
  const response = useArc((s) => s.response);
  const activity = useArc((s) => s.state?.jarvis.activity ?? "IDLE");
  const speaking = useArc((s) => s.local.speaking);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!response) return;
    setOpen(true);
    const id = setTimeout(() => setOpen(false), Math.max(5000, response.text.length * 70));
    return () => clearTimeout(id);
  }, [response]);
  const expanded = open || speaking || activity === "THINKING";
  return (
    <section className={`vjarvis ${expanded ? "is-open" : ""}`}>
      <JarvisOrb activity={activity} size={40} />
      <div className="vjarvis__body">
        <header>
          JARVIS <i className="dot dot--ok" />
          <span>{activity === "IDLE" ? "ONLINE" : activity}</span>
        </header>
        {expanded && <div className="vjarvis__text">{activity === "THINKING" ? "…" : response?.text}</div>}
      </div>
      <Waveform source={level} bars={24} className="vjarvis__wave" />
    </section>
  );
}

/** ARC VISOR — the facial HUD. An overlay above the (still mounted) device app. */
export function VisorView() {
  const root = useRef<HTMLDivElement>(null);
  const v = useArc((s) => s.visor);
  const [settings, setSettings] = useState(false);
  const setMode = (mode: "COMMAND" | "PLAYGROUND") => send({ action: "SET_MODE", mode });

  return (
    <div className="visor" ref={root}>
      <CameraPreview className="visor__feed" />
      <FaceHud rootRef={root} />
      <div className="visor__frame" />

      <header className="visor__top">
        <ArcLogo compact />
        <span className="visor__tag">ARC // VISOR</span>
        <nav className="visor__modes">
          <button data-gaze-type="MODE" onClick={() => setMode("COMMAND")}>COMMAND</button>
          <button data-gaze-type="MODE" onClick={() => setMode("PLAYGROUND")}>PLAYGROUND</button>
          <button className="is-active" data-gaze-type="MODE" onClick={() => send({ action: "EXIT_VISOR" })} data-gaze-label="EXIT VISOR">
            VISOR
          </button>
        </nav>
        <Clock />
      </header>

      <aside className="visor__side visor__side--left">
        <StatusPanel />
        <ModelsPanel />
      </aside>
      <aside className="visor__side visor__side--right">
        <ContextPanel />
        <AppsPanel />
      </aside>

      {v.message && v.phase === "tracking" && <div className="visor__message">{v.message}</div>}

      <div className="visor__center">
        <ConfirmPanel large hint="Look at your choice · pinch to select · open palm to cancel" />
        <LatestExecution />
      </div>

      <footer className="visor__bottom">
        <JarvisPanel />
        <div className="visor__controls">
          <CommandBar placeholder="Say “JARVIS…”" />
          <button className="btn btn--small visor__gaze-btn" data-gaze-label="GAZE SETTINGS" aria-label="Gaze settings" onClick={() => setSettings((x) => !x)}>
            <Icon.Settings width={14} height={14} />
            <span>GAZE</span>
          </button>
          <button className="btn btn--small btn--deny" data-gaze-label="EXIT VISOR" onClick={() => send({ action: "EXIT_VISOR" })}>
            EXIT<span className="visor__exit-word"> VISOR</span>
          </button>
        </div>
      </footer>

      {settings && <VisorSettings onClose={() => setSettings(false)} />}
      <VisorBoot />
      <VisorCalibration />
    </div>
  );
}

/** PC Playground with the gaze cursor carried over from VISOR. */
export function GazePlaygroundLayer() {
  const v = useArc((s) => s.visor);
  return (
    <>
      <div className="gaze-chip">
        <span>
          GAZE <i className={`dot dot--${v.gaze === "ACTIVE" ? "ok" : v.gaze === "LOW" || v.gaze === "CALIBRATING" ? "warn" : "bad"}`} />
          {v.gaze}
        </span>
        <span className="gaze-chip__target">{v.target ? `${v.target.phase === "locked" ? "LOCKED" : "TARGET"} · ${v.target.label}` : v.message ?? "LOOK TO TARGET · PINCH TO SELECT"}</span>
        <button className="btn btn--small" onClick={() => send({ action: "RECALIBRATE_GAZE" })}>
          RECALIBRATE
        </button>
        <button className="btn btn--small" onClick={() => send({ action: "SET_GAZE", enabled: false })}>
          GAZE OFF
        </button>
      </div>
      <VisorCalibration />
    </>
  );
}

/** Shown on the other device while VISOR runs elsewhere. */
export function VisorRemoteBanner() {
  const device = useArc((s) => s.state?.visor.device);
  const status = useArc((s) => s.state?.visor.status);
  return (
    <div className="visor-remote">
      <span>
        ARC VISOR ACTIVE ON {device} · FACE {status?.face} · GAZE {status?.gaze}
        {status?.target ? ` · TARGET ${status.target}` : ""}
      </span>
      <button className="btn btn--small btn--deny" onClick={() => send({ action: "EXIT_VISOR" })}>
        EXIT VISOR
      </button>
    </div>
  );
}
