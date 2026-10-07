import type { ServerMessageOf } from "@shared/types";
import type { ArcClient } from "../core/ArcClient";
import { ROLE } from "../core/device";
import { setLocal } from "../core/store";
import type { VoiceInput } from "./VoiceInput";

/** Male voices in preference order (British first — calm, JARVIS-like). */
const MALE_VOICES = [
  /Ryan.*Natural/i,
  /Thomas.*Natural/i,
  /Guy.*Natural/i,
  /Andrew.*Natural/i,
  /Brian.*Natural/i,
  /Christopher.*Natural/i,
  /Google UK English Male/i,
  /^Daniel/i,
  /^Arthur/i,
  /Microsoft George/i,
  /Microsoft David/i,
  /^Aaron/i,
  /^Alex$/i,
  /^Fred$/i,
  /male/i,
];

/**
 * JARVIS's voice on this device. Prefers the server voice (Groq, streamed in
 * sentence chunks and played gaplessly through Web Audio); falls back to the
 * browser's best male voice. Only the primary device speaks.
 */
export class VoiceOutput {
  private ctx: AudioContext | null = null;
  readonly analyser: AnalyserNode | null = null;
  private currentId: string | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private playhead = 0;
  private pendingChunks = new Map<number, ServerMessageOf<"JARVIS_AUDIO">>();
  private nextSeq = 0;
  private serverTimeout: number | null = null;
  private lastFull = "";
  private endTimer: number | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private primed = false;
  private watching = false;

  constructor(
    private readonly arc: ArcClient,
    private readonly mic: VoiceInput,
  ) {
    arc.on("JARVIS_RESPONSE", (msg) => this.onResponse(msg));
    arc.on("JARVIS_AUDIO", (msg) => this.onAudio(msg));
    if ("speechSynthesis" in window) {
      const pick = () => (this.voice = pickMaleVoice());
      pick();
      speechSynthesis.addEventListener?.("voiceschanged", pick);
    }
  }

  /** Unlock audio output. Must run inside a user gesture on mobile browsers. */
  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.connect(this.ctx.destination);
      (this as { analyser: AnalyserNode | null }).analyser = analyser;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    const silent = this.ctx.createBuffer(1, 1, 22050);
    const src = this.ctx.createBufferSource();
    src.buffer = silent;
    src.connect(this.ctx.destination);
    src.start();
    if ("speechSynthesis" in window) {
      speechSynthesis.getVoices();
      // iOS Safari only lets speech synthesis talk later if it was started once inside a tap.
      if (!this.primed) {
        this.primed = true;
        const u = new SpeechSynthesisUtterance(" ");
        u.volume = 0;
        speechSynthesis.speak(u);
      }
    }
    // iOS suspends (or "interrupts") the audio context when the app is backgrounded or the mic starts.
    if (!this.watching) {
      this.watching = true;
      const wake = () => this.ctx && this.ctx.state !== "running" && void this.ctx.resume().catch(() => undefined);
      document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && wake());
      window.addEventListener("pointerdown", wake, { capture: true, passive: true });
    }
  }

  stop(): void {
    this.currentId = null;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.sources = [];
    this.pendingChunks.clear();
    if (this.serverTimeout) clearTimeout(this.serverTimeout);
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    this.setSpeaking(false);
  }

  private onResponse(msg: ServerMessageOf<"JARVIS_RESPONSE">): void {
    if (msg.primary !== ROLE || msg.audio === "none") return;
    this.stop();
    this.currentId = msg.id;
    this.lastFull = msg.text;
    this.nextSeq = 0;
    if (this.ctx && this.ctx.state !== "running") void this.ctx.resume().catch(() => undefined);
    if (msg.audio === "browser" || !this.ctx) {
      this.speakBrowser(msg.text);
      return;
    }
    // If the server voice doesn't arrive promptly, don't leave the user waiting.
    this.serverTimeout = window.setTimeout(() => {
      if (this.currentId === msg.id && this.nextSeq === 0) this.speakBrowser(msg.text);
    }, 3500);
  }

  private onAudio(msg: ServerMessageOf<"JARVIS_AUDIO">): void {
    if (msg.id !== this.currentId) return;
    this.pendingChunks.set(msg.seq, msg);
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.pendingChunks.has(this.nextSeq)) {
      const chunk = this.pendingChunks.get(this.nextSeq)!;
      this.pendingChunks.delete(this.nextSeq);
      this.nextSeq++;
      if (this.serverTimeout) clearTimeout(this.serverTimeout);
      if (chunk.failed) {
        this.speakBrowser(chunk.fallbackText ?? (chunk.seq === 0 ? this.lastFull : ""));
        return;
      }
      await this.schedule(chunk);
    }
  }

  private async schedule(chunk: ServerMessageOf<"JARVIS_AUDIO">): Promise<void> {
    const ctx = this.ctx!;
    const id = chunk.id;
    const bytes = Uint8Array.from(atob(chunk.data!), (c) => c.charCodeAt(0));
    let buffer: AudioBuffer;
    try {
      buffer = await ctx.decodeAudioData(bytes.buffer);
    } catch (err) {
      // Undecodable audio: say it with the browser voice rather than staying silent.
      console.warn("[voice] could not decode server audio:", err);
      if (id === this.currentId && chunk.seq === 0) this.speakBrowser(this.lastFull);
      return;
    }
    if (id !== this.currentId) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.analyser!);
    const start = Math.max(ctx.currentTime + 0.02, this.playhead);
    src.start(start);
    this.playhead = start + buffer.duration;
    this.sources.push(src);
    this.setSpeaking(true);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
      if (!this.sources.length && this.pendingChunks.size === 0) this.scheduleEnd();
    };
  }

  private speakBrowser(text: string): void {
    if (!text || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    this.voice = this.voice ?? pickMaleVoice();
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang ?? "en-GB";
    u.rate = 1.02;
    u.pitch = 0.88;
    u.onstart = () => this.setSpeaking(true);
    u.onend = () => this.scheduleEnd();
    u.onerror = () => this.scheduleEnd();
    speechSynthesis.speak(u);
  }

  private scheduleEnd(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = window.setTimeout(() => this.setSpeaking(false), 150);
  }

  private setSpeaking(on: boolean): void {
    if (on && this.endTimer) clearTimeout(this.endTimer);
    setLocal({ speaking: on });
    // VoiceInput ignores audio while `speaking`; also stay deaf briefly after so the voice tail isn't picked up.
    if (!on) this.mic.suspendFor(450);
    this.arc.send({ type: "JARVIS_ACTIVITY", activity: on ? "SPEAKING" : "IDLE" });
  }
}

function pickMaleVoice(): SpeechSynthesisVoice | null {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("en"));
  for (const re of MALE_VOICES) {
    const v = voices.find((x) => re.test(x.name));
    if (v) return v;
  }
  return null;
}
