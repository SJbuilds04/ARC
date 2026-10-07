import type { Hand } from "@shared/types";
import { HandTracker } from "../gestures/HandTracker";
import { FaceTracker, type FaceFrame, type Point3 } from "../visor/FaceTracker";

export type Model = "hands" | "face";

/** A loadable model as seen by the rest of the app (`vision.tracker`, `vision.faceModel`). */
export interface ModelHandle {
  readonly ready: boolean;
  readonly error: string | null;
  /** Where inference runs and on what. */
  readonly where: string;
  load(): Promise<void>;
}

/** Person-segmentation mask (0..255 confidence) for the same frame as the face. */
export interface PersonMask {
  data: Uint8Array;
  w: number;
  h: number;
}

export interface FaceResult {
  face: FaceFrame | null;
  mask?: PersonMask | null;
  /** The exact frame the landmarks belong to (worker path), for drift-free drawing. */
  bitmap: ImageBitmap | null;
  ms: number;
}

/** One model's runner (worker or main thread). */
interface Runner<R> {
  readonly delegate: "GPU" | "CPU" | null;
  readonly kind: "worker" | "main";
  load(): Promise<void>;
  run(video: HTMLVideoElement, ts: number, aspect: number): Promise<R>;
  setNumHands?(n: number): void;
  dispose(): void;
}

const ABS = (p: string) => new URL(p, location.origin).href;

class WorkerRunner<R> implements Runner<R> {
  readonly kind = "worker" as const;
  delegate: "GPU" | "CPU" | null = null;
  private worker = new Worker(new URL("./vision.worker.ts", import.meta.url));
  private nextId = 1;
  private pending = new Map<number, (m: Record<string, unknown>) => void>();
  private loadWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(
    private readonly model: Model,
    private readonly decode: (m: Record<string, unknown>, aspect: number) => R,
    private readonly opts: { resize?: number; returnBitmap?: boolean } = {},
  ) {
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "loaded") {
        this.delegate = m.delegate;
        this.loadWaiter?.resolve();
      } else if (m.type === "load-error") this.loadWaiter?.reject(new Error(m.error));
      else if (m.type === "result") {
        const done = this.pending.get(m.id);
        this.pending.delete(m.id);
        done?.(m);
      }
    };
    this.worker.onerror = (e) => this.loadWaiter?.reject(new Error(e.message || "Vision worker crashed"));
  }

  load(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.loadWaiter = { resolve, reject };
      this.worker.postMessage({ type: "load", model: this.model, base: ABS("/mediapipe"), assets: ABS("/models") });
    });
  }

  async run(video: HTMLVideoElement, ts: number, aspect: number): Promise<R> {
    const w = video.videoWidth;
    const h = video.videoHeight;
    const scale = this.opts.resize && w > this.opts.resize ? this.opts.resize / w : 1;
    const bitmap = scale < 1 ? await createImageBitmap(video, { resizeWidth: Math.round(w * scale), resizeHeight: Math.round(h * scale), resizeQuality: "low" }) : await createImageBitmap(video);
    const id = this.nextId++;
    const m = await new Promise<Record<string, unknown>>((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ type: "frame", id, ts, bitmap, returnBitmap: this.opts.returnBitmap }, [bitmap]);
    });
    return this.decode(m, aspect);
  }

  setNumHands(n: number): void {
    this.worker.postMessage({ type: "options", numHands: n });
  }

  dispose(): void {
    this.worker.terminate();
  }
}

let segWarned = false;
function decodeFace(m: Record<string, unknown>, aspect: number): FaceResult {
  if (m.segError && !segWarned) {
    segWarned = true;
    console.warn("[vision] person segmentation failed:", m.segError);
  }
  const f = m.face as { points: Float32Array; blinkLeft: number; blinkRight: number; jawOpen: number; matrix: number[] | null } | null | undefined;
  let face: FaceFrame | null = null;
  if (f) {
    const a = f.points;
    const points: Point3[] = new Array(a.length / 3);
    for (let i = 0; i < points.length; i++) points[i] = { x: a[i * 3], y: a[i * 3 + 1], z: a[i * 3 + 2] };
    face = { t: performance.now(), points, blinkLeft: f.blinkLeft, blinkRight: f.blinkRight, jawOpen: f.jawOpen, matrix: f.matrix, aspect };
  }
  return { face, mask: (m.mask as PersonMask | undefined) ?? null, bitmap: (m.bitmap as ImageBitmap | undefined) ?? null, ms: (m.ms as number) ?? 0 };
}

