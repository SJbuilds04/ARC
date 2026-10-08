import type { ArcCore } from "../core/ArcCore";
import type { Outbound } from "../jarvis/Jarvis";
import type { DeviceRole } from "../../shared/types";
import type { PiperVoice } from "./PiperVoice";
import type { VoiceLibrary } from "./VoiceLibrary";

/** Replies JARVIS says all the time: made once per voice, then spoken instantly. */
const COMMON_REPLIES = [
  "Certainly, boss.",
  "Done, boss.",
  "Hello, boss.",
  "Online and ready, boss.",
  "Spinning, boss.",
  "Holding still, boss.",
  "Exploded view, boss.",
  "Reassembled, boss.",
  "Entering playground, boss.",
  "Command mode, boss.",
  "Activating ARC Visor, boss.",
  "Pick a model, boss.",
  "Leaving Deep Dive, boss.",
  "Checking, boss.",
  "Brighter, boss.",
  "Dimmer, boss.",
];

/**
 * The voice library on the screen: keeps the state in step with the voices folder, plays previews on
 * the device that asked, adds and deletes voices, and installs Piper + the default voice on first run.
 */
export class VoiceService {
  private warmedFor = "";

  constructor(
    private readonly core: ArcCore,
    private readonly library: VoiceLibrary,
    private readonly piper: PiperVoice,
    private readonly out: Outbound,
    private readonly defaultVoice: string,
  ) {
    library.on("change", () => this.sync());
    // A new voice, speed or pitch: load it now so the next reply doesn't wait for it.
    core.on("state", (s) => {
      const key = `${s.voice.id}|${s.voice.speed}|${s.voice.pitch}`;
      if (key !== this.warmedFor && this.library.files(s.voice.id)) {
        this.warmedFor = key;
        this.piper.warm(COMMON_REPLIES);
      }
    });
    this.sync();
  }

  /** First run: install Piper and the default voice if they're missing (in the background). */
  async boot(): Promise<void> {
    const engine = await this.library.ensureEngine();
    if (engine && !this.library.voices.length) {
      await this.library.add(this.defaultVoice).catch((err: Error) => console.warn(`[voice] couldn't download ${this.defaultVoice}:`, err.message));
    }
    this.sync();
  }

  async preview(device: DeviceRole, voiceId?: string): Promise<void> {
    const s = this.core.getState().voice;
    const id = voiceId && this.library.files(voiceId) ? voiceId : s.id;
    const name = this.library.files(id)?.name ?? "this";
    try {
      const { mime, data, rate } = await this.piper.speakWith({ id, speed: s.speed, pitch: s.pitch }, `All systems are online, boss. This is the ${name} voice.`, true);
      this.out.sendTo(device, { type: "VOICE_SAMPLE", voice: id, mime, data: data.toString("base64"), rate: rate ?? 1 });
    } catch (err) {
      this.out.sendTo(device, { type: "NOTIFY", level: "warning", title: "VOICE PREVIEW", text: (err as Error).message });
    }
  }

  async add(source: string, device: DeviceRole): Promise<void> {
    try {
      const voice = await this.library.add(source);
      this.out.sendTo(device, { type: "NOTIFY", level: "info", title: "VOICE ADDED", text: `${voice.name} is ready. Tap USE to make it JARVIS's voice.` });
    } catch (err) {
      this.out.sendTo(device, { type: "NOTIFY", level: "warning", title: "COULDN'T ADD VOICE", text: (err as Error).message });
    }
  }

  async remove(id: string, device: DeviceRole): Promise<void> {
    if (!this.library.files(id)) return;
    if (this.library.voices.length === 1) {
      this.out.sendTo(device, { type: "NOTIFY", level: "warning", title: "VOICE", text: "That's JARVIS's only voice. Add another before deleting it." });
      return;
    }
    await this.piper.forget(id);
    try {
      this.library.delete(id);
    } catch (err) {
      this.out.sendTo(device, { type: "NOTIFY", level: "warning", title: "VOICE", text: `Couldn't delete it: ${(err as Error).message}` });
    }
  }

  private sync(): void {
    const lib = this.library;
    this.core.setVoiceLibrary({ voices: lib.voices, engineReady: lib.engineReady, download: lib.download });
    // The chosen voice was deleted (or never installed): speak with one that is.
    const current = this.core.getState().voice.id;
    if (lib.voices.length && !lib.files(current)) {
      this.core.setVoice({ id: lib.files(this.defaultVoice) ? this.defaultVoice : lib.voices[0].id });
    }
  }
}
