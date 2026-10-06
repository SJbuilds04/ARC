import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { CameraManager } from "../camera/CameraManager";
import { JsonStore } from "./store";
import { config } from "../config";
import type {
  ArcMode,
  ArcState,
  DeviceRole,
  ExecutionRecord,
  HistoryEntry,
  JarvisActivity,
  PendingAction,
  SceneSnapshot,
  ServiceInfo,
  VisionSourceState,
  VisorState,
} from "../../shared/types";

const HISTORY_LIMIT = 100;
const EXECUTIONS_LIMIT = 8;

interface PersistedSession {
  history: HistoryEntry[];
  scene: SceneSnapshot;
  mode: ArcMode;
  activeSource: DeviceRole;
  notes: { text: string; createdAt: number }[];
  visor: Pick<VisorState, "device" | "previousMode" | "gazeInPlayground">;
}

const VISOR_STATUS_OFF: VisorState["status"] = { face: "OFF", gaze: "OFF", hands: "OFF", confidence: null, calibrated: false, target: null };

interface CoreEvents {
  state: [ArcState];
  "mode-transition": [{ from: ArcMode; to: ArcMode; visionFrom: DeviceRole; visionTo: DeviceRole }];
  "camera-switch": [{ from: DeviceRole; to: DeviceRole }];
  "vision-lost": [{ source: DeviceRole; reason: string }];
}

/**
 * ARC Core — the single, long-lived session. Everything (devices, JARVIS, vision,
 * playground) reads and mutates state through here. Modes and cameras are just
 * fields on this object; changing them never recreates the core, the sockets,
 * JARVIS or the history.
 */
export class ArcCore extends EventEmitter<CoreEvents> {
  readonly camera: CameraManager;
  private readonly store = new JsonStore<PersistedSession>("session.json");
  private readonly session: PersistedSession;
  private readonly state: ArcState;
  private emitQueued = false;

  constructor() {
    super();
    this.session = this.store.load({
      history: [],
      scene: { objects: [], selectedId: null },
      mode: "COMMAND",
      activeSource: "PHONE",
      notes: [],
      visor: { device: null, previousMode: "COMMAND", gazeInPlayground: false },
    });
    this.camera = new CameraManager(this.session.activeSource);

    this.state = {
      sessionId: randomUUID(),
      startedAt: Date.now(),
      mode: this.session.mode,
      primaryDevice: "PC",
      vision: { activeSource: this.camera.activeSource, routes: [], sources: this.camera.sources },
      devices: { PHONE: { connected: false }, PC: { connected: false } },
      services: {
        jarvis: { status: "ONLINE" },
        ai: { status: config.groq.apiKey ? "DEGRADED" : "UNCONFIGURED", model: config.groq.models[0] },
        stt: { status: config.groq.apiKey ? "ONLINE" : "UNCONFIGURED" },
        voice: { status: "ONLINE", engine: "BROWSER" },
        desktop: { status: "ONLINE", platform: process.platform },
      },
      jarvis: { activity: "IDLE", armedUntil: 0 },
      history: this.session.history,
      executions: [],
      pending: null,
      scene: this.session.scene,
      settings: { autoExecuteLowRisk: config.autoExecuteLowRisk },
      visor: { ...this.session.visor, status: { ...VISOR_STATUS_OFF } },
    };
    this.recomputeRouting();
  }

  getState(): ArcState {
    return this.state;
  }

  get notes() {
    return this.session.notes;
  }

  saveNotes(): void {
    this.persist();
  }

  // ─── Devices ───

  deviceConnected(role: DeviceRole, name: string): void {
    this.state.devices[role] = { connected: true, name };
    if (role === "PHONE" && this.camera.sources.PHONE.status === "OFFLINE") {
      this.camera.setSourceStatus("PHONE", { status: "IDLE" });
    }
    this.recomputeRouting();
    this.changed();
  }

  deviceDisconnected(role: DeviceRole): void {
    this.state.devices[role] = { ...this.state.devices[role], connected: false, latencyMs: undefined };
    const wasActive = this.camera.activeSource === role && this.camera.sources[role].status === "ACTIVE";
    this.camera.setSourceStatus(role, { status: "OFFLINE" });
    if (wasActive) this.emit("vision-lost", { source: role, reason: `${role} disconnected` });
    this.recomputeRouting();
    this.changed();
  }

  setLatency(role: DeviceRole, ms: number): void {
    const d = this.state.devices[role];
    if (!d.connected) return;
    // Latency alone is not worth a state broadcast every ping; piggyback on the next one.
    d.latencyMs = Math.round(ms);
  }

  // ─── Modes & vision ───

  /**
   * Change mode. Only state changes — nothing is restarted. `requester` is the device
   * that asked (used to decide which device's front camera runs the visor).
   */
  setMode(mode: ArcMode, requester?: DeviceRole): boolean {
    if (mode === this.state.mode) return false;
    const from = this.state.mode;
    const visionFrom = this.camera.activeSource;
    const visor = this.state.visor;
    if (mode === "VISOR") {
      visor.previousMode = from;
      const { devices } = this.state;
      visor.device = requester && devices[requester].connected ? requester : devices.PHONE.connected ? "PHONE" : "PC";
    }
    if (mode === "PLAYGROUND") visor.gazeInPlayground = from === "VISOR";
    if (from === "VISOR" && mode !== "PLAYGROUND") visor.status = { ...VISOR_STATUS_OFF, calibrated: visor.status.calibrated };
    this.state.mode = mode;
    this.camera.switchCamera(this.defaultSource(mode));
    this.recomputeRouting();
    this.emit("mode-transition", { from, to: mode, visionFrom, visionTo: this.camera.activeSource });
    this.persist();
    this.changed();
    return true;
  }

