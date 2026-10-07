import { useEffect } from "react";
import { useArc } from "../core/store";
import { BootSequence, ConnectionBadge, ConnectionGate, Handoff, Notices } from "./overlays";
import { DesktopApp } from "./desktop/DesktopApp";
import { PhoneApp } from "./phone/PhoneApp";
import { GazePlaygroundLayer, VisorView } from "./visor/VisorView";

/**
 * Root. The device app mounts once and stays mounted for the whole session;
 * boot, handoff, notices and connection states are overlays on top of it.
 */
export function App() {
  const role = useArc((s) => s.role);
  const bootDone = useArc((s) => s.bootDone);
  const space = useArc((s) => s.state?.spaces[s.role]);
  const gazeInPlayground = useArc((s) => Boolean(s.state?.visor.gazeInPlayground && s.visor.settings.gazeEnabled));
  const visorHere = space === "VISOR";
  // The device app stays mounted under the visor (ARC never restarts) but stops painting.
  useEffect(() => {
    document.body.classList.toggle("visor-open", visorHere);
  }, [visorHere]);
  return (
    <>
      {role === "PC" ? <DesktopApp /> : <PhoneApp />}
      {visorHere && <VisorView />}
      {role === "PC" && space === "PLAYGROUND" && gazeInPlayground && <GazePlaygroundLayer />}
      <Handoff />
      <Notices />
      <ConnectionBadge />
      <ConnectionGate />
      {!bootDone && <BootSequence />}
    </>
  );
}
