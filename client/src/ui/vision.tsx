import { useEffect, useRef, useState } from "react";
import { useArc } from "../core/store";
import { gestures, vision } from "../core/services";
import { StatusRow, toneFor } from "./primitives";

const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

/** Mirrored camera feed + live hand skeleton. Attaches to the persistent stream; never owns it. */
export function CameraPreview({ className = "", showVideo = true }: { className?: string; showVideo?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(vision.stream);

  useEffect(() => vision.on("stream", setStream), []);
  useEffect(() => {
    const v = videoRef.current;
    if (v && v.srcObject !== stream) {
      v.srcObject = stream;
      if (stream) void v.play().catch(() => undefined);
    }
  }, [stream]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    return gestures.on("frame", ({ hands }) => {
      const dpr = Math.min(2, window.devicePixelRatio);
      const w = canvas.clientWidth * dpr;
      const h = canvas.clientHeight * dpr;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      // Map image coords into the cover-fitted video box.
      const vw = vision.camera.video.videoWidth || 640;
      const vh = vision.camera.video.videoHeight || 480;
      const scale = Math.max(w / vw, h / vh);
      const ox = (w - vw * scale) / 2;
      const oy = (h - vh * scale) / 2;
      const P = (lm: number[], i: number) => [ox + (1 - lm[i * 3]) * vw * scale, oy + lm[i * 3 + 1] * vh * scale];
      for (const hand of hands) {
        ctx.strokeStyle = hand.pinching ? "rgba(140,255,200,0.9)" : "rgba(110,215,255,0.85)";
        ctx.lineWidth = 2 * dpr;
        ctx.beginPath();
        for (const [a, b] of CONNECTIONS) {
          const [ax, ay] = P(hand.lm, a);
          const [bx, by] = P(hand.lm, b);
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
        }
        ctx.stroke();
        ctx.fillStyle = "#dff7ff";
        for (let i = 0; i < 21; i++) {
          const [x, y] = P(hand.lm, i);
          ctx.beginPath();
          ctx.arc(x, y, (i === 4 || i === 8 ? 4 : 2.2) * dpr, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }, []);

  return (
    <div className={`camera-preview ${className} ${stream ? "is-live" : ""}`}>
      {showVideo && <video ref={videoRef} playsInline muted autoPlay />}
      <canvas ref={canvasRef} />
    </div>
  );
}

/** HUD status list — only real, measured values. */
export function StatusHud({ compact = false }: { compact?: boolean }) {
  const s = useArc((x) => x.state);
  const local = useArc((x) => x.local);
  const conn = useArc((x) => x.conn);
  const role = useArc((x) => x.role);
  if (!s) return null;
  const src = s.vision.activeSource;
  const srcState = s.vision.sources[src];
  const tracking = s.vision.routes.some((r) => r.source === role);
  const ai = s.services.ai;
  const fps = role === "PC" && s.mode === "PLAYGROUND" ? local.renderFps : tracking ? local.trackerFps : null;

  return (
    <div className={`status-hud ${compact ? "is-compact" : ""}`}>
      <StatusRow label="JARVIS" value={s.jarvis.activity === "IDLE" ? "ONLINE" : s.jarvis.activity} tone={conn.status === "online" ? "ok" : "bad"} />
      <StatusRow label="VISION" value={srcState.status} tone={srcState.status === "OFFLINE" || srcState.status === "IDLE" ? "off" : toneFor(srcState.status)} />
      <StatusRow label="CAMERA" value={`${src}${srcState.hands ? ` · ${srcState.hands} HAND${srcState.hands > 1 ? "S" : ""}` : ""}`} />
      <StatusRow label="GESTURES" value={local.trackerReady ? (local.gesture !== "NONE" && tracking ? local.gesture.replace("_", " ") : "READY") : "LOADING"} tone={local.trackerReady ? "ok" : "warn"} />
      <StatusRow label="GROQ" value={ai.status === "ONLINE" ? (ai.latencyMs ? `${ai.latencyMs} ms` : "CONNECTED") : ai.status} tone={toneFor(ai.status)} />
      {!compact && <StatusRow label="VOICE" value={s.services.voice.engine === "GROQ" ? "GROQ · MALE" : "BROWSER · MALE"} tone={s.services.voice.engine === "GROQ" ? "ok" : "warn"} />}
      <StatusRow label={role === "PC" ? "PHONE" : "DESKTOP"} value={(role === "PC" ? s.devices.PHONE : s.devices.PC).connected ? "CONNECTED" : "OFFLINE"} tone={(role === "PC" ? s.devices.PHONE : s.devices.PC).connected ? "ok" : "off"} />
      <StatusRow label="LATENCY" value={conn.latencyMs !== undefined ? `${conn.latencyMs} ms` : "—"} />
      {fps !== null && <StatusRow label="FPS" value={fps || "—"} />}
    </div>
  );
}
