import type { HandLandmarker } from "@mediapipe/tasks-vision";
import type { Hand } from "@shared/types";

/**
 * MediaPipe Hand Landmarker wrapper. Model + WASM are served by ARC itself.
 * Loaded lazily (and only once) — the module is large and not every device needs it.
 */
export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private loading: Promise<void> | null = null;
  private lastTs = 0;
  error: string | null = null;

  get ready(): boolean {
    return this.landmarker !== null;
  }

  load(): Promise<void> {
    if (this.landmarker) return Promise.resolve();
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const { FilesetResolver, HandLandmarker } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe");
      const options = (delegate: "GPU" | "CPU") => ({
        baseOptions: { modelAssetPath: "/models/hand_landmarker.task", delegate },
        runningMode: "VIDEO" as const,
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      });
      try {
        this.landmarker = await HandLandmarker.createFromOptions(fileset, options("GPU"));
      } catch (gpuErr) {
        console.warn("[tracker] GPU delegate failed, using CPU", gpuErr);
        this.landmarker = await HandLandmarker.createFromOptions(fileset, options("CPU"));
      }
      this.error = null;
    })().catch((err) => {
      this.loading = null;
      this.error = (err as Error).message || "Hand model failed to load";
      throw err;
    });
    return this.loading;
  }

  /** Detect hands in the current video frame. Landmarks are in raw (un-mirrored) image space. */
  detect(video: HTMLVideoElement, nowMs: number): Hand[] {
    if (!this.landmarker || video.readyState < 2) return [];
    // MediaPipe requires strictly increasing timestamps.
    const ts = Math.max(nowMs, this.lastTs + 1);
    this.lastTs = ts;
    const result = this.landmarker.detectForVideo(video, ts);
    return result.landmarks.map((points, i) => {
      const lm = new Array<number>(63);
      for (let j = 0; j < 21; j++) {
        lm[j * 3] = points[j].x;
        lm[j * 3 + 1] = points[j].y;
        lm[j * 3 + 2] = points[j].z;
      }
      const label = result.handedness[i]?.[0]?.categoryName === "Left" ? "Left" : "Right";
      return { handedness: label, lm };
    });
  }
}
