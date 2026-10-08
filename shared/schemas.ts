/**
 * ARC shared protocol — runtime schemas (zod) and the types inferred from them.
 *
 * The server validates every inbound message and every LLM-produced action
 * against these schemas. The client only ever does `import type` from here,
 * so zod is never bundled into the browser.
 */
import { z } from "zod";

export const DeviceRoleSchema = z.enum(["PHONE", "PC"]);
export const ArcModeSchema = z.enum(["COMMAND", "PLAYGROUND", "VISOR"]);
export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export const VisionStatusSchema = z.enum(["OFFLINE", "IDLE", "STARTING", "ACTIVE", "ERROR"]);
export const VisorFaceSchema = z.enum(["OFF", "SCANNING", "TRACKING", "LOST"]);
export const VisorGazeSchema = z.enum(["OFF", "UNCALIBRATED", "CALIBRATING", "ACTIVE", "LOW", "LOST"]);
export const VisorHandsSchema = z.enum(["OFF", "STANDBY", "TRACKING", "LOST", "UNAVAILABLE"]);

const text = (max: number) => z.string().trim().min(1).max(max);
/** Playground object reference: an object id, a kind ("earth"), "selected" or "all". */
const objectRef = z.string().trim().min(1).max(60).default("selected");

// ─── Desktop actions (executed on the PC by the allowlisted Action Executor) ───

export const DesktopActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("OPEN_APPLICATION"), target: text(120) }),
  z.object({ action: z.literal("CLOSE_APPLICATION"), target: text(120) }),
  z.object({ action: z.literal("QUERY_APPLICATION"), target: text(120) }),
  z.object({ action: z.literal("OPEN_WEBSITE"), url: text(500) }),
  z.object({
    action: z.literal("SEARCH_WEB"),
    query: text(300),
    engine: z.enum(["google", "youtube"]).default("google"),
  }),
  z.object({ action: z.literal("OPEN_FILE"), path: text(500) }),
  z.object({ action: z.literal("CREATE_FILE"), name: text(120), content: z.string().max(20000).default("") }),
  z.object({ action: z.literal("SEARCH_FILE"), query: text(120) }),
  z.object({ action: z.literal("DELETE_FILE"), path: text(500) }),
  z.object({ action: z.literal("TYPE_TEXT"), text: z.string().min(1).max(2000) }),
  z.object({
    action: z.literal("SYSTEM_INFORMATION"),
    topic: z.enum(["overview", "cpu", "memory", "battery", "uptime"]).default("overview"),
  }),
  z.object({
    action: z.literal("CONTROL_MEDIA"),
    command: z.enum(["PLAY_PAUSE", "NEXT", "PREVIOUS", "STOP", "VOLUME_UP", "VOLUME_DOWN", "MUTE"]),
  }),
]);

// ─── ARC system actions ───

export const SystemActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("SET_MODE"), mode: ArcModeSchema }),
  z.object({ action: z.literal("SWITCH_CAMERA"), to: DeviceRoleSchema }),
  /** Leave VISOR and return to the mode it was entered from. */
  z.object({ action: z.literal("EXIT_VISOR") }),
  z.object({ action: z.literal("RECALIBRATE_GAZE") }),
  /** Gaze cursor in Playground (on the PC camera). */
  z.object({ action: z.literal("SET_GAZE"), enabled: z.boolean() }),
  /** Scene brightness 0..1 (exposure, glow, hologram intensity). Low by default. */
  z.object({ action: z.literal("SET_BRIGHTNESS"), value: z.number().min(0).max(1) }),
  /** Phone hand tracking (off by default — the phone is touch-first). */
  z.object({ action: z.literal("SET_PHONE_HANDS"), enabled: z.boolean() }),
  /** Light / dark theme on the PC and the phone (the visor stays dark). */
  z.object({ action: z.literal("SET_THEME"), theme: z.enum(["light", "dark", "toggle"]) }),
  /** JARVIS's voice: which voice, speed (1 = normal), pitch (semitones), JARVIS effect (0..1). Only the fields that change. */
  z.object({
    action: z.literal("SET_VOICE"),
    voice: text(80).optional(),
    speed: z.number().min(0.6).max(1.6).optional(),
    pitch: z.number().min(-4).max(4).optional(),
    fx: z.number().min(0).max(1).optional(),
  }),
]);

// ─── Playground actions (executed by the 3D engine on the PC display) ───

