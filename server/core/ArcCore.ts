import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { CameraManager } from "../camera/CameraManager";
import { JsonStore } from "./store";
import { config } from "../config";
import type {
  ArcMode,
  ArcState,
  DeepDivePart,
  DeepDiveSettings,
  LibraryModel,
  ModelActionInfo,
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
  activeSource: DeviceRole;
  phoneHands?: boolean;
  notes: { text: string; createdAt: number }[];
  visor: Pick<VisorState, "device" | "previousMode" | "gazeInPlayground">;
  /** Deep Dive look, remembered per model. */
  deepDivePrefs?: Record<string, DeepDiveSettings>;
  brightness?: number;
}

export const DEEP_DIVE_DEFAULTS: DeepDiveSettings = {
  ar: false,
  labels: false,
  bg: "#02070f",
  color: "#5fd8ff",
  labelColor: "#bff3ff",
  style: "solid",
  spin: 0.25,
  detail: "auto",
  explode: 0,
};

const VISOR_STATUS_OFF: VisorState["status"] = { face: "OFF", gaze: "OFF", hands: "OFF", confidence: null, calibrated: false, target: null };

interface CoreEvents {
  state: [ArcState];
  "mode-transition": [{ device: DeviceRole; from: ArcMode; to: ArcMode; visionFrom: DeviceRole; visionTo: DeviceRole }];
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
      activeSource: "PC",
      notes: [],
      visor: { device: null, previousMode: "COMMAND", gazeInPlayground: false },
    });
    this.camera = new CameraManager(this.session.activeSource ?? "PC");
    this.camera.phoneHands = this.session.phoneHands ?? false;

    this.state = {
      sessionId: randomUUID(),
      startedAt: Date.now(),
      // ARC always opens in Command mode on both devices (history and scene are still restored).
      spaces: { PC: "COMMAND", PHONE: "COMMAND" },
      primaryDevice: "PC",
      voiceInput: "PC",
      vision: { activeSource: this.camera.activeSource, phoneHands: this.camera.phoneHands, routes: [], sources: this.camera.sources },
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
      library: [],
      thumbs: {},
      deepDive: { active: false, modelId: null, modelName: null, settings: { ...DEEP_DIVE_DEFAULTS }, parts: [], focusPart: null, collection: null, actions: [] },
      // Brightness starts minimal: coloured models and holograms glow less.
      settings: { autoExecuteLowRisk: config.autoExecuteLowRisk, brightness: this.session.brightness ?? 0.3 },
      // The visor never survives a restart (its device has to re-open it).
      visor: { ...this.session.visor, device: null, status: { ...VISOR_STATUS_OFF } },
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
    // A device that goes away comes back to its Command space.
    if (this.state.spaces[role] === "VISOR") this.leaveVisor(role, "COMMAND");
    if (role === "PHONE") this.state.spaces.PHONE = "COMMAND";
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

  // ─── Spaces & vision ───

  /**
   * A mode request from `requester`. The phone and the PC each have their own space, so this
   * decides WHICH device's space changes:
   *  - PLAYGROUND always lives on the PC;
   *  - VISOR runs on the phone whenever it is connected (phone-first), else on the PC;
   *  - COMMAND returns the requester to Command, or — if it's already there — the PC (the bridge:
   *    "command mode" said on the phone while the PC is in the Playground brings the PC back).
   */
  setMode(mode: ArcMode, requester: DeviceRole = "PC"): boolean {
    const { spaces, devices } = this.state;
    if (mode === "PLAYGROUND") return this.setSpace("PC", "PLAYGROUND");
    if (mode === "VISOR") return this.setSpace(devices.PHONE.connected ? "PHONE" : "PC", "VISOR");
    return this.setSpace(spaces[requester] !== "COMMAND" ? requester : "PC", "COMMAND");
  }

  /** Change one device's space. Only state changes — nothing is restarted. */
  setSpace(device: DeviceRole, mode: ArcMode): boolean {
    const { spaces, visor } = this.state;
    if (device === "PHONE" && mode === "PLAYGROUND") return false; // the 3D workspace is the PC's
    const from = spaces[device];
    if (from === mode) return false;
    const visionFrom = this.camera.activeSource;
    if (mode === "VISOR") {
      const other: DeviceRole = device === "PHONE" ? "PC" : "PHONE";
      if (spaces[other] === "VISOR") this.leaveVisor(other, "COMMAND"); // one visor at a time
      visor.previousMode = from;
      visor.device = device;
    }
    if (from === "VISOR") this.leaveVisor(device, mode);
    // Deep Dive is part of the Playground: leaving the Playground closes it.
    if (device === "PC" && from === "PLAYGROUND") this.state.deepDive.active = false;
    if (device === "PC" && mode === "PLAYGROUND") {
      visor.gazeInPlayground = from === "VISOR";
      // The phone is touch-first: the Playground starts on the PC webcam.
      this.camera.switchCamera("PC");
    }
    spaces[device] = mode;
    this.recomputeRouting();
    this.emit("mode-transition", { device, from, to: mode, visionFrom, visionTo: this.camera.activeSource });
    this.persist();
    this.changed();
    return true;
  }

  private leaveVisor(device: DeviceRole, next: ArcMode): void {
    const visor = this.state.visor;
    this.state.spaces[device] = next;
    if (visor.device === device) visor.device = null;
    if (!(device === "PC" && next === "PLAYGROUND")) visor.status = { ...VISOR_STATUS_OFF, calibrated: visor.status.calibrated };
  }

  /** Leave VISOR, back to the space it was entered from. */
  exitVisor(): boolean {
    const device = this.state.visor.device;
    if (!device || this.state.spaces[device] !== "VISOR") return false;
    const back = this.state.visor.previousMode;
    return this.setSpace(device, back === "VISOR" || (device === "PHONE" && back === "PLAYGROUND") ? "COMMAND" : back);
  }

  setPhoneHands(enabled: boolean): void {
    if (this.camera.phoneHands === enabled) return;
    this.camera.phoneHands = enabled;
    this.recomputeRouting();
    this.persist();
    this.changed();
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
    const { spaces, devices } = this.state;
    // Who speaks: the phone in its Command / Visor space, the PC while it runs the Playground (or its own visor).
    if (!devices.PHONE.connected) this.state.primaryDevice = "PC";
    else if (spaces.PHONE === "VISOR") this.state.primaryDevice = "PHONE";
    else this.state.primaryDevice = spaces.PC === "PLAYGROUND" || spaces.PC === "VISOR" ? "PC" : "PHONE";
    // JARVIS's always-listening mic: the phone when connected, otherwise the PC.
    this.state.voiceInput = devices.PHONE.connected ? "PHONE" : "PC";
    this.state.vision.activeSource = this.camera.activeSource;
    this.state.vision.phoneHands = this.camera.phoneHands;
    this.state.vision.routes = this.camera.routes(spaces, { PHONE: devices.PHONE.connected, PC: devices.PC.connected });
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

  // ─── Model library & Deep Dive ───

  setLibrary(models: LibraryModel[], thumbs: Record<string, string>): void {
    this.state.library = models;
    this.state.thumbs = thumbs;
    const dd = this.state.deepDive;
    // A deleted model can't stay on the Deep Dive stage.
    if (dd.modelId?.startsWith("m-") && !models.some((m) => m.id === dd.modelId)) {
      dd.modelId = dd.modelName = null;
      dd.parts = [];
      dd.focusPart = null;
    }
    // Functions JARVIS just wrote (or labels just pinned) show up on the stage and the phone.
    const model = models.find((m) => m.id === dd.modelId);
    if (model) {
      dd.parts = dd.parts.map((p) => ({ ...p, info: p.info ?? model.partInfo[p.name] ?? model.labels.find((l) => l.id === p.id)?.info }));
      if (model.name !== dd.modelName) dd.modelName = model.name;
    }
    this.changed();
  }

  /** Open Deep Dive (with a model, or the carousel when `modelId` is null), or close it. */
  setDeepDive(active: boolean, modelId: string | null = null, modelName: string | null = null, collection?: string | null): void {
    const dd = this.state.deepDive;
    dd.active = active;
    if (collection !== undefined) dd.collection = collection;
    if (!active) {
      dd.focusPart = null;
      this.changed();
      return;
    }
    if (modelId !== dd.modelId) {
      dd.modelId = modelId;
      dd.modelName = modelName;
      dd.parts = [];
      dd.actions = [];
      dd.focusPart = null;
      if (modelId) {
        const saved = this.session.deepDivePrefs?.[modelId];
        dd.settings = { ...DEEP_DIVE_DEFAULTS, ...saved, labels: saved?.labels ?? saved?.ar ?? false };
      }
    }
    this.changed();
  }

  updateDeepDive(patch: Partial<DeepDiveSettings>): void {
    const dd = this.state.deepDive;
    // Turning AR on brings the labels with it (they can still be hidden separately).
    if (patch.ar === true && patch.labels === undefined) patch = { ...patch, labels: true };
    dd.settings = { ...dd.settings, ...patch };
    if (dd.modelId) {
      this.session.deepDivePrefs = { ...this.session.deepDivePrefs, [dd.modelId]: dd.settings };
      this.persist();
    }
    this.changed();
  }

  setDeepDiveParts(modelId: string, parts: DeepDivePart[], actions?: ModelActionInfo[]): void {
    const dd = this.state.deepDive;
    if (dd.modelId !== modelId) return;
    dd.parts = parts;
    if (actions) dd.actions = actions;
    this.changed();
  }

  /** Change one of the model's interactive states (undefined value = toggle / next option). */
  setModelAction(id: string, value?: boolean | string): ModelActionInfo | null {
    const a = this.state.deepDive.actions.find((x) => x.id === id);
    if (!a) return null;
    if (a.kind === "toggle") a.value = typeof value === "boolean" ? value : !a.value;
    else if (a.kind === "choice") {
      const opts = a.options ?? [];
      a.value = typeof value === "string" && opts.includes(value) ? value : opts[(opts.indexOf(String(a.value)) + 1) % Math.max(1, opts.length)] ?? a.value;
    } else a.value = typeof a.value === "boolean" ? !a.value : true; // trigger: flips so the PC sees a change
    this.changed();
    return a;
  }

  setBrightness(value: number): void {
    this.state.settings.brightness = Math.max(0, Math.min(1, value));
    this.session.brightness = this.state.settings.brightness;
    this.persist();
    this.changed();
  }

  focusPart(part: string | null): void {
    this.state.deepDive.focusPart = part;
    this.changed();
  }

  // ─── Plumbing ───

  private persist(): void {
    this.session.history = this.state.history;
    this.session.activeSource = this.camera.activeSource;
    this.session.phoneHands = this.camera.phoneHands;
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
