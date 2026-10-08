import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { useArc } from "../../core/store";
import { arc, playground, voiceOut, voiceIn } from "../../core/services";
import { ArcLogo, Clock, JarvisOrb, Panel, Waveform } from "../primitives";
import { Icon } from "../Icons";
import { CommandBar, ConfirmPanel, LatestExecution, ResponseBubble } from "../command";
import { StatusHud } from "../vision";
import { PlaygroundOverlay } from "./PlaygroundOverlay";
import { DevicesPanel, HistoryPanel, PairingCard, SystemPanel } from "./panels";
import { ThemeToggle } from "../theme";

const freq = new Uint8Array(128);
const jarvisLevel = () => {
  if (useArc.getState().local.speaking && voiceOut.analyser) {
    voiceOut.analyser.getByteFrequencyData(freq);
    return freq;
  }
  return voiceIn.level * 0.5;
};

function NavItem({ icon, label, active, onClick }: { icon: ReactNode; label: string; active?: boolean; onClick: () => void }) {
  return (
    <button className={`nav-item ${active ? "is-active" : ""}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function TopBar() {
  const s = useArc((x) => x.state);
  if (!s) return null;
  const src = s.vision.activeSource;
  const vs = s.vision.sources[src];
  return (
    <header className="topbar">
      <ArcLogo />
      <div className="topbar__tag">
        JARVIS <span>//</span> YOUR AI ASSISTANT
        <br />
        ALWAYS ON <span>//</span> ALWAYS WITH YOU
      </div>
      <div className="topbar__pills">
        <div className="pill-box">
          <JarvisOrb activity={s.jarvis.activity} size={34} />
          <span>JARVIS</span>
          <i className="dot dot--ok" />
          <span className="pill-box__val">{s.jarvis.activity === "IDLE" ? "ONLINE" : s.jarvis.activity}</span>
          <Waveform source={jarvisLevel} bars={22} className="pill-box__wave" />
        </div>
        <div className="pill-box">
          <span>{src} CAMERA</span>
          <i className={`dot dot--${vs.status === "ACTIVE" ? "ok" : vs.status === "ERROR" ? "bad" : vs.status === "STARTING" ? "warn" : "off"}`} />
          <span className="pill-box__val">{vs.status}</span>
        </div>
        <ThemeToggle />
      </div>
      <Clock withDate />
    </header>
  );
}

function Console() {
  const panel = useArc((s) => s.desktopPanel);
  const activity = useArc((s) => s.state?.jarvis.activity ?? "IDLE");
  const phoneConnected = useArc((s) => s.state?.devices.PHONE.connected);
  const primary = useArc((s) => s.state?.primaryDevice);
  return (
    <div className="console">
      <div className="console__center">
        <JarvisOrb activity={activity} size={190} />
        <div className="console__role">{primary === "PHONE" ? "PRIMARY INTERFACE · PHONE" : "PRIMARY INTERFACE · DESKTOP"}</div>
        <ResponseBubble />
        <ConfirmPanel large />
        <LatestExecution />
      </div>
      <div className="console__side">
        {panel === "console" && (
          <>
            <Panel title="ARC STATUS">
              <StatusHud />
            </Panel>
            {!phoneConnected && <PairingCard />}
            <HistoryPanel limit={6} />
          </>
        )}
        {panel === "system" && <SystemPanel />}
        {panel === "devices" && <DevicesPanel />}
        {panel === "history" && <HistoryPanel />}
      </div>
    </div>
  );
}

export function DesktopApp() {
  const mode = useArc((s) => s.state?.spaces.PC ?? "COMMAND");
  const panel = useArc((s) => s.desktopPanel);
  const diving = useArc((s) => Boolean(s.state?.deepDive.active) && s.state?.spaces.PC === "PLAYGROUND");
  const stageRef = useRef<HTMLDivElement>(null);

  // The playground canvas is persistent — it is moved into this host, never recreated.
  useEffect(() => {
    if (stageRef.current && playground) playground.mount(stageRef.current);
  }, []);

  const setMode = (m: "COMMAND" | "PLAYGROUND" | "VISOR") => arc.send({ type: "ACTION_REQUEST", action: { action: "SET_MODE", mode: m } });
  const openPanel = (p: "console" | "system" | "devices" | "history") => {
    useArc.setState({ desktopPanel: p });
    if (mode !== "COMMAND") setMode("COMMAND");
  };

  return (
    <div className={`desktop is-${mode.toLowerCase()} ${diving ? "is-diving" : ""}`}>
      <div className="desktop__stage" ref={stageRef} />
      <div className="desktop__backdrop" />
      <TopBar />
      <nav className="desktop__nav arc-ui-block">
        <NavItem icon={<Icon.Command />} label="COMMAND MODE" active={mode === "COMMAND" && panel === "console"} onClick={() => openPanel("console")} />
        <NavItem icon={<Icon.Cube />} label="PLAYGROUND MODE" active={mode === "PLAYGROUND"} onClick={() => setMode("PLAYGROUND")} />
        <NavItem icon={<Icon.Eye />} label="VISOR MODE" active={mode === "VISOR"} onClick={() => setMode("VISOR")} />
        <NavItem icon={<Icon.Cpu />} label="SYSTEM" active={mode === "COMMAND" && panel === "system"} onClick={() => openPanel("system")} />
        <NavItem icon={<Icon.Phone />} label="DEVICES" active={mode === "COMMAND" && panel === "devices"} onClick={() => openPanel("devices")} />
        <NavItem icon={<Icon.History />} label="HISTORY" active={mode === "COMMAND" && panel === "history"} onClick={() => openPanel("history")} />
      </nav>
      <main className="desktop__main">{mode === "PLAYGROUND" ? <PlaygroundOverlay /> : <Console />}</main>
      <footer className="desktop__footer">
        {mode === "PLAYGROUND" && (
          <div className="desktop__floating">
            <ResponseBubble compact />
            <ConfirmPanel />
          </div>
        )}
        <CommandBar />
      </footer>
    </div>
  );
}