export const PlaygroundActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("SPAWN_OBJECT"), object: text(80) }),
  z.object({ action: z.literal("DELETE_OBJECT"), target: objectRef }),
  z.object({ action: z.literal("SELECT_OBJECT"), target: objectRef }),
  z.object({
    action: z.literal("ROTATE_OBJECT"),
    target: objectRef,
    axis: z.enum(["x", "y", "z"]).default("y"),
    amount: z.number().min(-720).max(720).default(45),
  }),
  z.object({
    action: z.literal("SPIN_OBJECT"),
    target: objectRef,
    enabled: z.boolean().default(true),
    speed: z.number().min(-5).max(5).default(0.5),
  }),
  z.object({ action: z.literal("SCALE_OBJECT"), target: objectRef, factor: z.number().min(0.1).max(10) }),
  z.object({
    action: z.literal("MOVE_OBJECT"),
    target: objectRef,
    direction: z.enum(["left", "right", "up", "down", "forward", "back", "center"]),
    amount: z.number().min(0).max(5).default(0.6),
  }),
  z.object({
    action: z.literal("SET_PROPERTY"),
    target: objectRef,
    property: z.enum(["atmosphere", "clouds", "wireframe", "rings", "labels", "orbits"]),
    value: z.boolean(),
  }),
  z.object({ action: z.literal("SHOW_LOCATION"), target: objectRef, location: text(80) }),
  z.object({ action: z.literal("EXPLODE_OBJECT"), target: objectRef, enabled: z.boolean().default(true), amount: z.number().min(0).max(100).optional() }),
  z.object({ action: z.literal("CLEAR_SCENE") }),
  z.object({ action: z.literal("RESET_VIEW") }),
  /** Deep Dive: one model on its own stage. No `model` opens the model carousel. */
  z.object({
    action: z.literal("DEEP_DIVE"),
    enabled: z.boolean().default(true),
    model: z.string().trim().min(1).max(80).optional(),
    /** Carousel category ("ironman", "space", …); "all" clears it. */
    collection: z.string().trim().min(1).max(40).optional(),
  }),
  /** Interact with the model on stage: open the faceplate, power the reactor, paint it… */
  z.object({ action: z.literal("MODEL_ACTION"), id: z.string().trim().min(1).max(40), value: z.union([z.boolean(), z.string().max(40)]).optional() }),
  z.object({
    action: z.literal("DEEP_DIVE_SET"),
    ar: z.boolean().optional(),
    labels: z.boolean().optional(),
    bg: z.string().trim().max(30).optional(),
    color: z.string().trim().max(30).optional(),
    labelColor: z.string().trim().max(30).optional(),
    style: z.enum(["solid", "wireframe", "xray"]).optional(),
    spin: z.number().min(0).max(3).optional(),
    detail: z.enum(["auto", "few", "all"]).optional(),
    /** 0..1 (fractions) — percentages up to 100 are accepted and normalised by ARC. */
    explode: z.number().min(0).max(100).optional(),
  }),
  /** Deep Dive model carousel: spin it or pick the model in front. */
  z.object({ action: z.literal("CAROUSEL"), command: z.enum(["next", "previous", "select"]) }),
  /** Fly the Deep Dive camera to a part and highlight it (null clears). */
  z.object({ action: z.literal("FOCUS_PART"), part: z.string().trim().max(80).nullable() }),
]);

export const ArcActionSchema = z.union([DesktopActionSchema, SystemActionSchema, PlaygroundActionSchema]);

// ─── Scene ───

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const SceneObjectSchema = z.object({
  id: z.string().max(40),
  kind: z.string().max(80),
  name: z.string().max(80),
  position: vec3,
  rotation: vec3,
  scale: z.number(),
  props: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])),
});

export const ModelActionInfoSchema = z.object({
  id: z.string().max(40),
  label: z.string().max(40),
  kind: z.enum(["toggle", "choice", "trigger"]),
  options: z.array(z.string().max(30)).max(8).optional(),
  /** Words that name it by voice ("faceplate", "helmet", "mask"). */
  words: z.array(z.string().max(30)).max(10).optional(),
  value: z.union([z.boolean(), z.string().max(40)]),
});

export const DeepDivePartSchema = z.object({
  id: z.string().max(80),
  name: z.string().max(80),
  info: z.string().max(200).optional(),
  level: z.union([z.literal(1), z.literal(2)]),
  custom: z.boolean().optional(),
});

export const SceneSnapshotSchema = z.object({
  objects: z.array(SceneObjectSchema).max(64),
  selectedId: z.string().max(40).nullable(),
});

// ─── Hand frames (landmarks, not video, travel over the wire) ───

export const HandSchema = z.object({
  handedness: z.enum(["Left", "Right"]),
  /** 21 landmarks × (x, y, z), normalized image coordinates, NOT mirrored. */
  lm: z.array(z.number()).length(63),
});

