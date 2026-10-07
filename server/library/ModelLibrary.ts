import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { DATA_DIR, config } from "../config";
import { JsonStore } from "../core/store";
import type { CustomLabel, LibraryModel, ModelFormat } from "../../shared/types";

export const MODEL_EXTENSIONS: Record<string, ModelFormat> = { ".glb": "glb", ".gltf": "gltf", ".obj": "obj", ".stl": "stl", ".fbx": "fbx" };

interface PersistedLibrary {
  models: LibraryModel[];
  /** Thumbnail versions by model id (built-in and imported). */
  thumbs: Record<string, number>;
  /** Built-in models were remade at this epoch: older thumbnails of them are dropped. */
  thumbEpoch?: number;
}

/** Bump when built-in models get a new look, listing the ones whose thumbnails must be redone. */
const THUMB_EPOCH = 2;
const REMADE = ["mark3", "mark42", "mark50", "mark85", "hulkbuster", "arc_reactor", "arc_reactor2", "spider_classic", "iron_spider", "black_hole"];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "model";

/** "heart_anatomy-v2.glb" → "Heart Anatomy V2" */
export function prettyName(file: string): string {
  return path
    .basename(file, path.extname(file))
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 60) || "Model";
}

/** Keep only a safe file name (no directories, no reserved characters). */
export function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[<>:"/\\|?*\x00-\x1f]+/g, "_").replace(/^\.+/, "").trim();
  return base.slice(0, 120) || `file-${Date.now()}`;
}

/**
 * The 3D model library: every model file in the models folder (dropped there, dragged onto
 * the PC, or uploaded from the phone), plus per-model metadata — labels, part functions,
 * thumbnails. Built-in models live in the catalog; only their thumbnails are stored here.
 */
export class ModelLibrary extends EventEmitter<{ change: [] }> {
  readonly dir = config.modelsDir;
  readonly thumbsDir = path.join(DATA_DIR, "thumbs");
  private readonly store = new JsonStore<PersistedLibrary>("library.json");
  private readonly data: PersistedLibrary;
  private scanTimer: NodeJS.Timeout | null = null;

