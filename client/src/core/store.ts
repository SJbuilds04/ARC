import { create } from "zustand";
import type { ArcMode, ArcState, Attachment, DeviceRole, PairedDeviceInfo, VisorFace, VisorGaze, VisorHands } from "@shared/types";
import { DEFAULT_GAZE_SETTINGS, type GazeSettings } from "../visor/GazeSmoother";
import type { TargetInfo } from "../visor/TargetingManager";
import { ROLE, prefs } from "./device";

export type ConnStatus = "connecting" | "online" | "reconnecting" | "rejected" | "superseded";
export type MicState = "off" | "idle" | "recording" | "sending" | "error";

export interface Notice {
  id: number;
  level: "info" | "warning" | "error";
  title: string;
  text: string;
  code?: string;
}

export interface Transition {
  kind: "mode" | "camera";
  device?: DeviceRole;
  from?: ArcMode;
  to?: ArcMode;
  visionFrom: DeviceRole;
  visionTo: DeviceRole;
  key: number;
}

export interface LocationInfo {
  name: string;
  items: { label: string; value: string }[];
}

export type VisorPhase = "off" | "boot" | "calibrating" | "calibration-failed" | "tracking";

/** Device-local VISOR state (persists across mode switches and re-renders). */
export interface VisorUi {
  phase: VisorPhase;
  boot: { label: string; state: "pending" | "ok" | "warn" | "fail"; note?: string }[];
  calib: { index: number; total: number; paused: boolean; reason?: string; rms?: number };
  face: VisorFace;
  gaze: VisorGaze;
  hands: VisorHands;
  confidence: number | null;
  message: string | null;
  target: TargetInfo | null;
  calibrated: boolean;
  settings: GazeSettings;
}

interface ArcStore {
  role: DeviceRole;
  conn: { status: ConnStatus; error?: { code: string; message: string }; latencyMs?: number };
  state: ArcState | null;
  bootDone: boolean;
  engaged: boolean;
  transition: Transition | null;
  response: { id: string; text: string; attachments?: Attachment[]; primary: DeviceRole; at: number } | null;
  transcript: { text: string; accepted: boolean; at: number } | null;
  pairing: { url: string; qrSvg: string; addresses: string[]; expiresAt: number; devices: PairedDeviceInfo[] } | null;
  telemetry: { cpu: number | null; memory: number | null; uptime: number } | null;
  notices: Notice[];
  /** Device-local status that never round-trips through the server. */
  local: {
    handsFree: boolean;
    mic: MicState;
    micError?: string;
    speaking: boolean;
    trackerFps: number;
    renderFps: number;
    hands: number;
    gesture: string;
    camera: "off" | "starting" | "on" | "error";
    cameraError?: string;
    trackerReady: boolean;
    showFeed: boolean;
    /** Live vision performance (camera fps, inference fps/ms, worker vs main, GPU vs CPU). */
    perf: { camera: number; hands: number; face: number; handsMs: number; faceMs: number; handsWhere: string; faceWhere: string } | null;
  };
  location: LocationInfo | null;
  confirmFlash: { id: string; approved: boolean } | null;
  desktopPanel: "console" | "system" | "devices" | "history";
  visor: VisorUi;
  /** PC: a label was pinned on a model; waiting for its name. */
  pinPrompt: { model: string; pos: [number, number, number]; x: number; y: number } | null;
}

export const useArc = create<ArcStore>(() => ({
  role: ROLE,
  conn: { status: "connecting" },
  state: null,
  bootDone: false,
  engaged: false,
  transition: null,
  response: null,
  transcript: null,
  pairing: null,
  telemetry: null,
  notices: [],
  local: {
    handsFree: prefs("handsFree", true),
    mic: "off",
    speaking: false,
    trackerFps: 0,
    renderFps: 0,
    hands: 0,
    gesture: "NONE",
    camera: "off",
    trackerReady: false,
    showFeed: prefs("showFeed", true),
    perf: null,
  },
  location: null,
  confirmFlash: null,
  desktopPanel: "console",
  pinPrompt: null,
  visor: {
    phase: "off",
    boot: [],
    calib: { index: 0, total: 9, paused: false },
    face: "OFF",
    gaze: "OFF",
    hands: "OFF",
    confidence: null,
    message: null,
    target: null,
    calibrated: false,
    settings: { ...DEFAULT_GAZE_SETTINGS, ...prefs<Partial<GazeSettings>>("gazeSettings", {}) },
  },
}));

export function setVisor(patch: Partial<VisorUi>): void {
  const v = useArc.getState().visor;
  for (const k of Object.keys(patch) as (keyof VisorUi)[]) {
    if (v[k] !== patch[k]) {
      useArc.setState({ visor: { ...v, ...patch } });
      return;
    }
  }
}

export const arcStore = useArc;

export function setLocal(patch: Partial<ArcStore["local"]>): void {
  const local = useArc.getState().local;
  for (const k of Object.keys(patch) as (keyof ArcStore["local"])[]) {
    if (local[k] !== patch[k]) {
      useArc.setState({ local: { ...local, ...patch } });
      return;
    }
  }
}

let noticeId = 0;
export function notify(n: Omit<Notice, "id">, ttlMs = 6000): number {
  const id = ++noticeId;
  useArc.setState((s) => ({ notices: [...s.notices.filter((x) => !(n.code && x.code === n.code)), { ...n, id }].slice(-4) }));
  if (ttlMs > 0) setTimeout(() => dismiss(id), ttlMs);
  return id;
}

export function dismiss(id: number): void {
  useArc.setState((s) => ({ notices: s.notices.filter((n) => n.id !== id) }));
}

export function dismissCode(code: string): void {
  useArc.setState((s) => ({ notices: s.notices.filter((n) => n.code !== code) }));
}
