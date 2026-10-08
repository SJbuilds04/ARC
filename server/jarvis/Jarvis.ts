import { randomUUID } from "node:crypto";
import type { ArcCore } from "../core/ArcCore";
import type { AIProvider, ChatMessage, SpeechToTextProvider } from "../ai/AIProvider";
import { AIError } from "../ai/AIProvider";
import { chunkForSpeech, type VoiceProvider } from "../voice/VoiceProvider";
import { describe, type ActionExecutor } from "../actions/ActionExecutor";
import { classify } from "../security/risk";
import { buildSystemPrompt } from "./prompt";
import { parseLocalIntent, stripWake } from "./localIntents";
import { ArcActionSchema, isDesktopAction, isPlaygroundAction } from "../../shared/schemas";
import { catalogEntry, resolveCatalogId, resolveCollection } from "../../shared/catalog";
import type { ArcAction, Attachment, DeepDivePart, DesktopAction, DeviceRole, ExecutionRecord, PendingAction, PlaygroundAction, ServerMessage } from "../../shared/types";
import type { ModelLibrary } from "../library/ModelLibrary";
import type { Received } from "../http/api";
import { setClipboard } from "../actions/clipboard";
import { resolveColor } from "./colors";
import { findVoice } from "../voice/piperVoices";

/** How JARVIS talks to devices — implemented by the DeviceHub, so JARVIS never touches sockets. */
export interface Outbound {
  broadcast(msg: ServerMessage): void;
  sendTo(role: DeviceRole, msg: ServerMessage): boolean;
  isConnected(role: DeviceRole): boolean;
}

const CONFIRM_TIMEOUT_MS = 45_000;
type ConfirmVia = "gesture" | "touch" | "voice" | "timeout" | "superseded" | "cancel";
const CANCEL_REASON: Record<ConfirmVia, string> = {
  gesture: "CANCELLED BY GESTURE",
  touch: "CANCELLED ON SCREEN",
  voice: "CANCELLED BY VOICE",
  timeout: "TIMED OUT · NO ANSWER IN 45s",
  superseded: "REPLACED BY A NEWER REQUEST",
  cancel: "CANCELLED",
};
const STT_PROMPT = "JARVIS, ARC, VS Code, playground, spawn, Earth, Saturn, boss.";
/** Whisper's well-known outputs for silence / noise. */
const HALLUCINATIONS = /^(thank you\.?|thanks for watching!?|you|bye\.?|\.+|subtitles by.*|♪+|okay\.?|so\.?|uh\.?|um\.?)$/i;

const shortId = () => randomUUID().slice(0, 8);

/**
 * JARVIS — the brain. Turns speech/text into replies and structured actions,
 * routes actions (desktop → risk check → confirmation → executor, playground →
 * PC engine, system → ARC core) and speaks results on the primary device.
 */
export class Jarvis {
  private queue: Promise<void> = Promise.resolve();
  private pendingResolve: ((r: { approved: boolean; via: ConfirmVia }) => void) | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private speechGeneration = 0;

  constructor(
    private readonly core: ArcCore,
    private readonly ai: AIProvider,
    private readonly stt: SpeechToTextProvider,
    private readonly voice: VoiceProvider,
    private readonly executor: ActionExecutor,
    private readonly out: Outbound,
    private readonly library: ModelLibrary,
  ) {
    this.reportVoice();
    // a voice picked, installed or deleted shows up in the HUD straight away
    core.on("state", () => this.reportVoice());
  }

  /** Reflect which voice engine is live in the status HUD. */
  private reportVoice(): void {
    const v = this.voice;
    if (!v.available) this.core.setService("voice", { status: "DEGRADED", engine: "BROWSER", voiceName: undefined, detail: v.unavailableReason });
    else if (v.engine === "PIPER") this.core.setService("voice", { status: "ONLINE", engine: "PIPER", voiceName: v.voiceName, detail: undefined });
    else if (v.engine === "LOCAL") this.core.setService("voice", { status: "ONLINE", engine: "LOCAL", voiceName: undefined, detail: "Windows voice (Piper unavailable)" });
    else this.core.setService("voice", { status: "ONLINE", engine: "GROQ", voiceName: undefined, detail: undefined });
  }

  // ─── Inputs ───

