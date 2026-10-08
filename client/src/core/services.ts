import { ArcClient } from "./ArcClient";
import { ROLE } from "./device";
import * as THREE from "three";
import { useArc, notify, setLocal, dismissCode } from "./store";
import { GestureManager } from "../gestures/GestureManager";
import { HandPointer } from "../gestures/HandPointer";
import { VisionManager } from "../camera/VisionManager";
import { VoiceInput } from "../voice/VoiceInput";
import { VoiceOutput } from "../voice/VoiceOutput";
import { PlaygroundEngine } from "../playground/PlaygroundEngine";
import { PlaygroundInteraction } from "../playground/PlaygroundInteraction";
import { VisorManager } from "../visor/VisorManager";
import { DeepDive } from "../playground/DeepDive";
import { loadDeviceToken } from "./device";
import { isLight, onTheme, setTheme, toggleTheme } from "./theme";

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
// the 3D scenes follow the theme too (daylight Playground, blueprint holograms)
playground?.setTheme(isLight());
onTheme((t) => playground?.setTheme(t === "light"));
// "JARVIS, switch to light mode": every screen follows
arc.on("THEME", ({ theme }) => (theme === "toggle" ? toggleTheme() : setTheme(theme)));
export const deepDive: DeepDive | null = playground ? new DeepDive(playground) : null;
let sceneRestored = false;

/** Upload a file to ARC (the phone authenticates with its pairing token). */
export async function uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<{ ok: boolean; error?: string; name?: string; kind?: string }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-Arc-Role", ROLE);
    const token = loadDeviceToken();
    if (token) xhr.setRequestHeader("X-Arc-Token", token);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText));
      } catch {
        resolve({ ok: false, error: `Upload failed (${xhr.status})` });
      }
    };
    xhr.onerror = () => resolve({ ok: false, error: "Upload failed — is the PC reachable?" });
    xhr.send(file);
  });
}

if (playground && deepDive) {
  const inPlayground = () => useArc.getState().state?.spaces.PC === "PLAYGROUND";
  const lookup = (id: string) => useArc.getState().state?.library.find((m) => m.id === id);
  playground.objects.modelLookup = lookup;
  deepDive.lookup = lookup;
  deepDive.thumbs = () => useArc.getState().state?.thumbs ?? {};
  deepDive.onParts = (model, parts, actions) => arc.send({ type: "DEEP_DIVE_PARTS", model, parts, actions });
  deepDive.onAct = (id) => arc.send({ type: "ACTION_REQUEST", action: { action: "MODEL_ACTION", id } });
  deepDive.onSelect = (model) => arc.send({ type: "ACTION_REQUEST", action: { action: "DEEP_DIVE", enabled: true, model } });
  deepDive.onFocus = (part) => arc.send({ type: "ACTION_REQUEST", action: { action: "FOCUS_PART", part } });
  deepDive.onPin = (model, pos, screen) => useArc.setState({ pinPrompt: { model, pos, x: screen.x, y: screen.y } });
  deepDive.onMessage = (text) => notify({ level: "warning", title: "DEEP DIVE", text }, 5000);
  deepDive.onThumb = (id, png) => void fetch(`/api/thumb/${encodeURIComponent(id)}`, { method: "POST", body: png, headers: { "Content-Type": "image/png" } }).catch(() => undefined);
  const syncDeepDive = () => {
    const st = useArc.getState().state;
    if (st) deepDive.sync(st.deepDive, st.spaces.PC === "PLAYGROUND", st.library);
  };
  useArc.subscribe((s, prev) => s.state !== prev.state && syncDeepDive());
  // a model deleted from the library also leaves the Playground
  useArc.subscribe((s, prev) => {
    if (!s.state || !prev.state || s.state.library === prev.state.library) return;
    const ids = new Set(s.state.library.map((m) => m.id));
    for (const o of playground.objects.live()) if (o.kind.startsWith("m-") && !ids.has(o.kind)) playground.objects.remove(o);
  });
  useArc.subscribe((s, prev) => {
    const b = s.state?.settings.brightness;
    if (b !== undefined && b !== prev.state?.settings.brightness) playground.setBrightness(b);
  });
  playground.setBrightness(0.3);

  // Phone as a 3D controller: drag orbits / turns, pinch zooms, tilt steers.
  arc.on("CONTROL", ({ kind, dx, dy }) => {
    if (!inPlayground()) return;
    if (deepDive.active) {
      if (kind === "zoom") deepDive.zoom(Math.exp(dy));
      else if (kind === "end") deepDive.release();
      else if (deepDive.picking) deepDive.grab(dx, 0);
      else deepDive.orbit(dx, dy);
      return;
    }
    const sel = playground.objects.selected;
    if (kind === "zoom") {
      if (sel) sel.target.scale = Math.min(5, Math.max(0.2, sel.target.scale * Math.exp(-dy)));
      else playground.zoomBy(Math.exp(dy));
    } else if (kind === "end") playground.objects.changed();
    else if (sel) sel.target.quaternion.premultiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(dy * 4, dx * 6, 0)));
    else playground.orbitBy(-dx * 3.2, dy * 2);
  });

  // Keyboard in Deep Dive: ← → spin the carousel, Enter picks, Esc leaves.
  window.addEventListener("keydown", (e) => {
    if (!deepDive.active || (e.target as HTMLElement)?.closest?.("input, textarea")) return;
    if (e.key === "ArrowRight") deepDive.step(1);
    else if (e.key === "ArrowLeft") deepDive.step(-1);
    else if (e.key === "Enter") deepDive.selectFront();
    else if (e.key === "Escape") arc.send({ type: "ACTION_REQUEST", action: { action: "DEEP_DIVE", enabled: false } });
  });

  // Drag a model (or any file) onto the PC window to import it.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    for (const file of Array.from(e.dataTransfer?.files ?? [])) {
      notify({ level: "info", title: "IMPORTING", text: file.name, code: `up-${file.name}` }, 0);
      void uploadFile(file).then((r) => {
        dismissCode(`up-${file.name}`);
        if (!r.ok) notify({ level: "error", title: "IMPORT FAILED", text: r.error ?? file.name }, 6000);
      });
    }
  });
}

