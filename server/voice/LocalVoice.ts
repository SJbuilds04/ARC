import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { Synthesis, VoiceProvider } from "./VoiceProvider";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "winspeech.ps1");
const TIMEOUT_MS = 12_000;

/**
 * JARVIS's backup voice: the Windows speech engine (a British male voice when installed),
 * synthesised on the ARC machine and streamed to whichever device speaks, like Piper.
 * One long-lived PowerShell worker; text is sent as JSON on stdin, never as a command argument.
 */
export class LocalVoice implements VoiceProvider {
  readonly name = "windows-speech";
  readonly engine = "LOCAL";
  private worker: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private waiting = new Map<string, { resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private seq = 0;
  private failures = 0;
  private disabledReason: string | undefined;
  voiceName = "";

  constructor(private readonly preferred: string) {
    if (process.platform !== "win32") this.disabledReason = "Local voice needs Windows";
    else if (/^(off|none|false)$/i.test(preferred)) this.disabledReason = "Local voice disabled (ARC_LOCAL_VOICE=off)";
  }

  get available(): boolean {
    return !this.disabledReason;
  }

  get unavailableReason(): string | undefined {
    return this.disabledReason;
  }

  /** Start the worker early so the first reply isn't delayed by PowerShell start-up. */
  warm(): void {
    if (this.available) void this.start().catch(() => undefined);
  }

  async synthesize(text: string): Promise<Synthesis> {
    if (this.disabledReason) throw new Error(this.disabledReason);
    await this.start();
    const id = `v${++this.seq}`;
    const data = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error("Local voice timed out"));
      }, TIMEOUT_MS);
      this.waiting.set(id, { resolve, reject, timer });
      this.worker!.stdin.write(JSON.stringify({ id, text }) + "\n");
    });
    return { mime: "audio/wav", data };
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const worker = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, this.preferred], {
        windowsHide: true,
      });
      this.worker = worker;
      const lines = createInterface({ input: worker.stdout });
      let started = false;
      lines.on("line", (line) => {
        if (!started && line.startsWith("ready ")) {
          started = true;
          this.voiceName = line.split(" ").slice(2).join(" ");
          console.log(`[voice] local voice ready: ${this.voiceName}`);
          resolve();
          return;
        }
        const [id, status, ...rest] = line.split(" ");
        const job = this.waiting.get(id);
        if (!job) return;
        this.waiting.delete(id);
        clearTimeout(job.timer);
        if (status === "ok") job.resolve(Buffer.from(rest.join(""), "base64"));
        else job.reject(new Error(rest.join(" ") || "Local voice failed"));
      });
      worker.stderr.on("data", (d) => console.warn("[voice] local voice:", String(d).trim().slice(0, 200)));
      worker.on("error", (err) => {
        if (!started) reject(err);
      });
      worker.on("exit", (code) => {
        this.worker = null;
        this.ready = null;
        for (const [, job] of this.waiting) {
          clearTimeout(job.timer);
          job.reject(new Error("Local voice worker exited"));
        }
        this.waiting.clear();
        if (!started) reject(new Error(`Local voice worker exited (${code})`));
        // Give up after repeated crashes rather than respawning forever.
        if (++this.failures >= 3) this.disabledReason = "Local voice worker keeps crashing";
      });
    });
    return this.ready;
  }

  stop(): void {
    this.worker?.kill();
  }
}
