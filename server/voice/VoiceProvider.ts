import { AIError } from "../ai/AIProvider";
import { groqError, groqFetch } from "../ai/GroqProvider";

/** Synthesized speech. `rate` is the playback rate it was timed for (pitch; 1 = as is). */
export interface Synthesis {
  mime: string;
  data: Buffer;
  rate?: number;
}

export type VoiceEngine = "PIPER" | "GROQ" | "LOCAL";

/**
 * Text-to-speech, decoupled from JARVIS and the UI. When no server voice is
 * available the client falls back to the browser's male system voice.
 */
export interface VoiceProvider {
  readonly name: string;
  readonly available: boolean;
  readonly unavailableReason?: string;
  /** Which engine is speaking right now (for the status HUD). */
  readonly engine?: VoiceEngine;
  /** The voice speaking right now ("Bryce"), when the engine has named voices. */
  readonly voiceName?: string;
  synthesize(text: string): Promise<Synthesis>;
}

/**
 * Voices in order of preference: the first available one speaks, and when it fails on a chunk
 * the next one says it instead (Piper → Groq → Windows), so JARVIS is never silent.
 */
export class VoiceChain implements VoiceProvider {
  constructor(private readonly providers: VoiceProvider[]) {}

  private get first(): VoiceProvider | undefined {
    return this.providers.find((p) => p.available);
  }

  get name(): string {
    return this.first?.name ?? "none";
  }

  get available(): boolean {
    return this.first !== undefined;
  }

  get unavailableReason(): string | undefined {
    return this.available ? undefined : this.providers.map((p) => p.unavailableReason).filter(Boolean).join("; ");
  }

  get engine(): VoiceEngine {
    return this.first?.engine ?? "LOCAL";
  }

  get voiceName(): string | undefined {
    return this.first?.voiceName;
  }

  async synthesize(text: string): Promise<Synthesis> {
    let last: unknown = new Error("No voice available");
    for (const p of this.providers) {
      if (!p.available) continue;
      try {
        return await p.synthesize(text);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }
}

/** JARVIS's male voice via Groq (Orpheus). */
export class GroqVoice implements VoiceProvider {
  readonly name = "groq-orpheus";
  readonly engine = "GROQ";
  private disabledReason: string | undefined;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly voice: string,
  ) {
    if (!apiKey) this.disabledReason = "GROQ_API_KEY is not set";
  }

  get available(): boolean {
    return !this.disabledReason;
  }

  get unavailableReason(): string | undefined {
    return this.disabledReason;
  }

  async synthesize(text: string): Promise<Synthesis> {
    if (this.disabledReason) throw new AIError(this.disabledReason, "UNCONFIGURED");
    const res = await groqFetch(
      this.apiKey,
      "/audio/speech",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, voice: this.voice, input: text, response_format: "wav" }),
      },
      15_000,
    );
    if (!res.ok) {
      const err = await groqError(res);
      // Permanent problems: stop trying for this session so every reply isn't delayed.
      if (err.code === "TERMS" || err.code === "AUTH" || (err.code === "BAD_REQUEST" && /model|voice/i.test(err.message))) {
        this.disabledReason =
          err.code === "TERMS" ? "Accept the Orpheus model terms in the Groq console to enable JARVIS's voice" : err.message;
      }
      throw err;
    }
    return { mime: "audio/wav", data: Buffer.from(await res.arrayBuffer()) };
  }
}

/** Split long replies into sentence chunks the TTS model accepts. */
export function chunkForSpeech(text: string, max = 190): string[] {
  const clean = text.replace(/[*_`#>]+/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [clean];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences.map((x) => x.trim())) {
    if (s.length > max) {
      if (current) chunks.push(current);
      current = "";
      for (const part of s.match(new RegExp(`.{1,${max}}(\\s|$)`, "g")) ?? [s]) chunks.push(part.trim());
      continue;
    }
    if ((current + " " + s).trim().length > max) {
      chunks.push(current);
      current = s;
    } else current = (current + " " + s).trim();
  }
  if (current) chunks.push(current);
  return chunks.filter(Boolean);
}