if (playground) {
  const interaction = new PlaygroundInteraction(playground, gestures, pointer, () => useArc.getState().state?.spaces.PC === "PLAYGROUND", deepDive);
  const inPlayground = () => useArc.getState().state?.spaces.PC === "PLAYGROUND";
  // VISOR carried into Playground: the eyes pick 3D objects, the hand manipulates them.
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
    if (command.action === "CAROUSEL") {
      if (command.command === "select") deepDive?.selectFront();
      else deepDive?.step(command.command === "next" ? 1 : -1);
    } else if (command.action === "RESET_VIEW") playground.resetView();
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
    if (s.state?.spaces.PC !== prev.state?.spaces.PC) playground.setActive(s.state?.spaces.PC === "PLAYGROUND");
  });
}


// ─── Server events → UI state ───

arc.on("JARVIS_RESPONSE", (m) => useArc.setState({ response: { id: m.id, text: m.text, attachments: m.attachments, primary: m.primary, at: Date.now() } }));
arc.on("TRANSCRIPT", (m) => useArc.setState({ transcript: { text: m.text, accepted: m.accepted, at: Date.now() } }));
arc.on("PAIRING_INFO", (m) => useArc.setState({ pairing: { url: m.url, qrSvg: m.qrSvg, addresses: m.addresses, expiresAt: m.expiresAt, devices: m.devices } }));
arc.on("FILE_RECEIVED", (m) => {
  if (ROLE !== "PC") return;
  notify({ level: "info", title: m.kind === "model" ? "MODEL ADDED" : "FILE FROM PHONE", text: m.kind === "model" ? `${m.name} is in your library` : `${m.name} → ${m.path}` }, 6000);
});
arc.on("TELEMETRY", (m) => useArc.setState({ telemetry: { cpu: m.cpu, memory: m.memory, uptime: m.uptime } }));
arc.on("NOTIFY", (m) => notify({ level: m.level, title: m.title, text: m.text, code: m.code }, m.code === "VISION_LOST" ? 0 : 6000));
arc.on("CONFIRM_RESOLVED", (m) => {
  useArc.setState({ confirmFlash: { id: m.id, approved: m.approved } });
  setTimeout(() => useArc.setState((s) => (s.confirmFlash?.id === m.id ? { confirmFlash: null } : {})), 1400);
});

let transitionKey = 0;
// Each device has its own space: only the device whose space changed shows the transition.
arc.on("MODE_TRANSITION", (m) => {
  if (m.device !== ROLE) return;
  useArc.setState({ transition: { kind: "mode", device: m.device, from: m.from, to: m.to, visionFrom: m.visionFrom, visionTo: m.visionTo, key: ++transitionKey } });
});
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

// Open palm silences JARVIS. It deliberately does NOT cancel confirmations: a hand held
// open in front of the camera was cancelling requests by accident. Use NO, or say "no".
gestures.on("palmhold", () => {
  if (useArc.getState().local.speaking) {
    voiceOut.stop();
    arc.send({ type: "CANCEL" });
  }
});
gestures.on("pose", ({ pose }) => setLocal({ gesture: pose }));
gestures.on("lost", () => setLocal({ gesture: "NONE" }));

// The PC is the listening device when no phone is connected: start the mic on the first
// click / key press (browsers require a user gesture before audio capture + playback).
if (ROLE === "PC") {
  const firstGesture = () => {
    if (useArc.getState().state?.voiceInput === "PC" && !useArc.getState().engaged) void engage();
  };
  window.addEventListener("pointerdown", firstGesture, { capture: true });
  window.addEventListener("keydown", firstGesture, { capture: true });
}

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
  (window as unknown as { __arc: unknown }).__arc = { gestures, visor, playground, arc, deepDive, voiceOut, store: useArc };
}
