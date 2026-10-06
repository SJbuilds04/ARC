/// <reference lib="webworker" />
/**
 * Vision worker — runs MediaPipe hand + face landmarkers off the main thread so
 * UI, 3D and the visor HUD keep a steady frame rate. Receives camera frames as
 * transferable ImageBitmaps; returns compact landmark arrays.
 */
import { FaceLandmarker, FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

type Model = "hands" | "face";

let fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>> | null = null;
let hands: HandLandmarker | null = null;
let face: FaceLandmarker | null = null;
let lastTs = 0;
const scope = self as unknown as DedicatedWorkerGlobalScope;

async function ensureFileset(base: string) {
  fileset ??= await FilesetResolver.forVisionTasks(base);
  return fileset;
}

async function load(model: Model, base: string, assets: string): Promise<string> {
  const fs = await ensureFileset(base);
  const create = async (delegate: "GPU" | "CPU") => {
    if (model === "hands") {
      hands = await HandLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: `${assets}/hand_landmarker.task`, delegate },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      });
    } else {
      face = await FaceLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: `${assets}/face_landmarker.task`, delegate },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
    }
  };
  try {
    await create("GPU");
    return "GPU";
  } catch {
    await create("CPU");
    return "CPU";
  }
}

scope.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === "load") {
    try {
      const delegate = await load(m.model, m.base, m.assets);
      scope.postMessage({ type: "loaded", model: m.model, delegate });
    } catch (err) {
      scope.postMessage({ type: "load-error", model: m.model, error: (err as Error).message || String(err) });
    }
    return;
  }
  if (m.type === "frame") {
    const bitmap: ImageBitmap = m.bitmap;
    const ts = Math.max(m.ts, lastTs + 1);
    lastTs = ts;
    const started = performance.now();
    const out: Record<string, unknown> = { type: "result", id: m.id };
    const transfer: Transferable[] = [];
    try {
      if (m.hands && hands) {
        const r = hands.detectForVideo(bitmap, ts);
        out.hands = r.landmarks.map((points, i) => {
          const lm = new Array<number>(63);
          for (let j = 0; j < 21; j++) {
            lm[j * 3] = points[j].x;
            lm[j * 3 + 1] = points[j].y;
            lm[j * 3 + 2] = points[j].z;
          }
          return { handedness: r.handedness[i]?.[0]?.categoryName === "Left" ? "Left" : "Right", lm };
        });
      }
      if (m.face && face) {
        const r = face.detectForVideo(bitmap, ts);
        const pts = r.faceLandmarks[0];
        if (pts && pts.length >= 478) {
          const arr = new Float32Array(pts.length * 3);
          for (let j = 0; j < pts.length; j++) {
            arr[j * 3] = pts[j].x;
            arr[j * 3 + 1] = pts[j].y;
            arr[j * 3 + 2] = pts[j].z;
          }
          const shapes = r.faceBlendshapes[0]?.categories ?? [];
          const shape = (n: string) => shapes.find((c) => c.categoryName === n)?.score ?? 0;
          out.face = { points: arr, blinkLeft: shape("eyeBlinkLeft"), blinkRight: shape("eyeBlinkRight"), matrix: r.facialTransformationMatrixes[0]?.data ?? null };
          transfer.push(arr.buffer);
        } else out.face = null;
      }
    } catch (err) {
      out.error = (err as Error).message;
    } finally {
      bitmap.close();
    }
    out.ms = performance.now() - started;
    scope.postMessage(out, transfer);
  }
};
