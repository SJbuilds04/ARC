import { useEffect, useState, type ReactNode } from "react";
import { useArc } from "../../core/store";
import { arc } from "../../core/services";
import type { ArcAction } from "@shared/types";
import { Clock } from "../primitives";
import { Icon, ObjectGlyph } from "../Icons";
import { CommandBar, ConfirmPanel, LatestExecution } from "../command";
import { HelmetView } from "./HelmetView";
import { VisorBoot, VisorCalibration, VisorSettings } from "./VisorOverlays";

const send = (action: ArcAction) => arc.send({ type: "ACTION_REQUEST", action });

const MODELS = [
  { id: "earth", name: "Earth" },
  { id: "mars", name: "Mars" },
  { id: "saturn", name: "Saturn" },
  { id: "solar_system", name: "Solar" },
  { id: "heart", name: "Heart" },
  { id: "brain", name: "Brain" },
  { id: "car", name: "Car" },
  { id: "engine", name: "V8" },
  { id: "dna", name: "DNA" },
];

const APPS: { target: string; label: string; glyph: ReactNode }[] = [
  { target: "Visual Studio Code", label: "VS Code", glyph: <path d="M16 3 7 11l-3-2-2 1v4l2 1 3-2 9 8 4-2V5zM16 8v8l-5-4z" /> },
  { target: "Google Chrome", label: "Chrome", glyph: <><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.5" /><path d="M12 8.5h8.5M8.9 13.8 4.6 6.4M15 13.8l-4.3 7.4" /></> },
  { target: "File Explorer", label: "Files", glyph: <path d="M3 6h7l2 2h9v11H3z" /> },
  { target: "Spotify", label: "Spotify", glyph: <><circle cx="12" cy="12" r="9" /><path d="M7 9.5c3.5-1 7-.6 10 1M7.8 12.6c2.8-.7 5.6-.4 8 .9M8.6 15.5c2-.5 4.1-.3 6 .7" /></> },
  { target: "Calculator", label: "Calc", glyph: <><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M8 7h8M8 11h2M12 11h2M8 15h2M12 15h2M8 18h2M12 18h4" /></> },
  { target: "Settings", label: "Settings", glyph: <><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></> },
];

/** Apps / 3D models — a slim curved glass strip on the right of the visor. */
function SidePanel() {
  const [tab, setTab] = useState<"apps" | "models">("apps");
  return (
    <aside className="vpanel">
      <div className="vpanel__tabs">
        <button className={tab === "apps" ? "is-on" : ""} onClick={() => setTab("apps")}>
          APPS
        </button>
        <button className={tab === "models" ? "is-on" : ""} onClick={() => setTab("models")}>
          3D MODELS
        </button>
      </div>
      <div className="vpanel__grid">
        {tab === "apps"
          ? APPS.map((a) => (
              <button key={a.target} className="vtile" aria-label={a.label} onClick={() => send({ action: "OPEN_APPLICATION", target: a.target })}>
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  {a.glyph}
                </svg>
                <span>{a.label}</span>
              </button>
            ))
          : MODELS.map((m) => (
              <button key={m.id} className="vtile" aria-label={m.name} onClick={() => send({ action: "SPAWN_OBJECT", object: m.id })}>
                <ObjectGlyph kind={m.id} size={20} />
                <span>{m.name}</span>
              </button>
            ))}
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
      <span className="vsub__text">{activity === "THINKING" ? "…" : response?.text ?? ""}</span>
    </div>
  );
}

/** ARC VISOR — inside the helmet. An overlay above the (still mounted) device app. */
export function VisorView() {
  // The phone visor is touch-only unless phone hand tracking is switched on.
  const touchOnly = useArc((x) => x.role === "PHONE" && !x.state?.vision.phoneHands);
  const v = useArc((s) => s.visor);
  const [settings, setSettings] = useState(false);
  const setMode = (mode: "COMMAND" | "PLAYGROUND") => send({ action: "SET_MODE", mode });

  return (
    <div className="visor">
      <HelmetView />

      <header className="visor__top">
        <span className="visor__tag">
          ARC <i>//</i> VISOR
        </span>
        <div className="visor__right">
          <nav className="visor__modes">
            <button aria-label="Command" onClick={() => setMode("COMMAND")}>
              COMMAND
            </button>
            <button aria-label="Playground" onClick={() => setMode("PLAYGROUND")}>
              PLAYGROUND
            </button>
            <button className="is-exit" aria-label="Exit visor" onClick={() => send({ action: "EXIT_VISOR" })}>
              <Icon.Close width={12} height={12} /> EXIT
            </button>
          </nav>
          <Clock />
        </div>
      </header>

      <SidePanel />

      {v.message && v.phase === "tracking" && <div className="visor__message">{v.message}</div>}

      <div className="visor__decision">
        <ConfirmPanel large hint={touchOnly ? "Tap your choice · or say “yes” / “no”" : "Point at your choice · pinch to select"} />
        <LatestExecution />
      </div>

      <footer className="visor__bottom">
        <Subtitle />
        <div className="visor__controls">
          <CommandBar placeholder="Say “JARVIS…”" />
          <button className="visor__icon" aria-label="Visor settings" onClick={() => setSettings((x) => !x)}>
            <Icon.Settings width={15} height={15} />
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
