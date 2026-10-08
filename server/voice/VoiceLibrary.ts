import { EventEmitter, once } from "node:events";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { VoiceInfo, VoiceState } from "../../shared/types";
import type { VoiceFiles } from "./PiperVoice";
import { describeVoice, folderListingUrl, isVoiceId, parseVoiceConfig, resolveVoiceSource, voiceFromListing } from "./piperVoices";

const run = promisify(execFile);

/** A voice is ~60 MB (medium) to ~120 MB (high); anything far bigger isn't a Piper voice. */
const MAX_VOICE_BYTES = 300 * 1024 * 1024;
const MAX_ENGINE_BYTES = 200 * 1024 * 1024;
const PIPER_RELEASE = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2";
const PIPER_BUILDS: Record<string, string> = {
  "win32-x64": "piper_windows_amd64.zip",
  "darwin-x64": "piper_macos_x64.tar.gz",
  "darwin-arm64": "piper_macos_aarch64.tar.gz",
  "linux-x64": "piper_linux_x86_64.tar.gz",
  "linux-arm64": "piper_linux_aarch64.tar.gz",
};
const ENGINE_LABEL = "Piper voice engine";

/** Stream a download to disk with progress, refusing anything over `max` bytes. */
async function downloadFile(url: string, target: string, max: number, onProgress: (p: number) => void): Promise<void> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok || !res.body) throw new Error(res.status === 404 ? "Couldn't find that file on Hugging Face." : `Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  if (total > max) throw new Error("That file is too big to be a voice.");
  const out = fs.createWriteStream(target);
  let got = 0;
  let reported = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      got += chunk.length;
      if (got > max) throw new Error("That file is too big to be a voice.");
      if (!out.write(chunk)) await once(out, "drain");
      if (total && Date.now() - reported > 250) {
        reported = Date.now();
        onProgress(got / total);
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()));
  }
  if (total && got < total) throw new Error("The download was cut short. Try again.");
}

/** Unpack a Piper release (zip on Windows, tar.gz elsewhere). Windows' own tar reads zips; Git's doesn't. */
async function extract(archive: string, dir: string): Promise<void> {
  if (process.platform === "win32") {
    const tar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    await run(tar, ["-xf", archive, "-C", dir], { windowsHide: true });
  } else {
    await run("tar", ["-xzf", archive, "-C", dir]);
  }
}

/**
 * JARVIS's installed voices: Piper .onnx + .onnx.json pairs in one folder. Adds voices from a
 * Hugging Face link or name (with progress), deletes them, and installs the Piper engine itself
 * when it's missing. Downloads only ever come from Hugging Face and GitHub's Piper release.
 */
export class VoiceLibrary extends EventEmitter<{ change: [] }> {
  voices: VoiceInfo[] = [];
  download: VoiceState["download"] = null;
  private readonly meta = new Map<string, VoiceFiles>();
  private busy = false;
  private clearTimer: NodeJS.Timeout | null = null;
  private engineFound: boolean;

  constructor(
    readonly dir: string,
    readonly piperDir: string,
  ) {
    super();
    fs.mkdirSync(dir, { recursive: true });
    this.engineFound = fs.existsSync(this.exe);
    this.scan();
  }

  get exe(): string {
    return path.join(this.piperDir, process.platform === "win32" ? "piper.exe" : "piper");
  }

  get engineReady(): boolean {
    return this.engineFound;
  }

  files(id: string): VoiceFiles | null {
    return this.meta.get(id) ?? null;
  }

  scan(): void {
    const voices: VoiceInfo[] = [];
    this.meta.clear();
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.toLowerCase().endsWith(".onnx")) continue;
      const id = f.slice(0, -5);
      const onnx = path.join(this.dir, f);
      const json = `${onnx}.json`;
      if (!isVoiceId(id) || !fs.existsSync(json)) continue;
      try {
        const cfg = parseVoiceConfig(JSON.parse(fs.readFileSync(json, "utf8")));
        if (!cfg) continue;
        const info = describeVoice(id, cfg, fs.statSync(onnx).size);
        voices.push(info);
        this.meta.set(id, { onnx, json, baseLength: cfg.inference?.length_scale ?? 1, name: info.name });
      } catch {
        // an unreadable config: skip that voice
      }
    }
    this.voices = voices.sort((a, b) => a.name.localeCompare(b.name));
    this.emit("change");
  }

  /** Add a voice from a Hugging Face link, the samples page, or a voice name. Resolves to the installed voice. */
  async add(source: string): Promise<VoiceInfo> {
    if (this.busy) throw new Error(`Still downloading ${this.download?.label ?? "a voice"}. One at a time.`);
    this.busy = true;
    let label = source.slice(0, 60);
    try {
      let resolved = resolveVoiceSource(source);
      if ("repo" in resolved) {
        const res = await fetch(folderListingUrl(resolved), { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(res.status === 404 ? "That Hugging Face folder doesn't exist." : `Hugging Face answered ${res.status}.`);
        resolved = voiceFromListing(resolved, (await res.json()) as { type: string; path: string }[]);
      }
      if ("error" in resolved) throw new Error(resolved.error);
      const src = resolved;
      label = src.id;
      const existing = this.voices.find((v) => v.id === src.id);
      if (existing) return existing;
      this.setDownload({ label, progress: 0 });
      const cfgRes = await fetch(src.json, { signal: AbortSignal.timeout(20_000) });
      if (!cfgRes.ok) throw new Error(cfgRes.status === 404 ? "Couldn't find that voice on Hugging Face." : `Hugging Face answered ${cfgRes.status}.`);
      const cfgText = await cfgRes.text();
      let cfg = null;
      try {
        cfg = parseVoiceConfig(JSON.parse(cfgText));
      } catch {
        // not JSON
      }
      if (!cfg) throw new Error("That isn't a Piper voice (its .onnx.json is missing or invalid).");
      const target = path.join(this.dir, `${src.id}.onnx`);
      const part = `${target}.part`;
      try {
        await downloadFile(src.onnx, part, MAX_VOICE_BYTES, (p) => this.setDownload({ label, progress: p }));
        fs.writeFileSync(`${target}.json`, cfgText);
        fs.renameSync(part, target);
      } finally {
        fs.rmSync(part, { force: true });
      }
      this.setDownload(null);
      this.scan();
      const added = this.voices.find((v) => v.id === src.id);
      if (!added) throw new Error("The voice downloaded but couldn't be read.");
      console.log(`[voice] added voice ${src.id}`);
      return added;
    } catch (err) {
      this.fail(label, err);
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Delete a voice's files. Stop anything using them first (Windows keeps open files locked). */
  delete(id: string): boolean {
    const f = this.meta.get(id);
    if (!f) return false;
    fs.rmSync(f.onnx, { force: true });
    fs.rmSync(f.json, { force: true });
    this.scan();
    return true;
  }

  /** Download and unpack the Piper engine if it isn't installed. True when it's ready. */
  async ensureEngine(): Promise<boolean> {
    if (this.engineReady) return true;
    const build = PIPER_BUILDS[`${process.platform}-${process.arch}`];
    if (!build || this.busy) return false;
    this.busy = true;
    const work = path.join(path.dirname(this.piperDir), ".piper-download");
    try {
      console.log("[voice] installing the Piper voice engine…");
      this.setDownload({ label: ENGINE_LABEL, progress: 0 });
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(work, { recursive: true });
      const archive = path.join(work, build);
      await downloadFile(`${PIPER_RELEASE}/${build}`, archive, MAX_ENGINE_BYTES, (p) => this.setDownload({ label: ENGINE_LABEL, progress: p }));
      await extract(archive, work);
      const unpacked = path.join(work, "piper");
      if (!fs.existsSync(unpacked)) throw new Error("The Piper download didn't contain the engine.");
      fs.rmSync(this.piperDir, { recursive: true, force: true });
      fs.renameSync(unpacked, this.piperDir);
      if (process.platform !== "win32") fs.chmodSync(this.exe, 0o755);
      this.engineFound = fs.existsSync(this.exe);
      this.setDownload(null);
      console.log("[voice] Piper installed");
      return this.engineReady;
    } catch (err) {
      this.fail(ENGINE_LABEL, err);
      console.warn("[voice] couldn't install Piper:", (err as Error).message);
      return false;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
      this.busy = false;
      this.emit("change");
    }
  }

  private setDownload(d: VoiceState["download"]): void {
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = null;
    this.download = d ? { ...d, progress: Math.round(d.progress * 100) / 100 } : null;
    this.emit("change");
  }

  /** Show the error for a while, then clear it. */
  private fail(label: string, err: unknown): void {
    this.setDownload({ label, progress: 0, error: (err as Error).message || "The download failed." });
    this.clearTimer = setTimeout(() => this.setDownload(null), 15_000);
    this.clearTimer.unref();
  }
}