  async handleAudio(audio: Buffer, mime: string, device: DeviceRole, handsFree: boolean): Promise<void> {
    if (!this.stt.configured) {
      this.respond("Voice input needs a Groq API key, boss.");
      return;
    }
    let text: string;
    try {
      this.core.setActivity("THINKING");
      text = await this.stt.transcribe(audio, mime, STT_PROMPT);
      this.core.setService("stt", { status: "ONLINE", detail: undefined });
    } catch (err) {
      this.core.setActivity("IDLE");
      const message = (err as Error).message;
      this.core.setService("stt", { status: "DEGRADED", detail: message });
      this.out.broadcast({ type: "NOTIFY", level: "warning", title: "SPEECH RECOGNITION", text: message });
      return;
    }

    const clean = text.trim();
    const { woke } = stripWake(clean);
    const accepted = Boolean(clean) && !HALLUCINATIONS.test(clean) && (!handsFree || woke || this.core.isArmed() || Boolean(this.core.getState().pending));
    if (clean) this.out.broadcast({ type: "TRANSCRIPT", text: clean, device, accepted });
    if (!accepted) {
      this.core.setActivity("IDLE");
      return;
    }
    this.handleUtterance(clean, device);
  }

  handleUtterance(text: string, device: DeviceRole): void {
    this.queue = this.queue
      .then(() => this.process(text, device))
      .catch((err) => {
        console.error("[jarvis] failed to process utterance:", err);
        this.core.setActivity("IDLE");
        this.respond("Something went wrong on my side, boss.", undefined, true);
      });
  }

  /** Actions requested directly from UI controls (e.g. tapping a search result). */
  requestAction(action: ArcAction, device: DeviceRole): void {
    void this.runActions([action], device);
  }

  confirm(id: string, approved: boolean, via: "gesture" | "touch" | "voice"): void {
    const pending = this.core.getState().pending;
    if (!pending || pending.id !== id) return;
    this.resolvePending(approved, via);
  }

  cancel(): void {
    this.speechGeneration++;
    if (this.core.getState().pending) this.resolvePending(false, "cancel");
    this.core.setActivity("IDLE");
  }

  // ─── Bridge: files, clipboard, model parts ───

  /** Text sent from the phone → the PC clipboard. */
  async clipboard(text: string, device: DeviceRole): Promise<void> {
    try {
      await setClipboard(text);
      const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      this.out.sendTo("PC", { type: "NOTIFY", level: "info", title: "CLIPBOARD FROM PHONE", text: preview });
      this.respond("Copied to your PC clipboard, boss.");
    } catch (err) {
      console.warn("[clipboard] failed:", (err as Error).message);
      this.respond("I couldn't reach the PC clipboard, boss.", undefined, true);
    }
    void device;
  }

  /** A file arrived over the bridge. */
  fileReceived(info: Received, from: DeviceRole): void {
    this.out.broadcast({ type: "FILE_RECEIVED", ...info });
    if (info.kind === "model") this.respond(`${info.name} is in your model library, boss.`);
    else if (from === "PHONE") this.respond(`Got ${info.name}, boss. It's in Downloads, ARC.`);
  }

  /** The PC reported the parts of the Deep Dive model; fill in missing functions with Groq. */
  async describeParts(modelId: string, parts: DeepDivePart[]): Promise<void> {
    const model = this.library.get(modelId);
    if (!model || !this.ai.configured) return;
    const missing = parts.filter((p) => !p.info && !model.partInfo[p.name]).map((p) => p.name).slice(0, 40);
    if (!missing.length) return;
    try {
      const result = await this.ai.chat(
        [
          {
            role: "system",
            content:
              'You label parts of 3D models for a holographic viewer. For each part name, write ONE plain sentence (max 14 words) saying what that part is or does. If a name is meaningless (e.g. "Mesh_12", "Object001"), use "". Return ONLY JSON: {"parts": {"<exact part name>": "<sentence>"}}',
          },
          { role: "user", content: `Model: ${model.name}\nParts: ${missing.join(" | ")}` },
        ],
        { json: true, maxTokens: 900 },
      );
      const parsed = JSON.parse(result.text) as { parts?: Record<string, unknown> };
      const info: Record<string, string> = {};
      for (const name of missing) {
        const v = parsed.parts?.[name];
        if (typeof v === "string" && v.trim()) info[name] = v.trim().slice(0, 200);
      }
      if (Object.keys(info).length) this.library.setPartInfo(modelId, info);
    } catch (err) {
      console.warn("[jarvis] part descriptions failed:", (err as Error).message);
    }
  }

