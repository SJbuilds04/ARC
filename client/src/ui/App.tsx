import { useArc } from "../core/store";
import { BootSequence, ConnectionBadge, ConnectionGate, Handoff, Notices } from "./overlays";
import { DesktopApp } from "./desktop/DesktopApp";
import { PhoneApp } from "./phone/PhoneApp";
import { GazePlaygroundLayer, VisorRemoteBanner, VisorView } from "./visor/VisorView";

/**
 * Root. The device app mounts once and stays mounted for the whole session;
 * boot, handoff, notices and connection states are overlays on top of it.
 */
export function App() {
  const role = useArc((s) => s.role);
  const bootDone = useArc((s) => s.bootDone);
  const mode = useArc((s) => s.state?.mode);
  const visorDevice = useArc((s) => s.state?.visor.device);
  const gazeInPlayground = useArc((s) => s.state?.visor.gazeInPlayground);
  const visorHere = mode === "VISOR" && visorDevice === role;
  return (
    <>
      {role === "PC" ? <DesktopApp /> : <PhoneApp />}
      {visorHere && <VisorView />}
      {mode === "VISOR" && !visorHere && <VisorRemoteBanner />}
      {mode === "PLAYGROUND" && role === "PC" && gazeInPlayground && <GazePlaygroundLayer />}
      <Handoff />
      <Notices />
      <ConnectionBadge />
      <ConnectionGate />
      {!bootDone && <BootSequence />}
    </>
  );
}
