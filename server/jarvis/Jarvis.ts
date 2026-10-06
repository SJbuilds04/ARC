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
import type { ArcAction, Attachment, DesktopAction, DeviceRole, ExecutionRecord, PendingAction, ServerMessage } from "../../shared/types";

/** How JARVIS talks to devices — implemented by the DeviceHub, so JARVIS never touches sockets. */
export interface Outbound {
  broadcast(msg: ServerMessage): void;
  sendTo(role: DeviceRole, msg: ServerMessage): boolean;
  isConnected(role: DeviceRole): boolean;
}

const CONFIRM_TIMEOUT_MS = 45_000;
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
  private pendingResolve: ((approved: boolean) => void) | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private speechGeneration = 0;

  constructor(
    private readonly core: ArcCore,
    private readonly ai: AIProvider,
    private readonly stt: SpeechToTextProvider,
    private readonly voice: VoiceProvider,
    private readonly executor: ActionExecutor,
    private readonly out: Outbound,
  ) {
    if (!voice.available) core.setService("voice", { status: "DEGRADED", engine: "BROWSER", detail: voice.unavailableReason });
    else core.setService("voice", { status: "ONLINE", engine: "GROQ" });
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
    if (this.core.getState().pending) this.resolvePending(false, "touch");
    this.core.setActivity("IDLE");
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
    for (const action of actions) {
      try {
        if (action.action === "SET_MODE") this.core.setMode(action.mode, device);
        else if (action.action === "SWITCH_CAMERA") this.core.switchCamera(action.to);
        else if (action.action === "EXIT_VISOR") this.core.exitVisor();
        else if (action.action === "SET_GAZE") this.core.setGazeInPlayground(action.enabled);
        else if (action.action === "RECALIBRATE_GAZE") this.recalibrateGaze();
        else if (isPlaygroundAction(action)) {
          if (!this.out.isConnected("PC")) {
            this.respond("The desktop display isn't connected, boss. Open ARC on the PC.", undefined, true);
            return;
          }
          if (this.core.getState().mode !== "PLAYGROUND") this.core.setMode("PLAYGROUND");
          this.out.sendTo("PC", { type: "PLAYGROUND_COMMAND", id: shortId(), command: action });
        } else if (isDesktopAction(action)) {
          await this.runDesktopAction(action);
        }
      } catch (err) {
        console.error("[jarvis] action failed:", action, err);
      }
    }
  }

  private async runDesktopAction(action: DesktopAction): Promise<void> {
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
      const approved = await this.awaitConfirmation({
        id: record.id,
        action: prepared.action,
        title: prepared.title,
        detail: prepared.detail,
        risk: decision.risk,
        holdMs: decision.holdMs,
        createdAt: Date.now(),
        expiresAt: Date.now() + CONFIRM_TIMEOUT_MS,
      });
      if (!approved) {
        stage("CANCELLED");
        this.respond("Cancelled, boss.");
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
    const { mode, visor } = this.core.getState();
    const target: DeviceRole | null = mode === "VISOR" ? visor.device : mode === "PLAYGROUND" && visor.gazeInPlayground ? "PC" : null;
    if (!target || !this.out.sendTo(target, { type: "VISOR_COMMAND", command: "RECALIBRATE" })) {
      this.respond("Gaze tracking isn't active, boss. Say activate visor first.");
    }
  }

  private awaitConfirmation(pending: PendingAction): Promise<boolean> {
    // Only one confirmation at a time: a newer request supersedes the old one.
    if (this.core.getState().pending) this.resolvePending(false, "touch");
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.core.setPending(pending);
      this.out.broadcast({ type: "CONFIRM_REQUEST", pending });
      this.pendingTimer = setTimeout(() => this.resolvePending(false, "touch"), CONFIRM_TIMEOUT_MS);
    });
  }

  private resolvePending(approved: boolean, via: "gesture" | "touch" | "voice"): void {
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
    resolve?.(approved);
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
        const { mime, data } = await jobs[seq];
        if (generation !== this.speechGeneration) return;
        this.out.sendTo(device, { type: "JARVIS_AUDIO", id, seq, last, mime, data: data.toString("base64") });
      } catch (err) {
        if (generation !== this.speechGeneration) return;
        this.out.sendTo(device, { type: "JARVIS_AUDIO", id, seq, last: true, failed: true, fallbackText: chunks.slice(seq).join(" ") });
        if (!this.voice.available) {
          this.core.setService("voice", { status: "DEGRADED", engine: "BROWSER", detail: this.voice.unavailableReason });
          console.warn(`[voice] server voice disabled: ${this.voice.unavailableReason}`);
        } else console.warn("[voice] synthesis failed:", (err as Error).message);
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