  /**
   * While Deep Dive is open there is one model on stage, so Playground object commands apply to it:
   * spawn = show that model, explode / spin / wireframe = the stage's look. Null = nothing to do.
   */
  private forDeepDive(action: ArcAction): ArcAction | null {
    const s = this.core.getState();
    if (!s.deepDive.active || s.spaces.PC !== "PLAYGROUND") return action;
    switch (action.action) {
      case "SPAWN_OBJECT":
        return { action: "DEEP_DIVE", enabled: true, model: action.object };
      case "EXPLODE_OBJECT":
        return { action: "DEEP_DIVE_SET", explode: action.enabled ? toFraction(action.amount ?? 1) : 0 };
      case "SPIN_OBJECT":
        return { action: "DEEP_DIVE_SET", spin: action.enabled ? Math.min(3, Math.abs(action.speed || 0.4)) : 0 };
      case "SET_PROPERTY":
        if (action.property === "wireframe") return { action: "DEEP_DIVE_SET", style: action.value ? "wireframe" : "solid" };
        if (action.property === "labels") return { action: "DEEP_DIVE_SET", ar: action.value };
        return action;
      case "SELECT_OBJECT":
      case "MOVE_OBJECT":
        return null; // nothing to select or move on a one-model stage
      default:
        return action;
    }
  }

  /** "heart", "my drone", "m-drone" → a model id + display name (built-in or imported). */
  resolveModel(text: string): { id: string; name: string } | null {
    if (catalogEntry(text)) return { id: text, name: catalogEntry(text)!.name };
    const imported = this.library.resolve(text);
    const builtin = resolveCatalogId(text);
    // Prefer the user's own model when its name is the better match ("my heart model").
    if (imported && (!builtin || imported.name.toLowerCase().includes(text.toLowerCase().replace(/^(my|the) /, "")))) return { id: imported.id, name: imported.name };
    if (builtin) return { id: builtin, name: catalogEntry(builtin)!.name };
    return imported ? { id: imported.id, name: imported.name } : null;
  }

  private deepDive(action: Extract<PlaygroundAction, { action: "DEEP_DIVE" | "DEEP_DIVE_SET" | "FOCUS_PART" | "MODEL_ACTION" }>): void {
    const state = this.core.getState();
    if (action.action === "DEEP_DIVE") {
      if (!action.enabled) {
        this.core.setDeepDive(false);
        return;
      }
      if (state.spaces.PC !== "PLAYGROUND") this.core.setSpace("PC", "PLAYGROUND");
      const collection = action.collection === undefined ? undefined : action.collection === "all" ? null : (resolveCollection(action.collection) ?? null);
      if (!action.model) {
        this.core.setDeepDive(true, null, null, collection);
        return;
      }
      const model = this.resolveModel(action.model);
      if (!model) {
        this.respond(`I don't have a model called ${action.model}, boss.`, undefined, true);
        return;
      }
      this.core.setDeepDive(true, model.id, model.name);
      return;
    }
    if (!state.deepDive.active) {
      this.respond("That works in Deep Dive, boss. Say deep dive and a model name.");
      return;
    }
    if (action.action === "MODEL_ACTION") {
      if (!this.core.setModelAction(action.id, action.value)) this.respond("This model can't do that, boss.");
      return;
    }
    if (action.action === "FOCUS_PART") {
      const part = action.part ? matchPart(action.part, state.deepDive.parts) : null;
      if (action.part && !part) {
        this.respond(`I can't find ${action.part} on this model, boss.`);
        return;
      }
      this.core.focusPart(part?.id ?? null);
      return;
    }
    const { action: _a, ...patch } = action;
    void _a;
    if (patch.explode !== undefined) patch.explode = toFraction(patch.explode);
    for (const key of ["bg", "color", "labelColor"] as const) {
      if (patch[key] === undefined) continue;
      const hex = resolveColor(patch[key]!);
      if (hex) patch[key] = hex;
      else {
        delete patch[key];
        this.respond(`I don't know the colour ${action[key]}, boss.`);
      }
    }
    if (Object.keys(patch).length) this.core.updateDeepDive(patch);
  }

  // ─── Pipeline ───

