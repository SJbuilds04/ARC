import { useEffect, useState, type ReactNode } from "react";
import { useArc } from "../../core/store";
import { arc, voiceIn, voiceOut } from "../../core/services";
import type { ArcAction } from "@shared/types";
import { Clock, Waveform } from "../primitives";
import { Icon, ObjectGlyph } from "../Icons";
import { CommandBar, ConfirmPanel, LatestExecution } from "../command";
import { FaceVisor } from "./FaceVisor";
import { VisorBoot, VisorCalibration, VisorSettings } from "./VisorOverlays";

const send = (action: ArcAction) => arc.send({ type: "ACTION_REQUEST", action });

const MODELS = [
  { id: "earth", name: "Earth" },
  { id: "mars", name: "Mars" },
  { id: "moon", name: "Moon" },
  { id: "saturn", name: "Saturn" },
  { id: "solar_system", name: "Solar Sys" },
  { id: "heart", name: "Heart" },
  { id: "brain", name: "Brain" },
  { id: "car", name: "Car" },
  { id: "engine", name: "V8" },
];

const APPS: { target: string; label: string; glyph: ReactNode }[] = [
  { target: "Visual Studio Code", label: "VS Code", glyph: <path d="M16 3 7 11l-3-2-2 1v4l2 1 3-2 9 8 4-2V5zM16 8v8l-5-4z" /> },
  { target: "Google Chrome", label: "Chrome", glyph: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" /><path d="M12 8.5h8.5M8.9 13.8 4.6 6.4M15 13.8l-4.3 7.4" /></> },
  { target: "File Explorer", label: "Files", glyph: <path d="M3 6h7l2 2h9v11H3z" /> },
  { target: "Spotify", label: "Spotify", glyph: <><circle cx="12" cy="12" r="9" /><path d="M7 9.5c3.5-1 7-.6 10 1M7.8 12.6c2.8-.7 5.6-.4 8 .9M8.6 15.5c2-.5 4.1-.3 6 .7" /></> },
  { target: "Calculator", label: "Calc", glyph: <><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M8 7h8M8 11h2M12 11h2M8 15h2M12 15h2M8 18h2M12 18h4" /></> },
  { target: "Settings", label: "Settings", glyph: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></> },
];

const freq = new Uint8Array(128);
const spectrum = () => {
  if (useArc.getState().local.speaking && voiceOut.analyser) {
    voiceOut.analyser.getByteFrequencyData(freq);
    return freq;
  }
  return voiceIn.level;
};

/** Original holographic body figure; arms glow amber while hands are tracked. */
function Hologram({ tracked }: { tracked: boolean }) {
  return (
    <svg className={`vholo ${tracked ? "is-tracked" : ""}`} viewBox="0 0 120 230" aria-hidden>
      <g className="vholo__body">
        <circle cx="60" cy="20" r="13" />
        <path d="M54 33h12l2 8H52z" />
        <path d="M40 42h40l6 10-4 42-8 18H46l-8-18-4-42z" />
        <path d="M46 52h28M44 66h32M45 80h30M60 42v70" className="vholo__grid" />
        <path d="M48 112h24l4 18-6 4H50l-6-4z" />
        <path d="M50 134l-4 44 2 40h10l2-42 0-42M70 134l4 44-2 40H62" />
        <path d="M48 160h12M62 160h12M47 190h12M62 190h12" className="vholo__grid" />
      </g>
      <g className="vholo__arms">
        <path d="M38 46l-12 8-6 34 2 34 8 2 4-32 8-26" />
        <path d="M82 46l12 8 6 34-2 34-8 2-4-32-8-26" />
        <path d="M18 122l-2 14 6 6 8-4 0-14M102 122l2 14-6 6-8-4 0-14" />
      </g>
      <rect className="vholo__scan" x="0" y="0" width="120" height="6" />
    </svg>
  );
}

function LeftGlass() {
  const v = useArc((s) => s.visor);
  const s = useArc((x) => x.state);
  const t = useArc((x) => x.telemetry);
  const conn = useArc((x) => x.conn);
  const perf = useArc((x) => x.local.perf);
  const role = useArc((x) => x.role);
  const desktop = role === "PC" || Boolean(s?.devices.PC.connected);
  const rows: [string, string, boolean][] = [
    ["FACE", v.face, v.face === "TRACKING"],
    ["HANDS", v.hands, v.hands === "TRACKING"],
    ["JARVIS", conn.status === "online" ? (s?.jarvis.activity === "IDLE" ? "ONLINE" : s?.jarvis.activity ?? "ONLINE") : "OFFLINE", conn.status === "online"],
    ["GROQ", s?.services.ai.status ?? "—", s?.services.ai.status === "ONLINE"],
    ["DESKTOP", desktop ? "LINKED" : "OFFLINE", desktop],
  ];
  return (
    <aside className="vglass vglass--left">
      <div className="vglass__inner">
        <header className="vglass__head">ARC // SYSTEMS</header>
        <div className="vglass__split">
          <Hologram tracked={v.hands === "TRACKING"} />
          <div className="vglass__readouts">
            <div className="vread">
              <span>PC CPU</span>
              <b>{t?.cpu ?? "—"}</b>
              <i>%</i>
            </div>
            <div className="vread">
              <span>MEMORY</span>
              <b>{t?.memory ?? "—"}</b>
              <i>%</i>
            </div>
            <div className="vread">
              <span>LATENCY</span>
              <b>{conn.latencyMs ?? "—"}</b>
              <i>ms</i>
            </div>
            <div className="vread">
              <span>VISION</span>
              <b>{perf?.face ?? "—"}</b>
              <i>fps</i>
            </div>
          </div>
        </div>
        <div className="vglass__rows">
          {rows.map(([k, val, ok]) => (
            <div key={k} className="vrow2">
              <span>{k}</span>
              <b className={ok ? "is-ok" : "is-warn"}>{val}</b>
            </div>
          ))}
        </div>
        {perf && (
          <div className="vperf" title="Camera / AI performance on this device">
            CAM {perf.camera} · HANDS {perf.hands} ({perf.handsWhere}) · FACE {perf.face} ({perf.faceWhere})
          </div>
        )}
      </div>
    </aside>
  );
}

function useContext() {
  const v = useArc((s) => s.visor);
  const pending = useArc((s) => s.state?.pending);
  const speaking = useArc((s) => s.local.speaking);
  const activity = useArc((s) => s.state?.jarvis.activity);
  if (pending) return { kicker: "AWAITING CONFIRMATION", title: pending.title.replace(/\?$/, "").toUpperCase() };
  if (v.target) return { kicker: v.target.phase === "locked" ? "TARGET LOCKED" : "TARGET ACQUIRED", title: v.target.label };
  if (speaking || activity === "SPEAKING") return { kicker: "JARVIS", title: "RESPONDING" };
  if (activity === "THINKING") return { kicker: "JARVIS", title: "ANALYZING" };
  return { kicker: "SYSTEM MODE", title: "READY" };
}

function RightGlass() {
  const [tab, setTab] = useState<"apps" | "models">("apps");
  const ctx = useContext();
  return (
    <aside className="vglass vglass--right">
      <div className="vglass__inner">
        <header className="vglass__head">
          {ctx.kicker}
          <b>{ctx.title}</b>
        </header>
        <Waveform source={spectrum} bars={40} className="vspectrum" />
        <div className="vtabs">
          <button className={tab === "apps" ? "is-active" : ""} onClick={() => setTab("apps")}>
            APPS
          </button>
          <button className={tab === "models" ? "is-active" : ""} onClick={() => setTab("models")}>
            3D MODELS
          </button>
        </div>
        <div className="vtiles">
          {tab === "apps"
            ? APPS.map((a) => (
                <button key={a.target} className="vtile2" onClick={() => send({ action: "OPEN_APPLICATION", target: a.target })}>
                  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    {a.glyph}
                  </svg>
                  <span>{a.label}</span>
                </button>
              ))
            : MODELS.map((m) => (
                <button key={m.id} className="vtile2" onClick={() => send({ action: "SPAWN_OBJECT", object: m.id })}>
                  <ObjectGlyph kind={m.id} size={22} />
                  <span>{m.name}</span>
                </button>
              ))}
        </div>
      </div>
    </aside>
  );
}

/** JARVIS reply as a helmet subtitle; fades out when done. */
function Subtitle() {
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
  const show = open || speaking || activity === "THINKING";
  return (
    <div className={`vsub ${show ? "is-on" : ""}`}>
      <span className="vsub__who">JARVIS</span>
      <span className="vsub__text">{activity === "THINKING" ? "…" : response?.text ?? ""}</span>
    </div>
  );
}

/** ARC VISOR — helmet HUD. An overlay above the (still mounted) device app. */
export function VisorView() {
  const v = useArc((s) => s.visor);
  const [settings, setSettings] = useState(false);
  const setMode = (mode: "COMMAND" | "PLAYGROUND") => send({ action: "SET_MODE", mode });

  return (
    <div className="visor">
      <div className="visor__bg" />
      <FaceVisor />
      <div className="visor__helmet">
        <svg className="visor__rim" viewBox="0 0 1000 120" preserveAspectRatio="none" aria-hidden>
          <path d="M0 120 C 180 40, 820 40, 1000 120" className="rim-glow" />
          <path d="M0 120 C 180 40, 820 40, 1000 120" className="rim-line" />
          <path d="M120 92 C 300 54, 700 54, 880 92" className="rim-inner" />
        </svg>
        <i className="flare flare--l" />
        <i className="flare flare--r" />
      </div>

      <header className="visor__top">
        <span className="visor__tag">ARC // VISOR</span>
        <nav className="visor__modes">
          <button onClick={() => setMode("COMMAND")}>COMMAND</button>
          <button onClick={() => setMode("PLAYGROUND")}>PLAYGROUND</button>
          <button className="is-active" onClick={() => send({ action: "EXIT_VISOR" })}>
            EXIT VISOR
          </button>
        </nav>
        <Clock />
      </header>

      <LeftGlass />
      <RightGlass />

      {v.message && v.phase === "tracking" && <div className="visor__message">{v.message}</div>}

      <div className="visor__decision">
        <ConfirmPanel large hint="Point at your choice · pinch to select" />
        <LatestExecution />
      </div>

      <footer className="visor__bottom">
        <Subtitle />
        <div className="visor__controls">
          <CommandBar placeholder="Say “JARVIS…”" />
          <button className="btn btn--small visor__gaze-btn" aria-label="Visor settings" onClick={() => setSettings((x) => !x)}>
            <Icon.Settings width={14} height={14} />
          </button>
        </div>
      </footer>

      {settings && <VisorSettings onClose={() => setSettings(false)} />}
      <VisorBoot />
      <VisorCalibration />
    </div>
  );
}

/** PC Playground with the gaze cursor carried over from VISOR (only when the gaze cursor is enabled). */
export function GazePlaygroundLayer() {
  const v = useArc((s) => s.visor);
  if (!v.settings.gazeEnabled) return null;
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
        ARC VISOR ACTIVE ON {device} · FACE {status?.face} · HANDS {status?.hands}
      </span>
      <button className="btn btn--small btn--deny" onClick={() => send({ action: "EXIT_VISOR" })}>
        EXIT VISOR
      </button>
    </div>
  );
}
