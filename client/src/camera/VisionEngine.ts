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

export interface FaceResult {
  face: FaceFrame | null;
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

  dispose(): void {
    this.worker.terminate();
  }
}

function decodeFace(m: Record<string, unknown>, aspect: number): FaceResult {
  const f = m.face as { points: Float32Array; blinkLeft: number; blinkRight: number; jawOpen: number; matrix: number[] | null } | null | undefined;
  let face: FaceFrame | null = null;
  if (f) {
    const a = f.points;
    const points: Point3[] = new Array(a.length / 3);
    for (let i = 0; i < points.length; i++) points[i] = { x: a[i * 3], y: a[i * 3 + 1], z: a[i * 3 + 2] };
    face = { t: performance.now(), points, blinkLeft: f.blinkLeft, blinkRight: f.blinkRight, jawOpen: f.jawOpen, matrix: f.matrix, aspect };
  }
  return { face, bitmap: (m.bitmap as ImageBitmap | undefined) ?? null, ms: (m.ms as number) ?? 0 };
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

  load(): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.loading ??= this.pick().then(
      () => {
        this.ready = true;
        this.error = null;
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
    this.hands = new ModelSlot<Hand[]>(
      canWorker ? () => new WorkerRunner<Hand[]>("hands", (m) => (m.hands as Hand[]) ?? [], { resize: 640 }) : null,
      () => new MainHands(),
    );
    this.face = new ModelSlot<FaceResult>(canWorker ? () => new WorkerRunner<FaceResult>("face", decodeFace, { returnBitmap: true }) : null, () => new MainFace());
  }

  runHands(video: HTMLVideoElement, ts: number, aspect: number): Promise<Hand[]> {
    return this.hands.runner!.run(video, ts, aspect);
  }

  runFace(video: HTMLVideoElement, ts: number, aspect: number): Promise<FaceResult> {
    return this.face.runner!.run(video, ts, aspect);
  }
}