class MainHands implements Runner<Hand[]> {
  readonly kind = "main" as const;
  private t = new HandTracker();
  get delegate() {
    return this.t.delegate;
  }
  load() {
    return this.t.load();
  }
  async run(video: HTMLVideoElement, ts: number) {
    return this.t.detect(video, ts);
  }
  setNumHands(n: number) {
    this.t.setNumHands(n);
  }
  dispose() {}
}

class MainFace implements Runner<FaceResult> {
  readonly kind = "main" as const;
  private t = new FaceTracker();
  get delegate() {
    return this.t.delegate;
  }
  load() {
    return this.t.load();
  }
  async run(video: HTMLVideoElement, ts: number, aspect: number) {
    const t0 = performance.now();
    return { face: this.t.detect(video, ts, aspect), bitmap: null, ms: performance.now() - t0 };
  }
  dispose() {}
}

/**
 * Picks the fastest runner for a model:
 *   worker + GPU  → best (inference never blocks the UI)
 *   worker + CPU  → try the main thread, which may get the GPU (much faster); keep whichever has the GPU
 *   no workers    → main thread
 */
class ModelSlot<R> implements ModelHandle {
  ready = false;
  error: string | null = null;
  runner: Runner<R> | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly makeWorker: (() => Runner<R>) | null,
    private readonly makeMain: () => Runner<R>,
  ) {}

  get where(): string {
    return this.runner ? `${this.runner.kind === "worker" ? "WORKER" : "MAIN"} · ${this.runner.delegate ?? "?"}` : "—";
  }

  private numHands: number | null = null;
  /** Max hands to track (hands model only). Applied now and to whichever runner gets picked. */
  setNumHands(n: number): void {
    if (this.numHands === n) return;
    this.numHands = n;
    if (this.ready) this.runner?.setNumHands?.(n);
  }

  load(): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.loading ??= this.pick().then(
      () => {
        this.ready = true;
        this.error = null;
        if (this.numHands !== null) this.runner?.setNumHands?.(this.numHands);
      },
      (err) => {
        this.loading = null;
        this.error = (err as Error).message || String(err);
        throw err;
      },
    );
    return this.loading;
  }

  private async pick(): Promise<void> {
    if (this.makeWorker) {
      try {
        const w = this.makeWorker();
        await w.load();
        if (w.delegate === "GPU") {
          this.runner = w;
          return;
        }
        // Worker only got the CPU: see whether the main thread can use the GPU.
        try {
          const m = this.makeMain();
          await m.load();
          if (m.delegate === "GPU") {
            w.dispose();
            this.runner = m;
            return;
          }
          m.dispose();
        } catch {
          // keep the worker
        }
        this.runner = w;
        return;
      } catch (err) {
        console.warn("[vision] worker unavailable, using main thread:", (err as Error).message);
      }
    }
    const m = this.makeMain();
    await m.load();
    this.runner = m;
  }
}

export class VisionEngine {
  readonly hands: ModelSlot<Hand[]>;
  readonly face: ModelSlot<FaceResult>;

  constructor() {
    const canWorker =
      typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function" && !new URLSearchParams(location.search).has("mainvision");
    // Hands run on the main thread, straight off the <video> element, the moment a camera frame
    // arrives — the original (lowest-latency) path: no frame copy, no worker round trip.
    this.hands = new ModelSlot<Hand[]>(null, () => new MainHands());
    this.face = new ModelSlot<FaceResult>(canWorker ? () => new WorkerRunner<FaceResult>("face", decodeFace, { returnBitmap: true }) : null, () => new MainFace());
  }

  runHands(video: HTMLVideoElement, ts: number, aspect: number): Promise<Hand[]> {
    return this.hands.runner!.run(video, ts, aspect);
  }

  runFace(video: HTMLVideoElement, ts: number, aspect: number): Promise<FaceResult> {
    return this.face.runner!.run(video, ts, aspect);
  }
}
