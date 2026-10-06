import type { FaceLandmarker } from "@mediapipe/tasks-vision";

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** One face observation (raw image space, not mirrored). */
export interface FaceFrame {
  t: number;
  points: Point3[];
  /** Blink blendshapes 0..1 (subject's left / right eye). */
  blinkLeft: number;
  blinkRight: number;
  /** 4×4 column-major facial transformation matrix (head pose), if available. */
  matrix: number[] | null;
  aspect: number;
}

/**
 * MediaPipe Face Landmarker: 478 landmarks including both irises, blink
 * blendshapes and a head-pose matrix. Runs entirely on-device; frames never
 * leave the browser. Loaded lazily, once.
 */
export class FaceTracker {
  private landmarker: FaceLandmarker | null = null;
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
      const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe");
      const options = (delegate: "GPU" | "CPU") => ({
        baseOptions: { modelAssetPath: "/models/face_landmarker.task", delegate },
        runningMode: "VIDEO" as const,
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      try {
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, options("GPU"));
      } catch (gpuErr) {
        console.warn("[face] GPU delegate failed, using CPU", gpuErr);
        this.landmarker = await FaceLandmarker.createFromOptions(fileset, options("CPU"));
      }
      this.error = null;
    })().catch((err) => {
      this.loading = null;
      this.error = (err as Error).message || "Face model failed to load";
      throw err;
    });
    return this.loading;
  }

  detect(video: HTMLVideoElement, nowMs: number, aspect: number): FaceFrame | null {
    if (!this.landmarker || video.readyState < 2) return null;
    const ts = Math.max(nowMs, this.lastTs + 1);
    this.lastTs = ts;
    const result = this.landmarker.detectForVideo(video, ts);
    const points = result.faceLandmarks[0];
    if (!points || points.length < 478) return null;
    const shapes = result.faceBlendshapes[0]?.categories ?? [];
    const shape = (name: string) => shapes.find((c) => c.categoryName === name)?.score ?? 0;
    return {
      t: nowMs,
      points,
      blinkLeft: shape("eyeBlinkLeft"),
      blinkRight: shape("eyeBlinkRight"),
      matrix: result.facialTransformationMatrixes[0]?.data ?? null,
      aspect,
    };
  }
}
