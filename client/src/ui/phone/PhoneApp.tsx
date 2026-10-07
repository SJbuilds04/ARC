import { useEffect, useState, type ReactElement } from "react";
import { useArc } from "../../core/store";
import { prefs, savePref } from "../../core/device";
import { engage, voiceIn, voiceOut } from "../../core/services";
import { ArcLogo, JarvisOrb, Panel, Waveform } from "../primitives";
import { Icon } from "../Icons";
import { CommandBar, ConfirmPanel, LatestExecution, ResponseBubble } from "../command";
import { CameraPreview } from "../vision";
import { RemoteTab } from "./RemoteTab";
import { LibraryTab } from "./LibraryTab";
import { SettingsTab, VisorTab } from "./MoreTabs";

export type PhoneTab = "command" | "remote" | "library" | "visor" | "settings";

const TABS: { id: PhoneTab; label: string; icon: (p: { width: number; height: number }) => ReactElement }[] = [
  { id: "command", label: "Command", icon: Icon.Command },
  { id: "remote", label: "Remote", icon: Icon.Remote },
  { id: "library", label: "Library", icon: Icon.Library },
  { id: "visor", label: "Visor", icon: Icon.Eye },
  { id: "settings", label: "Settings", icon: Icon.Settings },
];

const freq = new Uint8Array(128);
const level = () => {
  if (useArc.getState().local.speaking && voiceOut.analyser) {
    voiceOut.analyser.getByteFrequencyData(freq);
    return freq;
  }
  return voiceIn.level;
};

/** What the PC is doing right now, in a few words. */
export function usePcStatus(): { online: boolean; line: string; detail: string | null } {
  const s = useArc((x) => x.state);
  if (!s || !s.devices.PC.connected) return { online: false, line: "PC OFFLINE", detail: "Open ARC on the PC (https://localhost:7777)" };
  const dd = s.deepDive;
  const space = s.spaces.PC;
  const exec = s.executions[0];
  const running = exec && ["ANALYZING", "AUTHORIZED", "EXECUTING", "AWAITING_CONFIRMATION"].includes(exec.stage) ? `${exec.title} · ${exec.stage.replace("_", " ")}` : null;
  if (space === "PLAYGROUND" && dd.active)
    return { online: true, line: dd.modelId ? `DEEP DIVE · ${dd.modelName?.toUpperCase() ?? ""}` : "DEEP DIVE · PICKING A MODEL", detail: running ?? (dd.modelId ? `AR ${dd.settings.ar ? "ON" : "OFF"} · ${dd.settings.style.toUpperCase()}` : null) };
  if (space === "PLAYGROUND") return { online: true, line: "PLAYGROUND", detail: running ?? `${s.scene.objects.length} object${s.scene.objects.length === 1 ? "" : "s"} in the scene` };
  if (space === "VISOR") return { online: true, line: "VISOR ON PC", detail: running };
  return { online: true, line: "COMMAND CONSOLE", detail: running };
}

function CommandTab({ go }: { go: (t: PhoneTab) => void }) {
  const s = useArc((x) => x.state);
  const local = useArc((x) => x.local);
  const pc = usePcStatus();
  const listeningHere = s?.voiceInput === "PHONE" && local.handsFree;
  return (
    <div className="ph-stack">
      <Panel className="ph-jarvis">
        <JarvisOrb activity={s?.jarvis.activity ?? "IDLE"} size={58} />
        <div className="ph-jarvis__meta">
          <div className="ph-jarvis__name">
            JARVIS <i className="dot dot--ok" /> <span>{s?.jarvis.activity === "IDLE" || !s ? "ONLINE" : s.jarvis.activity}</span>
          </div>
          <Waveform source={level} bars={28} className="ph-jarvis__wave" />
          <div className="ph-jarvis__hint">{local.mic === "error" ? local.micError : listeningHere ? "Listening · say “JARVIS…”" : local.handsFree ? "Hands-free is on" : "Tap the mic to talk"}</div>
        </div>
      </Panel>

      <button className={`ph-pc ${pc.online ? "" : "is-off"}`} onClick={() => go("remote")}>
        <Icon.Cpu width={20} height={20} />
        <div className="ph-pc__text">
          <span className="ph-pc__kicker">YOUR PC</span>
          <b>{pc.line}</b>
          {pc.detail && <span className="ph-pc__detail">{pc.detail}</span>}
        </div>
        <Icon.Chevron width={18} height={18} />
      </button>

      <ConfirmPanel large />
      <ResponseBubble />
      <LatestExecution />
    </div>
  );
}

export function PhoneApp() {
  const engaged = useArc((x) => x.engaged);
  const camera = useArc((x) => x.local.camera);
  const showFeed = useArc((x) => x.local.showFeed);
  const space = useArc((x) => x.state?.spaces.PHONE ?? "COMMAND");
  const pending = useArc((x) => x.state?.pending ?? null);
  const role = useArc((x) => x.role);
  const [tab, setTabState] = useState<PhoneTab>(() => {
    const saved = prefs<PhoneTab>("phoneTab", "command");
    return TABS.some((t) => t.id === saved) ? saved : "command";
  });
  const setTab = (t: PhoneTab) => {
    setTabState(t);
    savePref("phoneTab", t);
  };
  // A confirmation asked from this phone pulls you to the Command tab so it can't be missed.
  useEffect(() => {
    if (pending && pending.device === role && tab !== "command") setTab("command");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.id]);

  return (
    <div className={`ph ${space === "VISOR" ? "is-visor" : ""}`}>
      {camera === "on" && showFeed && <CameraPreview className="ph__feed" />}
      <header className="ph__top">
        <ArcLogo compact />
        <PcPill onClick={() => setTab("remote")} />
      </header>

      <main className="ph__body" key={tab}>
        {tab === "command" && <CommandTab go={setTab} />}
        {tab === "remote" && <RemoteTab go={setTab} />}
        {tab === "library" && <LibraryTab />}
        {tab === "visor" && <VisorTab />}
        {tab === "settings" && <SettingsTab />}
      </main>

      {tab === "command" && (
        <div className="ph__dock">
          <CommandBar placeholder="Type a command" />
        </div>
      )}

      <nav className="ph__tabs" aria-label="ARC sections">
        {TABS.map((t) => (
          <button key={t.id} className={`ph__tab ${tab === t.id ? "is-on" : ""}`} onClick={() => setTab(t.id)} aria-current={tab === t.id ? "page" : undefined}>
            <t.icon width={22} height={22} />
            <span>{t.label}</span>
          </button>
        ))}
      </nav>

      {!engaged && (
        <div className="engage" onClick={() => void engage()}>
          <button className="engage__btn">
            <Icon.Mic width={28} height={28} />
            <span>ENGAGE ARC</span>
          </button>
          <p>Tap once so JARVIS can speak here and hear you.</p>
        </div>
      )}
    </div>
  );
}

function PcPill({ onClick }: { onClick: () => void }) {
  const pc = usePcStatus();
  return (
    <button className="ph-pill" onClick={onClick}>
      <i className={`dot dot--${pc.online ? "ok" : "bad"}`} />
      <span>{pc.online ? `PC · ${pc.line}` : "PC OFFLINE"}</span>
    </button>
  );
}