  constructor() {
    super();
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.thumbsDir, { recursive: true });
    this.data = this.store.load({ models: [], thumbs: {} });
    if ((this.data.thumbEpoch ?? 1) < THUMB_EPOCH) {
      // these models look different now: their thumbnails are re-rendered by the PC
      for (const id of REMADE) {
        delete this.data.thumbs[id];
        fs.rmSync(path.join(this.thumbsDir, `${id}.png`), { force: true });
      }
      this.data.thumbEpoch = THUMB_EPOCH;
      this.save();
    }
    this.scan();
    try {
      // Files copied into the folder show up on their own (debounced: copies take a moment).
      fs.watch(this.dir, () => this.scheduleScan()).on("error", () => undefined);
    } catch {
      // watching is a convenience; uploads still rescan
    }
  }

  get models(): LibraryModel[] {
    return this.data.models;
  }

  /** Thumbnail URLs for the UI, keyed by model id. */
  thumbs(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, v] of Object.entries(this.data.thumbs)) out[id] = `/api/thumbs/${encodeURIComponent(id)}.png?v=${v}`;
    return out;
  }

  get(id: string): LibraryModel | undefined {
    return this.data.models.find((m) => m.id === id);
  }

  /** "my drone", "drone", "m-drone" → model. Longest name match wins. */
  resolve(text: string): LibraryModel | null {
    const t = ` ${text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()} `;
    const byId = this.data.models.find((m) => m.id === text.trim());
    if (byId) return byId;
    let best: { m: LibraryModel; len: number } | null = null;
    for (const m of this.data.models) {
      const name = m.name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").trim();
      if (name && t.includes(` ${name} `) && (!best || name.length > best.len)) best = { m, len: name.length };
      // also match on the first word of multi-word names ("heart" for "Heart Anatomy")
      const first = name.split(" ")[0];
      if (first.length >= 4 && t.includes(` ${first} `) && !best) best = { m, len: first.length };
    }
    return best?.m ?? null;
  }

  isModelFile(name: string): boolean {
    return path.extname(name).toLowerCase() in MODEL_EXTENSIONS;
  }

  /** Save an uploaded model file and add it to the library. */
  add(fileName: string, tmpPath: string): LibraryModel {
    const name = safeFileName(fileName);
    let target = path.join(this.dir, name);
    for (let i = 2; fs.existsSync(target); i++) target = path.join(this.dir, `${path.basename(name, path.extname(name))}-${i}${path.extname(name)}`);
    fs.renameSync(tmpPath, target);
    this.scan();
    return this.data.models.find((m) => m.file === path.basename(target))!;
  }

  delete(id: string): boolean {
    const m = this.get(id);
    if (!m) return false;
    try {
      fs.rmSync(path.join(this.dir, m.file), { force: true });
      fs.rmSync(path.join(this.thumbsDir, `${id}.png`), { force: true });
    } catch (err) {
      console.warn("[library] delete failed:", (err as Error).message);
    }
    this.data.models = this.data.models.filter((x) => x.id !== id);
    delete this.data.thumbs[id];
    this.save();
    return true;
  }

  rename(id: string, name: string): void {
    const m = this.get(id);
    if (!m) return;
    m.name = name.slice(0, 60);
    this.save();
  }

  setThumb(id: string, png: Buffer): void {
    fs.writeFileSync(path.join(this.thumbsDir, `${id}.png`), png);
    this.data.thumbs[id] = Date.now();
    this.save();
  }

  thumbPath(id: string): string | null {
    const file = path.join(this.thumbsDir, `${path.basename(id)}.png`);
    return fs.existsSync(file) ? file : null;
  }

  addLabel(id: string, name: string, pos: [number, number, number]): CustomLabel | null {
    const m = this.get(id);
    if (!m) return null;
    const label: CustomLabel = { id: randomUUID().slice(0, 8), name, pos };
    m.labels.push(label);
    if (m.labels.length > 60) m.labels.shift();
    this.save();
    return label;
  }

  removeLabel(id: string, labelId: string): void {
    const m = this.get(id);
    if (!m) return;
    m.labels = m.labels.filter((l) => l.id !== labelId);
    this.save();
  }

  setPartInfo(id: string, info: Record<string, string>): void {
    const m = this.get(id);
    if (!m) return;
    m.partInfo = { ...m.partInfo, ...info };
    for (const l of m.labels) if (info[l.name] && !l.info) l.info = info[l.name];
    this.save();
  }

  /** Sync the index with the folder: new files are added, missing ones dropped. */
  scan(): void {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => this.isModelFile(f) && fs.statSync(path.join(this.dir, f)).isFile());
    } catch {
      return;
    }
    let changed = false;
    const present = new Set(files);
    const before = this.data.models.length;
    this.data.models = this.data.models.filter((m) => present.has(m.file));
    if (this.data.models.length !== before) changed = true;
    for (const file of files) {
      const existing = this.data.models.find((m) => m.file === file);
      const size = fs.statSync(path.join(this.dir, file)).size;
      if (existing) {
        if (existing.size !== size) {
          existing.size = size;
          changed = true;
        }
        continue;
      }
      let id = `m-${slug(file)}`;
      for (let i = 2; this.data.models.some((m) => m.id === id); i++) id = `m-${slug(file)}-${i}`;
      this.data.models.push({
        id,
        name: prettyName(file),
        file,
        format: MODEL_EXTENSIONS[path.extname(file).toLowerCase()],
        size,
        addedAt: Date.now(),
        labels: [],
        partInfo: {},
      });
      console.log(`[library] added ${file}`);
      changed = true;
    }
    if (changed) this.save();
  }

  private scheduleScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => this.scan(), 1500);
  }

  private save(): void {
    this.store.save(this.data);
    this.emit("change");
  }

  flush(): void {
    this.store.flush();
  }
}
