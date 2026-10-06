import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../config";

/**
 * Tiny JSON persistence for ARC's durable state (history, scene, notes, paired devices).
 * Writes are debounced and atomic (write temp file, then rename).
 */
export class JsonStore<T> {
  private readonly file: string;
  private timer: NodeJS.Timeout | null = null;
  private pending: T | null = null;

  constructor(name: string) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.file = path.join(DATA_DIR, name);
  }

  load(fallback: T): T {
    try {
      return { ...fallback, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch {
      return fallback;
    }
  }

  save(value: T, delayMs = 400): void {
    this.pending = value;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending === null) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.pending, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[store] failed to write ${this.file}:`, err);
    }
    this.pending = null;
  }
}