  private async process(raw: string, device: DeviceRole): Promise<void> {
    const { text } = stripWake(raw);
    this.core.addHistory({ role: "user", text: raw, device });
    const state = this.core.getState();
    const intent = parseLocalIntent(text, state);

    if (intent) {
      switch (intent.kind) {
        case "wake":
          this.core.arm(8000);
          this.respond("Yes, boss?");
          return;
        case "confirm":
          if (state.pending) this.resolvePending(intent.approved, "voice");
          return;
        case "cancel":
          this.cancel();
          this.respond("Standing by, boss.");
          return;
        case "note-add":
          this.core.notes.unshift({ text: intent.text, createdAt: Date.now() });
          this.core.saveNotes();
          this.respond("I'll remember that, boss.");
          return;
        case "note-list": {
          const notes = this.core.notes.slice(0, 5);
          this.respond(notes.length ? notes.map((n, i) => `${i + 1}. ${n.text}.`).join(" ") : "You have no notes yet, boss.");
          return;
        }
        case "note-clear":
          this.core.notes.length = 0;
          this.core.saveNotes();
          this.respond("Notes cleared, boss.");
          return;
        case "reply":
          if (intent.reply) this.respond(intent.reply);
          void this.runActions(intent.actions, device);
          return;
      }
    }

    // Everything else: Groq.
    this.core.setActivity("THINKING");
    try {
      const recent = state.history.slice(-9, -1).filter((h) => !h.error);
      const messages: ChatMessage[] = [
        { role: "system", content: buildSystemPrompt(state, this.executor.apps.knownNames(), recent) },
        { role: "user", content: text },
      ];
      const result = await this.ai.chat(messages, { json: true, maxTokens: 900 });
      this.core.setService("ai", { status: "ONLINE", model: result.model, latencyMs: result.latencyMs, detail: undefined });
      const parsed = parseModelOutput(result.text);
      if (parsed.dropped) console.warn(`[jarvis] dropped ${parsed.dropped} invalid action(s) from model output`);
      this.respond(parsed.reply || (parsed.actions.length ? "Certainly, boss." : "I'm not sure, boss."));
      void this.runActions(parsed.actions, device);
    } catch (err) {
      const e = err instanceof AIError ? err : new AIError(String(err), "UNAVAILABLE");
      // A rejected request doesn't mean Groq is down.
      if (e.code !== "BAD_REQUEST") this.core.setService("ai", { status: e.code === "UNCONFIGURED" ? "UNCONFIGURED" : "OFFLINE", detail: e.message });
      const reply =
        e.code === "UNCONFIGURED"
          ? "My intelligence core isn't configured. Add a Groq API key, boss."
          : e.code === "AUTH"
            ? "Groq rejected the API key, boss."
            : e.code === "BAD_REQUEST"
              ? "I couldn't process that one, boss. Try rephrasing."
              : "I can't reach Groq right now, boss. Local commands still work.";
      this.respond(reply, undefined, true);
    } finally {
      this.core.setActivity("IDLE");
    }
  }

  private async runActions(actions: ArcAction[], device: DeviceRole): Promise<void> {
    for (const raw of actions) {
      const action = this.forDeepDive(raw);
      if (!action) continue;
      try {
        if (action.action === "SET_MODE") this.core.setMode(action.mode, device);
        else if (action.action === "SWITCH_CAMERA") this.core.switchCamera(action.to);
        else if (action.action === "EXIT_VISOR") this.core.exitVisor();
        else if (action.action === "SET_GAZE") this.core.setGazeInPlayground(action.enabled);
        else if (action.action === "SET_PHONE_HANDS") this.core.setPhoneHands(action.enabled);
        else if (action.action === "SET_BRIGHTNESS") this.core.setBrightness(action.value);
        else if (action.action === "SET_VOICE") this.setVoice(action);
        else if (action.action === "SET_THEME") this.out.broadcast({ type: "THEME", theme: action.theme });
        else if (action.action === "RECALIBRATE_GAZE") this.recalibrateGaze();
        else if (action.action === "DEEP_DIVE" || action.action === "DEEP_DIVE_SET" || action.action === "FOCUS_PART" || action.action === "MODEL_ACTION") {
          if (!this.out.isConnected("PC")) {
            this.respond("The desktop display isn't connected, boss. Open ARC on the PC.", undefined, true);
            return;
          }
          this.deepDive(action);
        } else if (isPlaygroundAction(action)) {
          if (action.action === "SPAWN_OBJECT" && !catalogEntry(action.object)) {
            // Imported models spawn by their library id.
            const model = this.resolveModel(action.object);
            if (model) action.object = model.id;
          }
          if (!this.out.isConnected("PC")) {
            this.respond("The desktop display isn't connected, boss. Open ARC on the PC.", undefined, true);
            return;
          }
          if (this.core.getState().spaces.PC !== "PLAYGROUND") this.core.setSpace("PC", "PLAYGROUND");
          this.out.sendTo("PC", { type: "PLAYGROUND_COMMAND", id: shortId(), command: action });
        } else if (isDesktopAction(action)) {
          await this.runDesktopAction(action, device);
        }
      } catch (err) {
        console.error("[jarvis] action failed:", action, err);
      }
    }
  }