// ─── Client → server messages ───

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("HELLO"),
    role: DeviceRoleSchema,
    deviceName: z.string().max(80).default("Device"),
    deviceToken: z.string().max(200).optional(),
    pairToken: z.string().max(200).optional(),
  }),
  z.object({ type: z.literal("PING"), t: z.number() }),
  z.object({ type: z.literal("UTTERANCE"), text: text(2000), origin: z.enum(["voice", "text"]).default("text") }),
  z.object({
    type: z.literal("AUDIO"),
    mime: z.string().max(60),
    data: z.string().max(8_000_000),
    handsFree: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("CONFIRM_RESPONSE"),
    id: z.string().max(40),
    approved: z.boolean(),
    via: z.enum(["gesture", "touch", "voice"]).default("touch"),
  }),
  z.object({ type: z.literal("ACTION_REQUEST"), action: ArcActionSchema }),
  z.object({
    type: z.literal("VISION_STATUS"),
    source: DeviceRoleSchema,
    status: VisionStatusSchema,
    error: z.string().max(300).optional(),
    fps: z.number().optional(),
    hands: z.number().optional(),
  }),
  z.object({ type: z.literal("HAND_FRAME"), source: DeviceRoleSchema, t: z.number(), hands: z.array(HandSchema).max(2) }),
  z.object({ type: z.literal("GESTURE"), gesture: z.string().max(40), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("SCENE_STATE"), scene: SceneSnapshotSchema }),
  z.object({ type: z.literal("REQUEST_PAIRING") }),
  z.object({ type: z.literal("UNPAIR"), deviceId: z.string().max(80) }),
  z.object({ type: z.literal("JARVIS_ACTIVITY"), activity: z.enum(["IDLE", "LISTENING", "SPEAKING"]) }),
  z.object({ type: z.literal("CANCEL") }),
  /** Phone → PC clipboard. */
  z.object({ type: z.literal("SEND_CLIPBOARD"), text: z.string().min(1).max(100_000) }),
  /** Phone as a 3D controller: drag = orbit, pinch = zoom, tilt = orientation (high rate, never queued). */
  z.object({
    type: z.literal("CONTROL"),
    kind: z.enum(["orbit", "zoom", "tilt", "end"]),
    dx: z.number().min(-10).max(10).default(0),
    dy: z.number().min(-10).max(10).default(0),
    t: z.number(),
  }),
  /** PC → core: the parts of the model on the Deep Dive stage (labels / phone second screen). */
  z.object({ type: z.literal("DEEP_DIVE_PARTS"), model: z.string().max(80), parts: z.array(DeepDivePartSchema).max(80), actions: z.array(ModelActionInfoSchema).max(12).optional() }),
  /** PC: user pinned a label on an imported model. `pos` is in the model's normalized space. */
  z.object({
    type: z.literal("LABEL_ADD"),
    model: z.string().max(80),
    name: z.string().trim().min(1).max(60),
    pos: z.tuple([z.number(), z.number(), z.number()]),
  }),
  z.object({ type: z.literal("LABEL_REMOVE"), model: z.string().max(80), id: z.string().max(40) }),
  z.object({ type: z.literal("MODEL_DELETE"), model: z.string().max(80) }),
  z.object({ type: z.literal("MODEL_RENAME"), model: z.string().max(80), name: z.string().trim().min(1).max(60) }),
  /** JARVIS voice library: hear a voice on this device, add one from a link or name, delete one. */
  z.object({ type: z.literal("VOICE_PREVIEW"), voice: z.string().max(80).optional() }),
  z.object({ type: z.literal("VOICE_ADD"), source: z.string().trim().min(2).max(500) }),
  z.object({ type: z.literal("VOICE_DELETE"), voice: z.string().max(80) }),
  // Summary of visor tracking (state changes only — gaze coordinates never leave the device).
  z.object({
    type: z.literal("VISOR_STATUS"),
    face: VisorFaceSchema,
    gaze: VisorGazeSchema,
    hands: VisorHandsSchema,
    confidence: z.number().min(0).max(1).nullable(),
    calibrated: z.boolean(),
    target: z.string().max(80).nullable(),
  }),
]);

export type DeviceRole = z.infer<typeof DeviceRoleSchema>;
export type ArcMode = z.infer<typeof ArcModeSchema>;
export type RiskLevel = z.infer<typeof RiskLevelSchema>;
export type VisionStatus = z.infer<typeof VisionStatusSchema>;
export type VisorFace = z.infer<typeof VisorFaceSchema>;
export type VisorGaze = z.infer<typeof VisorGazeSchema>;
export type VisorHands = z.infer<typeof VisorHandsSchema>;
export type DesktopAction = z.infer<typeof DesktopActionSchema>;
export type SystemAction = z.infer<typeof SystemActionSchema>;
export type PlaygroundAction = z.infer<typeof PlaygroundActionSchema>;
export type ArcAction = z.infer<typeof ArcActionSchema>;
export type SceneObject = z.infer<typeof SceneObjectSchema>;
export type SceneSnapshot = z.infer<typeof SceneSnapshotSchema>;
export type Hand = z.infer<typeof HandSchema>;
export type DeepDivePart = z.infer<typeof DeepDivePartSchema>;
export type ModelActionInfo = z.infer<typeof ModelActionInfoSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageOf<T extends ClientMessage["type"]> = Extract<ClientMessage, { type: T }>;

export const DESKTOP_ACTIONS = new Set<string>(DesktopActionSchema.options.map((o) => o.shape.action.value));
export const PLAYGROUND_ACTIONS = new Set<string>(PlaygroundActionSchema.options.map((o) => o.shape.action.value));

export function isDesktopAction(a: ArcAction): a is DesktopAction {
  return DESKTOP_ACTIONS.has(a.action);
}
export function isPlaygroundAction(a: ArcAction): a is PlaygroundAction {
  return PLAYGROUND_ACTIONS.has(a.action);
}
