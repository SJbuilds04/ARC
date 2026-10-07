/// <reference lib="webworker" />
/**
 * Vision worker — runs ONE MediaPipe model (hands or face) off the main thread.
 * ARC starts one worker per model so hand and face tracking run in parallel.
 * Frames arrive as transferable ImageBitmaps; the face worker sends its bitmap
 * back so the visor can draw exactly the frame the landmarks belong to.
 */
import { FaceLandmarker, FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

let hands: HandLandmarker | null = null;
let face: FaceLandmarker | null = null;
let lastTs = 0;
const scope = self as unknown as DedicatedWorkerGlobalScope;

async function load(model: "hands" | "face", base: string, assets: string): Promise<"GPU" | "CPU"> {
  const fs = await FilesetResolver.forVisionTasks(base);
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
      scope.postMessage({ type: "loaded", delegate });
    } catch (err) {
      scope.postMessage({ type: "load-error", error: (err as Error).message || String(err) });
    }
    return;
  }
  if (m.type === "options") {
    // One hand = palm detection only runs when the hand is lost (much faster); two = always searching.
    if (hands && typeof m.numHands === "number") await hands.setOptions({ numHands: m.numHands });
    return;
  }
  if (m.type !== "frame") return;
  const bitmap: ImageBitmap = m.bitmap;
  const ts = Math.max(m.ts, lastTs + 1);
  lastTs = ts;
  const started = performance.now();
  const out: Record<string, unknown> = { type: "result", id: m.id };
  const transfer: Transferable[] = [];
  let returnBitmap = false;
  try {
    if (hands) {
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
    if (face) {
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
        out.face = { points: arr, blinkLeft: shape("eyeBlinkLeft"), blinkRight: shape("eyeBlinkRight"), jawOpen: shape("jawOpen"), matrix: r.facialTransformationMatrixes[0]?.data ?? null };
        transfer.push(arr.buffer);
      } else out.face = null;
      if (m.returnBitmap) {
        out.bitmap = bitmap;
        transfer.push(bitmap);
        returnBitmap = true;
      }
    }
  } catch (err) {
    out.error = (err as Error).message;
  }
  if (!returnBitmap) bitmap.close();
  out.ms = performance.now() - started;
  scope.postMessage(out, transfer);
};