  /** Leave VISOR, back to wherever it was entered from. */
  exitVisor(): boolean {
    if (this.state.mode !== "VISOR") return false;
    const back = this.state.visor.previousMode;
    return this.setMode(back === "VISOR" ? "COMMAND" : back);
  }

  setGazeInPlayground(enabled: boolean): void {
    if (this.state.visor.gazeInPlayground === enabled) return;
    this.state.visor.gazeInPlayground = enabled;
    this.persist();
    this.changed();
  }

  /** Tracking summary from the visor device. Confidence alone doesn't trigger a broadcast. */
  setVisorStatus(status: VisorState["status"]): void {
    const prev = this.state.visor.status;
    const meaningful = prev.face !== status.face || prev.gaze !== status.gaze || prev.hands !== status.hands || prev.calibrated !== status.calibrated || prev.target !== status.target;
    this.state.visor.status = status;
    if (meaningful) this.changed();
  }

  private defaultSource(mode: ArcMode): DeviceRole {
    if (mode === "VISOR") return this.state.visor.device ?? "PHONE";
    return CameraManager.defaultSourceFor(mode);
  }

  switchCamera(to: DeviceRole): boolean {
    const change = this.camera.switchCamera(to);
    if (!change) return false;
    this.recomputeRouting();
    this.emit("camera-switch", change);
    this.persist();
    this.changed();
    return true;
  }

  setVisionStatus(source: DeviceRole, status: VisionSourceState): void {
    const prev = this.camera.setSourceStatus(source, status);
    if (prev.status === "ACTIVE" && status.status === "ERROR" && this.camera.activeSource === source) {
      this.emit("vision-lost", { source, reason: status.error ?? "Camera error" });
    }
    // fps/hand counts change constantly; only broadcast on status transitions.
    if (prev.status !== status.status || prev.error !== status.error) this.changed();
  }

  private recomputeRouting(): void {
    const { mode, devices, visor } = this.state;
    if (mode === "VISOR" && visor.device) {
      const other: DeviceRole = visor.device === "PHONE" ? "PC" : "PHONE";
      this.state.primaryDevice = devices[visor.device].connected || !devices[other].connected ? visor.device : other;
    } else this.state.primaryDevice = mode === "COMMAND" && devices.PHONE.connected ? "PHONE" : "PC";
    this.state.vision.activeSource = this.camera.activeSource;
    this.state.vision.routes = this.camera.routes(this.state.primaryDevice);
  }

  // ─── JARVIS ───

  setActivity(activity: JarvisActivity): void {
    if (this.state.jarvis.activity === activity) return;
    this.state.jarvis.activity = activity;
    this.changed();
  }

  arm(ms: number): void {
    this.state.jarvis.armedUntil = Date.now() + ms;
  }

  isArmed(): boolean {
    return Date.now() < this.state.jarvis.armedUntil;
  }

  addHistory(entry: Omit<HistoryEntry, "id" | "t">): HistoryEntry {
    const full: HistoryEntry = { id: randomUUID().slice(0, 8), t: Date.now(), ...entry };
    this.state.history.push(full);
    if (this.state.history.length > HISTORY_LIMIT) this.state.history.splice(0, this.state.history.length - HISTORY_LIMIT);
    this.persist();
    this.changed();
    return full;
  }

  setService<K extends keyof ArcState["services"]>(key: K, patch: Partial<ArcState["services"][K]> & Partial<ServiceInfo>): void {
    const current = this.state.services[key];
    const next = { ...current, ...patch };
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    this.state.services[key] = next;
    this.changed();
  }

  // ─── Actions ───

  upsertExecution(record: ExecutionRecord): void {
    const list = this.state.executions;
    const i = list.findIndex((e) => e.id === record.id);
    if (i >= 0) list[i] = record;
    else list.unshift(record);
    if (list.length > EXECUTIONS_LIMIT) list.length = EXECUTIONS_LIMIT;
    this.changed();
  }

  setPending(pending: PendingAction | null): void {
    this.state.pending = pending;
    this.changed();
  }

  // ─── Scene ───

  setScene(scene: SceneSnapshot): void {
    this.state.scene = scene;
    this.session.scene = scene;
    this.persist();
    this.changed();
  }

  // ─── Plumbing ───

  private persist(): void {
    this.session.history = this.state.history;
    this.session.mode = this.state.mode;
    this.session.activeSource = this.camera.activeSource;
    const { device, previousMode, gazeInPlayground } = this.state.visor;
    this.session.visor = { device, previousMode, gazeInPlayground };
    this.store.save(this.session);
  }

  /** Coalesce bursts of mutations into one state broadcast. */
  changed(): void {
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => {
      this.emitQueued = false;
      this.emit("state", this.state);
    });
  }

  shutdown(): void {
    this.store.flush();
  }
}