  private async runDesktopAction(action: DesktopAction, device: DeviceRole): Promise<void> {
    const record: ExecutionRecord = {
      id: shortId(),
      title: describe(action),
      risk: classify(action, false).risk,
      stage: "REQUEST",
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    const stage = (s: ExecutionRecord["stage"], detail?: string) => {
      record.stage = s;
      record.detail = detail;
      record.updatedAt = Date.now();
      this.core.upsertExecution({ ...record });
      this.out.broadcast({ type: "ACTION_STATUS", execution: { ...record } });
    };

    stage("ANALYZING");
    const prepared = await this.executor.prepare(action);
    if (!prepared.ok) {
      stage("FAILED", prepared.message);
      this.respond(prepared.message, prepared.attachments);
      return;
    }
    record.title = prepared.title.replace(/\?$/, "");
    const decision = classify(prepared.action, this.core.getState().settings.autoExecuteLowRisk);
    record.risk = decision.risk;

    if (decision.requiresConfirmation) {
      stage("AWAITING_CONFIRMATION");
      const { approved, via } = await this.awaitConfirmation({
        id: record.id,
        action: prepared.action,
        title: prepared.title,
        detail: prepared.detail,
        risk: decision.risk,
        holdMs: decision.holdMs,
        device,
        createdAt: Date.now(),
        expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
      });
      if (!approved) {
        // Record exactly why, so an unexpected cancel can be traced.
        stage("CANCELLED", CANCEL_REASON[via]);
        console.log(`[jarvis] request "${record.title}" cancelled via ${via}`);
        if (via !== "superseded") this.respond(via === "timeout" ? "No answer, boss. I've cancelled it." : "Cancelled, boss.");
        return;
      }
    }
    stage("AUTHORIZED");
    stage("EXECUTING");
    try {
      const result = await this.executor.execute(prepared.action);
      stage(result.ok ? "COMPLETE" : "FAILED", result.ok ? undefined : result.message);
      this.respond(result.message, result.attachments, !result.ok);
    } catch (err) {
      const reason = (err as Error).message;
      stage("FAILED", reason);
      this.respond(`That didn't work, boss. ${reason}.`, undefined, true);
    }
  }

  /** Ask the device running gaze tracking to recalibrate (calibration lives on that device). */
  private recalibrateGaze(): void {
    const { spaces, visor } = this.core.getState();
    const target: DeviceRole | null = visor.device ?? (spaces.PC === "PLAYGROUND" && visor.gazeInPlayground ? "PC" : null);
    if (!target || !this.out.sendTo(target, { type: "VISOR_COMMAND", command: "RECALIBRATE" })) {
      this.respond("Gaze tracking isn't active, boss. Say activate visor first.");
    }
  }

  private awaitConfirmation(pending: PendingAction): Promise<{ approved: boolean; via: ConfirmVia }> {
    // Only one confirmation at a time: a newer request supersedes the old one.
    if (this.core.getState().pending) this.resolvePending(false, "superseded");
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.core.setPending(pending);
      this.out.broadcast({ type: "CONFIRM_REQUEST", pending });
      this.pendingTimer = setTimeout(() => this.resolvePending(false, "timeout"), CONFIRM_TIMEOUT_MS);
    });
  }

  private resolvePending(approved: boolean, via: ConfirmVia): void {
    const pending = this.core.getState().pending;
    if (!pending) return;
    if (approved && via === "voice" && pending.risk === "HIGH") {
      this.respond("This one needs a held confirmation on screen, boss.");
      return;
    }
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.core.setPending(null);
    this.out.broadcast({ type: "CONFIRM_RESOLVED", id: pending.id, approved });
    resolve?.({ approved, via });
  }

  // ─── Output ───

  private respond(text: string, attachments?: Attachment[], error = false): void {
    if (!text) return;
    const id = shortId();
    this.core.addHistory({ role: "jarvis", text, error });
    const primary = this.core.getState().primaryDevice;
    const audio = this.voice.available ? "server" : "browser";
    this.out.broadcast({ type: "JARVIS_RESPONSE", id, text, primary, audio, attachments });
    // Follow-ups ("make it bigger") don't need the wake word for a few seconds after a reply.
    this.core.arm(6000 + text.split(/\s+/).length * 380);
    if (audio === "server") void this.speak(id, text, primary);
  }

  /** "Change your voice to Alan", "talk faster", "turn off the voice effect". */
  private setVoice(a: Extract<ArcAction, { action: "SET_VOICE" }>): void {
    let id: string | undefined;
    if (a.voice) {
      const v = findVoice(this.core.getState().voice.voices, a.voice);
      if (!v) {
        this.respond(`I don't have a voice called ${a.voice} installed, boss. You can add one in Settings.`, undefined, true);
        return;
      }
      id = v.id;
    }
    this.core.setVoice({ id, speed: a.speed, pitch: a.pitch, fx: a.fx });
  }

  private async speak(id: string, text: string, device: DeviceRole): Promise<void> {
    const generation = ++this.speechGeneration;
    const chunks = chunkForSpeech(text).slice(0, 12);
    if (!chunks.length) return;
    // Synthesize all chunks in parallel, deliver strictly in order.
    const jobs = chunks.map((c) => this.voice.synthesize(c));
    jobs.forEach((j) => j.catch(() => undefined));
    for (let seq = 0; seq < chunks.length; seq++) {
      const last = seq === chunks.length - 1;
      try {
        const { mime, data, rate } = await jobs[seq];
        if (generation !== this.speechGeneration) return;
        this.out.sendTo(device, { type: "JARVIS_AUDIO", id, seq, last, mime, data: data.toString("base64"), rate });
        if (seq === 0) this.reportVoice();
      } catch (err) {
        if (generation !== this.speechGeneration) return;
        this.out.sendTo(device, { type: "JARVIS_AUDIO", id, seq, last: true, failed: true, fallbackText: chunks.slice(seq).join(" ") });
        this.reportVoice();
        if (!this.voice.available) console.warn(`[voice] server voice disabled: ${this.voice.unavailableReason}`);
        else console.warn("[voice] synthesis failed:", (err as Error).message);
        return;
      }
    }
  }
}

