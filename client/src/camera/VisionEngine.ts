import type { Hand } from "@shared/types";
import { HandTracker } from "../gestures/HandTracker";
import { FaceTracker, type FaceFrame, type Point3 } from "../visor/FaceTracker";

export type Model = "hands" | "face";

/** A loadable model as seen by the rest of the app (`vision.tracker`, `vision.faceModel`). */
export interface ModelHandle {
  readonly ready: boolean;
  readonly error: string | null;
  load(): Promise<void>;
}

export interface VisionResult {
  /** null = not run this frame. */
  hands: Hand[] | null;
  /** undefined = not run this frame; null = no face. */
  face: FaceFrame | null | undefined;
  ms: number;
}

export interface VisionEngine {
  readonly kind: "worker" | "main";
  readonly hands: ModelHandle;
  readonly face: ModelHandle;
  process(video: HTMLVideoElement, ts: number, want: { hands: boolean; face: boolean }, aspect: number): Promise<VisionResult>;
}

class Handle implements ModelHandle {
  ready = false;
  error: string | null = null;
  private loading: Promise<void> | null = null;
  constructor(private readonly loader: () => Promise<void>) {}
  load(): Promise<void> {
    if (this.ready) return Promise.resolve();
    this.loading ??= this.loader().then(
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
}

/** Inference inside a Web Worker: the main thread only grabs a bitmap per frame. */
class WorkerEngine implements VisionEngine {
  readonly kind = "worker" as const;
  readonly hands: Handle;
  readonly face: Handle;
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, (r: VisionResult) => void>();
  private loadWaiters = new Map<Model, { resolve: () => void; reject: (e: Error) => void }>();
  private aspect = 4 / 3;

  constructor() {
    this.worker = new Worker(new URL("./vision.worker.ts", import.meta.url));
    this.worker.onmessage = (e) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(e.message || "Vision worker crashed");
      for (const w of this.loadWaiters.values()) w.reject(err);
      this.loadWaiters.clear();
    };
    this.hands = new Handle(() => this.loadModel("hands"));
    this.face = new Handle(() => this.loadModel("face"));
  }

  private loadModel(model: Model): Promise<void> {
    return new Promise((resolve, reject) => {
      this.loadWaiters.set(model, { resolve, reject });
      this.worker.postMessage({ type: "load", model, base: new URL("/mediapipe", location.origin).href, assets: new URL("/models", location.origin).href });
    });
  }

  private onMessage(m: { type: string; model?: Model; error?: string; id?: number; hands?: Hand[]; face?: { points: Float32Array; blinkLeft: number; blinkRight: number; matrix: number[] | null } | null; ms?: number }) {
    if (m.type === "loaded" || m.type === "load-error") {
      const w = this.loadWaiters.get(m.model!);
      this.loadWaiters.delete(m.model!);
      if (m.type === "loaded") w?.resolve();
      else w?.reject(new Error(m.error));
      return;
    }
    if (m.type === "result") {
      const done = this.pending.get(m.id!);
      this.pending.delete(m.id!);
      let face: FaceFrame | null | undefined;
      if (m.face === undefined) face = undefined;
      else if (m.face === null) face = null;
      else {
        const a = m.face.points;
        const points: Point3[] = new Array(a.length / 3);
        for (let i = 0; i < points.length; i++) points[i] = { x: a[i * 3], y: a[i * 3 + 1], z: a[i * 3 + 2] };
        face = { t: performance.now(), points, blinkLeft: m.face.blinkLeft, blinkRight: m.face.blinkRight, matrix: m.face.matrix, aspect: this.aspect };
      }
      done?.({ hands: m.hands ?? null, face, ms: m.ms ?? 0 });
    }
  }

  async process(video: HTMLVideoElement, ts: number, want: { hands: boolean; face: boolean }, aspect: number): Promise<VisionResult> {
    this.aspect = aspect;
    const runHands = want.hands && this.hands.ready;
    const runFace = want.face && this.face.ready;
    if (!runHands && !runFace) return { hands: null, face: undefined, ms: 0 };
    const bitmap = await createImageBitmap(video);
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage({ type: "frame", id, ts, bitmap, hands: runHands, face: runFace }, [bitmap]);
    });
  }
}

/** Fallback: same models on the main thread. */
class MainEngine implements VisionEngine {
  readonly kind = "main" as const;
  private handTracker = new HandTracker();
  private faceTracker = new FaceTracker();
  readonly hands: Handle = new Handle(() => this.handTracker.load());
  readonly face: Handle = new Handle(() => this.faceTracker.load());

  async process(video: HTMLVideoElement, ts: number, want: { hands: boolean; face: boolean }, aspect: number): Promise<VisionResult> {
    const t0 = performance.now();
    const hands = want.hands && this.hands.ready ? this.handTracker.detect(video, ts) : null;
    const face = want.face && this.face.ready ? this.faceTracker.detect(video, ts, aspect) : undefined;
    return { hands, face, ms: performance.now() - t0 };
  }
}

/** Prefer the worker; fall back to the main thread where workers can't run MediaPipe. */
export function createVisionEngine(): VisionEngine {
  const canWorker = typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";
  if (!canWorker || new URLSearchParams(location.search).has("mainvision")) return new MainEngine();
  try {
    return new FallbackEngine(new WorkerEngine());
  } catch {
    return new MainEngine();
  }
}

/** Wraps the worker engine; if a model fails to load there, everything moves to the main thread. */
class FallbackEngine implements VisionEngine {
  private active: VisionEngine;
  private main: MainEngine | null = null;
  readonly hands: ModelHandle;
  readonly face: ModelHandle;

  constructor(private readonly worker: WorkerEngine) {
    this.active = worker;
    const wrap = (model: Model): ModelHandle => {
      const self = this;
      return {
        get ready() {
          return self.active[model].ready;
        },
        get error() {
          return self.active[model].error;
        },
        async load() {
          try {
            await self.active[model].load();
          } catch (err) {
            if (self.active !== self.worker) throw err;
            console.warn(`[vision] worker ${model} model failed (${(err as Error).message}); using main thread`);
            self.main ??= new MainEngine();
            self.active = self.main;
            // Bring over whatever the worker already had loaded.
            for (const other of ["hands", "face"] as const) if (other !== model && self.worker[other].ready) void self.main[other].load().catch(() => undefined);
            await self.active[model].load();
          }
        },
      };
    };
    this.hands = wrap("hands");
    this.face = wrap("face");
  }

  get kind() {
    return this.active.kind;
  }

  process(video: HTMLVideoElement, ts: number, want: { hands: boolean; face: boolean }, aspect: number): Promise<VisionResult> {
    return this.active.process(video, ts, want, aspect);
  }
}
