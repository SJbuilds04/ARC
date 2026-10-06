import { ArcClient } from "./ArcClient";
import { ROLE } from "./device";
import { useArc, notify, setLocal } from "./store";
import { GestureManager } from "../gestures/GestureManager";
import { HandPointer } from "../gestures/HandPointer";
import { VisionManager } from "../camera/VisionManager";
import { VoiceInput } from "../voice/VoiceInput";
import { VoiceOutput } from "../voice/VoiceOutput";
import { PlaygroundEngine } from "../playground/PlaygroundEngine";
import { PlaygroundInteraction } from "../playground/PlaygroundInteraction";
import { VisorManager } from "../visor/VisorManager";

/**
 * Client services — instantiated exactly once per page load, outside React,
 * and never torn down. UI components come and go; these persist, which is
 * what keeps ARC "running" through mode and camera changes.
 */
export const arc = new ArcClient();
export const gestures = new GestureManager();
export const pointer = new HandPointer(gestures);
export const vision = new VisionManager(ROLE, arc, gestures);
export const voiceIn = new VoiceInput(arc);
export const voiceOut = new VoiceOutput(arc, voiceIn);
export const visor = new VisorManager(ROLE, arc, vision, gestures, pointer);

/** The 3D playground lives on the PC only. */
export const playground: PlaygroundEngine | null = ROLE === "PC" ? new PlaygroundEngine() : null;
let sceneRestored = false;

if (playground) {
  const interaction = new PlaygroundInteraction(playground, gestures, pointer, () => useArc.getState().state?.mode === "PLAYGROUND");
  // VISOR carried into Playground: the eyes pick 3D objects, the hand manipulates them.
  const inPlayground = () => useArc.getState().state?.mode === "PLAYGROUND";
  interaction.gazePoint = () => (visor.isActive && inPlayground() && visor.point ? { x: visor.point.x / innerWidth, y: visor.point.y / innerHeight } : null);
  visor.targeting.sceneProbe = (x, y) => {
    if (!inPlayground()) return null;
    const obj = playground.pick(x / innerWidth, y / innerHeight);
    playground.objects.setHovered(obj);
    return obj ? { id: obj.id, label: obj.name.toUpperCase(), ...playground.screenCircle(obj) } : null;
  };
  playground.objects.on("change", (scene) => arc.send({ type: "SCENE_STATE", scene }));
  playground.objects.on("location", (location) => useArc.setState({ location }));
  playground.objects.on("message", ({ level, text }) => notify({ level, title: "PLAYGROUND", text }, 3500));
  playground.onFps = (fps) => setLocal({ renderFps: fps });

  arc.on("PLAYGROUND_COMMAND", ({ command }) => {
    if (command.action === "RESET_VIEW") playground.resetView();
    else void playground.objects.apply(command);
  });
  arc.on("WELCOME", ({ state }) => {
    // Rebuild the persisted scene once (e.g. after the PC tab was reopened).
    if (!sceneRestored) {
      sceneRestored = true;
      playground.objects.restore(state.scene);
    }
  });
  useArc.subscribe((s, prev) => {
    if (s.state?.mode !== prev.state?.mode) playground.setActive(s.state?.mode === "PLAYGROUND");
  });
}

// ─── Server events → UI state ───

arc.on("JARVIS_RESPONSE", (m) => useArc.setState({ response: { id: m.id, text: m.text, attachments: m.attachments, primary: m.primary, at: Date.now() } }));
arc.on("TRANSCRIPT", (m) => useArc.setState({ transcript: { text: m.text, accepted: m.accepted, at: Date.now() } }));
arc.on("PAIRING_INFO", (m) => useArc.setState({ pairing: { url: m.url, qrSvg: m.qrSvg, addresses: m.addresses, expiresAt: m.expiresAt, devices: m.devices } }));
arc.on("TELEMETRY", (m) => useArc.setState({ telemetry: { cpu: m.cpu, memory: m.memory, uptime: m.uptime } }));
arc.on("NOTIFY", (m) => notify({ level: m.level, title: m.title, text: m.text, code: m.code }, m.code === "VISION_LOST" ? 0 : 6000));
arc.on("CONFIRM_RESOLVED", (m) => {
  useArc.setState({ confirmFlash: { id: m.id, approved: m.approved } });
  setTimeout(() => useArc.setState((s) => (s.confirmFlash?.id === m.id ? { confirmFlash: null } : {})), 1400);
});

let transitionKey = 0;
arc.on("MODE_TRANSITION", (m) =>
  useArc.setState({ transition: { kind: "mode", from: m.from, to: m.to, visionFrom: m.visionFrom, visionTo: m.visionTo, key: ++transitionKey } }),
);
// Only manual camera switches emit this (mode changes carry their own handoff above).
arc.on("CAMERA_SWITCH", (m) => useArc.setState({ transition: { kind: "camera", visionFrom: m.from, visionTo: m.to, key: ++transitionKey } }));

// The PC keeps a fresh pairing QR while no phone is connected.
if (ROLE === "PC") {
  arc.on("open", () => arc.send({ type: "REQUEST_PAIRING" }));
  setInterval(() => arc.online && arc.send({ type: "REQUEST_PAIRING" }), 5 * 60_000);
  useArc.subscribe((s, prev) => {
    if (s.state && prev.state && s.state.devices.PHONE.connected !== prev.state.devices.PHONE.connected) arc.send({ type: "REQUEST_PAIRING" });
  });
}

// ─── Gesture-level shortcuts ───

gestures.on("palmhold", () => {
  const { state, local } = useArc.getState();
  if (state?.pending) arc.send({ type: "CONFIRM_RESPONSE", id: state.pending.id, approved: false, via: "gesture" });
  else if (local.speaking) {
    voiceOut.stop();
    arc.send({ type: "CANCEL" });
  }
});
gestures.on("pose", ({ pose }) => setLocal({ gesture: pose }));
gestures.on("lost", () => setLocal({ gesture: "NONE" }));

/** First user tap: unlock audio output and the microphone (mobile browsers require a gesture). */
export async function engage(): Promise<void> {
  voiceOut.unlock();
  useArc.setState({ engaged: true }); // dismiss immediately; the mic prompt may take a while
  await voiceIn.enable();
}

arc.start();
void vision.preload().catch(() => undefined);

// Test hook (only with ?debug=1): lets automated UI tests inject hand frames.
if (new URLSearchParams(location.search).has("debug")) {
  (window as unknown as { __arc: unknown }).__arc = { gestures, visor, playground, arc };
}