/** Parse and validate the model's JSON. Invalid actions are dropped, never executed. */
export function parseModelOutput(text: string): { reply: string; actions: ArcAction[]; dropped: number } {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    try {
      obj = m ? JSON.parse(m[0]) : null;
    } catch {
      obj = null;
    }
  }
  if (!obj || typeof obj !== "object") return { reply: text.replace(/[{}"]/g, "").trim().slice(0, 4000), actions: [], dropped: 0 };

  const o = obj as { reply?: unknown; actions?: unknown };
  const reply = typeof o.reply === "string" ? o.reply.trim() : "";
  const rawActions = Array.isArray(o.actions) ? o.actions.slice(0, 8) : [];
  const actions: ArcAction[] = [];
  let dropped = 0;
  for (const a of rawActions) {
    if (!a || typeof a !== "object") {
      dropped++;
      continue;
    }
    const candidate = { ...(a as Record<string, unknown>) };
    if (!candidate.action && typeof candidate.type === "string") candidate.action = candidate.type;
    if (typeof candidate.action === "string") candidate.action = candidate.action.toUpperCase();
    delete candidate.type;
    delete candidate.risk; // risk is ARC's decision, not the model's
    const parsed = ArcActionSchema.safeParse(candidate);
    if (parsed.success) actions.push(parsed.data);
    else dropped++;
  }
  return { reply, actions, dropped };
}

/** Fuzzy part lookup: "left ventricle", "the aorta", "ventricle" → part. */
export function matchPart(text: string, parts: DeepDivePart[]): DeepDivePart | null {
  const t = text.toLowerCase().replace(/^(the|a|an|my)\s+/, "").replace(/[^a-z0-9 ]+/g, " ").trim();
  if (!t) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
  return (
    parts.find((p) => norm(p.name) === t || p.id === text) ??
    parts.find((p) => norm(p.name).includes(t)) ??
    parts.find((p) => t.includes(norm(p.name))) ??
    null
  );
}

/** 0.5 → 0.5, 50 → 0.5 (percent), clamped to 0..1. */
export function toFraction(v: number): number {
  return Math.max(0, Math.min(1, v > 1 ? v / 100 : v));
}
