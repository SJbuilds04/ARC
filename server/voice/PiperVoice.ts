import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Synthesis, VoiceProvider } from "./VoiceProvider";
import { voiceTiming } from "./piperVoices";

const TIMEOUT_MS = 15_000;
/** The first line also loads the model (~5 s on a slow PC). */
const FIRST_TIMEOUT_MS = 40_000;
/** Workers for voices/speeds no longer in use are stopped after this long idle. */
const IDLE_MS = 90_000;
/** The current voice, a stand-in while a new speed loads, and one being previewed. */
const MAX_WORKERS = 3;
const TMP = path.join(os.tmpdir(), "arc-voice");

export interface VoiceFiles {
  onnx: string;
  json: string;
  /** The voice's own default phoneme length (from its config). */
  baseLength: number;
  name: string;
}

export interface VoiceSettings {
  id: string;
  speed: number;
  pitch: number;
}

/** Where Piper and the voices are (the voice library). */
export interface PiperInstall {
  readonly exe: string;
  readonly engineReady: boolean;
  files(id: string): VoiceFiles | null;
}

interface Job {
  text: string;
  file: string;
  timeoutMs: number;
  resolve: (data: Buffer) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

/**
 * One long-lived piper process for one voice at one speed: the model loads once, then each line of
 * JSON on stdin becomes a WAV file. Text is always data on stdin, never a command argument.
 * One line at a time, real speech first: pre-made common replies wait until it's idle.
 */
class PiperWorker {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly urgent: Job[] = [];
  private readonly background: Job[] = [];
  private inFlight: Job | null = null;
  private seq = 0;
  private stopping = false;
  private exited: Promise<void>;
  readonly ready: Promise<void>;
  isReady = false;
  dead = false;
  crashed = false;
  /** This worker's crash has been counted (several lines fail together when one process dies). */
  counted = false;
  lastUsed = Date.now();

  constructor(
    readonly key: string,
    exe: string,
    files: VoiceFiles,
    lengthScale: number,
    /** Playback rate this worker's speech is timed for. */
    readonly rate: number,
    onReady: () => void,
  ) {
    fs.mkdirSync(TMP, { recursive: true });
    // a short pause between sentences (Piper's default 0.2 s makes a quick reply drag)
    this.proc = spawn(exe, ["--model", files.onnx, "--config", files.json, "--json-input", "--quiet", "--length_scale", String(lengthScale), "--sentence_silence", "0.08"], {
      cwd: path.dirname(exe),
      windowsHide: true,
    });
    createInterface({ input: this.proc.stdout }).on("line", () => this.finishNext());
    this.proc.stderr.on("data", (d) => {
      const text = String(d).trim();
      if (text) console.warn("[voice] piper:", text.slice(0, 200));
    });
    this.exited = new Promise((resolve) => this.proc.on("exit", () => resolve()));
    this.proc.on("exit", (code) => this.die(`Piper exited (${code})`));
    this.proc.on("error", (err) => this.die(err.message));
    this.proc.stdin.on("error", () => undefined); // a dead process shouldn't crash ARC on write
    this.ready = this.run("Ready.", FIRST_TIMEOUT_MS, false).then(() => {
      this.isReady = true;
      onReady();
    });
    this.ready.catch(() => undefined);
  }

  /** `background`: a pre-made reply — it waits until no real speech is queued. */
  say(text: string, background = false): Promise<Buffer> {
    this.lastUsed = Date.now();
    return this.ready.then(() => this.run(text, TIMEOUT_MS, background));
  }

