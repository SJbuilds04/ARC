/**
 * ARC shared types — session state and server → client messages.
 * Type-only module: safe to import from both server and browser.
 */
import type {
  ArcAction,
  ArcMode,
  DeviceRole,
  Hand,
  PlaygroundAction,
  RiskLevel,
  SceneSnapshot,
  VisionStatus,
  VisorFace,
  VisorGaze,
  VisorHands,
} from "./schemas";

export type {
  ArcAction,
  ArcMode,
  DeviceRole,
  Hand,
  PlaygroundAction,
  RiskLevel,
  SceneSnapshot,
  VisionStatus,
  VisorFace,
  VisorGaze,
  VisorHands,
} from "./schemas";
export type { SceneObject, DesktopAction, ClientMessage, ClientMessageOf } from "./schemas";

export type ServiceStatus = "ONLINE" | "DEGRADED" | "OFFLINE" | "UNCONFIGURED";

export interface ServiceInfo {
  status: ServiceStatus;
  detail?: string;
}

/** A path frames take: from the device whose camera is active to the device whose UI consumes them. */
export interface VisionRoute {
  source: DeviceRole;
  consumer: DeviceRole;
}

export interface VisionSourceState {
  status: VisionStatus;
  error?: string;
  fps?: number;
  hands?: number;
}

export interface DeviceState {
  connected: boolean;
  name?: string;
  latencyMs?: number;
}

export interface HistoryEntry {
  id: string;
  t: number;
  role: "user" | "jarvis" | "system";
  text: string;
  device?: DeviceRole;
  error?: boolean;
}

export type ActionStage =
  | "REQUEST"
  | "ANALYZING"
  | "AWAITING_CONFIRMATION"
  | "AUTHORIZED"
  | "EXECUTING"
  | "COMPLETE"
  | "CANCELLED"
  | "FAILED";

export interface ExecutionRecord {
  id: string;
  title: string;
  risk: RiskLevel;
  stage: ActionStage;
  detail?: string;
  startedAt: number;
  updatedAt: number;
}

export interface PendingAction {
  id: string;
  action: ArcAction;
  title: string;
  detail?: string;
  risk: RiskLevel;
  /** HIGH risk: the confirm control must be held (sustained pinch / long press). */
  holdMs: number;
  createdAt: number;
  expiresAt: number;
}

export type JarvisActivity = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING";

export interface ArcState {
  sessionId: string;
  startedAt: number;
  mode: ArcMode;
  /** Device that shows the primary JARVIS response and speaks it. */
  primaryDevice: DeviceRole;
  vision: {
    activeSource: DeviceRole;
    routes: VisionRoute[];
    sources: Record<DeviceRole, VisionSourceState>;
  };
  devices: Record<DeviceRole, DeviceState>;
  services: {
    jarvis: ServiceInfo;
    ai: ServiceInfo & { model?: string; latencyMs?: number };
    stt: ServiceInfo;
    voice: ServiceInfo & { engine: "GROQ" | "BROWSER" };
    desktop: ServiceInfo & { platform: string };
  };
  jarvis: { activity: JarvisActivity; armedUntil: number };
  history: HistoryEntry[];
  executions: ExecutionRecord[];
  pending: PendingAction | null;
  scene: SceneSnapshot;
  settings: { autoExecuteLowRisk: boolean };
  visor: VisorState;
}

/** Persistent VISOR state (server-side summary; high-rate gaze data stays on the device). */
export interface VisorState {
  /** Device whose front camera + screen run the visor. */
  device: DeviceRole | null;
  /** Mode to return to on "exit visor". */
  previousMode: ArcMode;
  /** Keep the gaze cursor in Playground (PC camera). */
  gazeInPlayground: boolean;
  status: {
    face: VisorFace;
    gaze: VisorGaze;
    hands: VisorHands;
    confidence: number | null;
    calibrated: boolean;
    target: string | null;
  };
}

export type Attachment =
  | { kind: "files"; items: { name: string; path: string }[] }
  | { kind: "system"; items: { label: string; value: string }[] }
  | { kind: "location"; name: string; items: { label: string; value: string }[] };

export interface PairedDeviceInfo {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen: number;
  connected: boolean;
}

export type ServerMessage =
  | { type: "WELCOME"; deviceId: string; role: DeviceRole; deviceToken?: string; state: ArcState; serverTime: number }
  | { type: "STATE"; state: ArcState }
  | { type: "PONG"; t: number; serverTime: number }
  | { type: "TRANSCRIPT"; text: string; device: DeviceRole; accepted: boolean }
  | {
      type: "JARVIS_RESPONSE";
      id: string;
      text: string;
      primary: DeviceRole;
      audio: "server" | "browser" | "none";
      attachments?: Attachment[];
    }
  | {
      type: "JARVIS_AUDIO";
      id: string;
      seq: number;
      last: boolean;
      mime?: string;
      data?: string;
      /** Server voice failed for this chunk: the client speaks `fallbackText` with the browser voice. */
      failed?: boolean;
      fallbackText?: string;
    }
  | { type: "CONFIRM_REQUEST"; pending: PendingAction }
  | { type: "CONFIRM_RESOLVED"; id: string; approved: boolean }
  | { type: "ACTION_STATUS"; execution: ExecutionRecord }
  | { type: "MODE_TRANSITION"; from: ArcMode; to: ArcMode; visionFrom: DeviceRole; visionTo: DeviceRole }
  | { type: "CAMERA_SWITCH"; from: DeviceRole; to: DeviceRole }
  | { type: "VISOR_COMMAND"; command: "RECALIBRATE" }
  | { type: "PLAYGROUND_COMMAND"; id: string; command: PlaygroundAction }
  | { type: "HAND_FRAME"; source: DeviceRole; t: number; hands: Hand[] }
  | {
      type: "PAIRING_INFO";
      url: string;
      qrSvg: string;
      addresses: string[];
      expiresAt: number;
      devices: PairedDeviceInfo[];
    }
  | { type: "TELEMETRY"; cpu: number | null; memory: number | null; uptime: number; t: number }
  | { type: "NOTIFY"; level: "info" | "warning" | "error"; title: string; text: string; code?: string }
  | { type: "ERROR"; code: string; message: string };

export type ServerMessageOf<T extends ServerMessage["type"]> = Extract<ServerMessage, { type: T }>;
