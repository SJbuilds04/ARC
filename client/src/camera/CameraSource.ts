/**
 * A device camera. Owns the MediaStream and a hidden <video> used for
 * inference; UI previews attach to the same stream.
 */
export class CameraSource {
  readonly video: HTMLVideoElement;
  stream: MediaStream | null = null;

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

  async start(onEnded: () => void): Promise<void> {
    if (this.active) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(window.isSecureContext ? "Camera API is not available in this browser" : "Camera needs HTTPS — open ARC via its https:// address");
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
      });
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

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