  private run(text: string, timeoutMs: number, background: boolean): Promise<Buffer> {
    if (this.dead) return Promise.reject(new Error("Piper isn't running"));
    const file = path.join(TMP, `${process.pid}-${this.key.replace(/[^\w.-]+/g, "_")}-${++this.seq}.wav`);
    return new Promise<Buffer>((resolve, reject) => {
      (background ? this.background : this.urgent).push({ text, file, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  /** Hand Piper the next line (real speech before pre-made replies), one at a time. */
  private pump(): void {
    if (this.inFlight || this.dead) return;
    const job = this.urgent.shift() ?? this.background.shift();
    if (!job) return;
    this.inFlight = job;
    job.timer = setTimeout(() => {
      // a stuck line means the process is stuck — restart it
      this.die("Piper timed out");
      this.proc.kill();
    }, job.timeoutMs);
    this.proc.stdin.write(JSON.stringify({ text: job.text.replace(/\s+/g, " "), output_file: job.file }) + "\n");
  }

  private finishNext(): void {
    const job = this.inFlight;
    this.inFlight = null;
    if (!job) return;
    clearTimeout(job.timer);
    fs.promises
      .readFile(job.file)
      .then((data) => job.resolve(data), (err: Error) => job.reject(err))
      .finally(() => fs.promises.rm(job.file, { force: true }).catch(() => undefined));
    this.pump();
  }

  private die(reason: string): void {
    if (!this.dead) this.crashed = !this.stopping;
    this.dead = true;
    for (const job of [this.inFlight, ...this.urgent, ...this.background]) {
      if (!job) continue;
      clearTimeout(job.timer);
      job.reject(new Error(reason));
    }
    this.inFlight = null;
    this.urgent.length = 0;
    this.background.length = 0;
  }

  /** Resolves once the process is gone (its voice files can be deleted then). */
  stop(): Promise<void> {
    this.stopping = true;
    if (!this.dead) this.proc.kill();
    this.die("Piper stopped");
    return this.exited;
  }
}

/** Least-recently-used cache: common short replies are spoken instantly the second time. */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly max: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  deleteWhere(test: (key: string) => boolean): void {
    for (const k of [...this.map.keys()]) if (test(k)) this.map.delete(k);
  }
}

/**
 * JARVIS's voice: Piper neural speech, offline on this PC (~10× faster than real time even on a
 * 2-core laptop). Speed/pitch changes start a new worker in the background while the old one keeps
 * talking, so a reply never waits for a model load.
 */
export class PiperVoice implements VoiceProvider {
  readonly name = "piper";
  readonly engine = "PIPER";
  private readonly workers = new Map<string, PiperWorker>();
  private readonly cache = new LruCache<Synthesis>(160);
  private crashes = 0;
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly lib: PiperInstall,
    private readonly settings: () => VoiceSettings,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  get engineReady(): boolean {
    return this.lib.engineReady;
  }

  private files(id: string): VoiceFiles | null {
    return this.lib.files(id);
  }

  get available(): boolean {
    return this.engineReady && this.files(this.settings().id) !== null && this.crashes < 5;
  }

  get unavailableReason(): string | undefined {
    if (!this.engineReady) return "Piper isn't installed yet (run npm run setup)";
    const id = this.settings().id;
    if (!this.files(id)) return `The voice ${id} isn't installed`;
    if (this.crashes >= 5) return "Piper keeps crashing";
    return undefined;
  }

  /** Name of the voice JARVIS speaks with ("Bryce"). */
  get voiceName(): string | undefined {
    return this.files(this.settings().id)?.name;
  }

  synthesize(text: string): Promise<Synthesis> {
    return this.speakWith(this.settings(), text);
  }

  /**
   * Speak with any installed voice at the given speed and pitch. `exact`: never use a stand-in worker
   * (previews must sound like the new setting). `background`: a pre-made reply, after real speech.
   */
  async speakWith(s: VoiceSettings, text: string, exact = false, background = false): Promise<Synthesis> {
    const files = this.files(s.id);
    if (!this.engineReady || !files) throw new Error(this.engineReady ? `The voice ${s.id} isn't installed` : "Piper isn't installed yet");
    const { lengthScale, rate } = voiceTiming(s.speed, s.pitch, files.baseLength);
    const key = `${s.id}|${lengthScale}`;
    const cacheKey = `${key}|${text}`;
    const hit = this.cache.get(cacheKey);
    if (hit) return hit;
    const worker = this.pick(key, files, lengthScale, rate, exact);
    try {
      const data = await worker.say(text, background);
      this.crashes = 0;
      const out: Synthesis = { mime: "audio/wav", data, rate: worker.rate };
      if (worker.key === key && text.length <= 120) this.cache.set(cacheKey, out);
      return out;
    } catch (err) {
      if (worker.crashed && !worker.counted) {
        worker.counted = true;
        this.crashes++;
      }
      throw err;
    }
  }

  /** Load the current voice now and pre-make common replies, so the next ones are instant. */
  warm(phrases: string[] = []): void {
    const s = this.settings();
    const files = this.files(s.id);
    if (!this.engineReady || !files) return;
    const { lengthScale, rate } = voiceTiming(s.speed, s.pitch, files.baseLength);
    this.pick(`${s.id}|${lengthScale}`, files, lengthScale, rate, true);
    for (const p of phrases) void this.speakWith(s, p, true, true).catch(() => undefined);
  }

  /** Stop everything using a voice (before its files are deleted). */
  async forget(id: string): Promise<void> {
    const stopping: Promise<void>[] = [];
    for (const [k, w] of this.workers) {
      if (!k.startsWith(`${id}|`)) continue;
      stopping.push(w.stop());
      this.workers.delete(k);
    }
    this.cache.deleteWhere((k) => k.startsWith(`${id}|`));
    await Promise.all(stopping);
  }

  stop(): void {
    clearInterval(this.sweeper);
    for (const w of this.workers.values()) void w.stop();
    this.workers.clear();
  }

  /** The worker for this voice+speed; while a new one loads, a running one for the same voice answers. */
  private pick(key: string, files: VoiceFiles, lengthScale: number, rate: number, exact: boolean): PiperWorker {
    let w = this.workers.get(key);
    if (!w || w.dead) {
      w = new PiperWorker(key, this.lib.exe, files, lengthScale, rate, () => this.trim(key));
      this.workers.set(key, w);
      this.trim(key);
    }
    w.lastUsed = Date.now();
    if (w.isReady || exact) return w;
    const voice = key.slice(0, key.lastIndexOf("|"));
    for (const other of this.workers.values()) {
      if (other !== w && other.isReady && !other.dead && other.key.startsWith(`${voice}|`)) {
        other.lastUsed = Date.now();
        return other;
      }
    }
    return w;
  }

  private currentKey(): string {
    const s = this.settings();
    const files = this.files(s.id);
    return files ? `${s.id}|${voiceTiming(s.speed, s.pitch, files.baseLength).lengthScale}` : "";
  }

  /**
   * At most three live workers (each holds a model in memory): the current voice, the newest, and —
   * while the current one is still loading — a ready stand-in for the same voice so replies never wait.
   */
  private trim(newest: string): void {
    const current = this.currentKey();
    for (const [k, w] of this.workers) if (w.dead) this.workers.delete(k);
    const keep = new Set([newest, current]);
    const cur = this.workers.get(current);
    if (cur && !cur.isReady) {
      const voice = current.slice(0, current.lastIndexOf("|"));
      const standIn = [...this.workers.values()].filter((w) => w.isReady && w.key.startsWith(`${voice}|`)).sort((a, b) => b.lastUsed - a.lastUsed)[0];
      if (standIn) keep.add(standIn.key);
    }
    const spare = [...this.workers.values()].filter((w) => !keep.has(w.key)).sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.workers.size > MAX_WORKERS && spare.length) {
      const w = spare.shift()!;
      void w.stop();
      this.workers.delete(w.key);
    }
  }

  private sweep(): void {
    const current = this.currentKey();
    for (const [k, w] of this.workers) {
      if (w.dead || (k !== current && Date.now() - w.lastUsed > IDLE_MS)) {
        void w.stop();
        this.workers.delete(k);
      }
    }
  }
}
