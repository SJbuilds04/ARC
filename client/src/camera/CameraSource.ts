import { prefs, savePref } from "../core/device";

const MOBILE = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
/** Windows Hello / depth cameras: grey, ~15 fps, useless for tracking. */
const NOT_A_WEBCAM = /\b(ir|infrared|depth|hello)\b/i;
/** A tracking camera below this is starved (dim light or a slow mode): ARC asks for a faster mode. */
const MIN_FPS = 24;

export interface CameraInfo {
  id: string;
  label: string;
}

/**
 * A device camera. Owns the MediaStream and a hidden <video> used for
 * inference; UI previews attach to the same stream.
 *
 * On PCs it picks a real webcam (never the Windows Hello infrared camera all-in-ones also have),
 * asks for at least 24 fps (webcams otherwise drop to 7–15 fps in dim light to expose longer),
 * and falls back to a lighter mode if the camera can't keep up.
 */
export class CameraSource {
  readonly video: HTMLVideoElement;
  stream: MediaStream | null = null;
  /** Cameras on this device (labels once permission is granted). */
  cameras: CameraInfo[] = [];

  constructor() {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
  }

  get aspect(): number {
    return this.video.videoWidth && this.video.videoHeight ? this.video.videoWidth / this.video.videoHeight : 4 / 3;
  }

  get active(): boolean {
    return Boolean(this.stream?.getVideoTracks().some((t) => t.readyState === "live"));
  }

  /** The camera in use (its device id). */
  get deviceId(): string | null {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId ?? null;
  }

  /** What the camera actually delivers (fps from the driver). */
  get settings(): MediaTrackSettings | null {
    return this.stream?.getVideoTracks()[0]?.getSettings() ?? null;
  }

  async start(onEnded: () => void): Promise<void> {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(window.isSecureContext ? "Camera API is not available in this browser" : "Camera needs HTTPS — open ARC via its https:// address");
    }
    try {
      this.stream = MOBILE ? await this.open({ facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } }) : await this.openPc();
    } catch (err) {
      const name = (err as DOMException).name;
      if (name === "NotAllowedError") throw new Error("Camera permission denied");
      if (name === "NotFoundError" || name === "OverconstrainedError") throw new Error("No camera found");
      if (name === "NotReadableError") throw new Error("Camera is in use by another app");
      throw new Error((err as Error).message || "Camera failed to start");
    }
    for (const track of this.stream.getVideoTracks()) track.addEventListener("ended", onEnded);
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => undefined);
    await new Promise<void>((resolve) => {
      if (this.video.readyState >= 2) resolve();
      else this.video.addEventListener("loadeddata", () => resolve(), { once: true });
    });
  }

  /** Use a particular camera from now on (remembered on this device). */
  choose(id: string): void {
    savePref("cameraId", id);
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  private open(video: MediaTrackConstraints): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({ audio: false, video });
  }

  private async listCameras(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
    const cams = all.filter((d) => d.kind === "videoinput");
    this.cameras = cams.map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    return cams;
  }

  /** The webcam to use: the one picked in ARC, else the first that isn't an infrared / depth camera. */
  private async pickPcCamera(): Promise<string | undefined> {
    const cams = await this.listCameras();
    const saved = prefs<string | null>("cameraId", null);
    if (saved && cams.some((c) => c.deviceId === saved)) return saved;
    return cams.find((c) => c.label && !NOT_A_WEBCAM.test(c.label))?.deviceId;
  }

  private async openPc(): Promise<MediaStream> {
    let id = await this.pickPcCamera();
    const modes = (deviceId?: string): MediaTrackConstraints[] => {
      const dev = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "user" };
      return [
        // light for tracking, and fast: a minimum frame rate stops the dim-light slow-down
        { ...dev, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, min: MIN_FPS } },
        // some webcams only reach 30 fps at a smaller size
        { ...dev, width: { ideal: 424 }, height: { ideal: 240 }, frameRate: { ideal: 30, min: MIN_FPS } },
        // whatever it can do
        { ...dev, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
      ];
    };
    let stream: MediaStream | null = null;
    let lastErr: unknown = null;
    for (const mode of modes(id)) {
      try {
        stream = await this.open(mode);
        break;
      } catch (err) {
        lastErr = err;
        if ((err as DOMException).name !== "OverconstrainedError") throw err;
      }
    }
    if (!stream) throw lastErr;
    // Labels only exist after permission: the first time, check we didn't get the infrared camera.
    if (!id) {
      const cams = await this.listCameras();
      const label = stream.getVideoTracks()[0]?.label ?? "";
      const better = cams.find((c) => c.label && !NOT_A_WEBCAM.test(c.label))?.deviceId;
      if (NOT_A_WEBCAM.test(label) && better) {
        stream.getTracks().forEach((t) => t.stop());
        id = better;
        stream = null;
        for (const mode of modes(id)) {
          try {
            stream = await this.open(mode);
            break;
          } catch (err) {
            if ((err as DOMException).name !== "OverconstrainedError") throw err;
          }
        }
        if (!stream) stream = await this.open({ deviceId: { exact: id } });
      }
    }
    return stream;
  }
}
