import { useEffect, useRef } from "react";
import { visor, vision } from "../../core/services";
import { useArc } from "../../core/store";
import { LM } from "../../visor/EyeTracker";
import type { FaceEvent } from "../../visor/VisorManager";

const CYAN = (a: number) => `rgba(120, 214, 255, ${a})`;
const WARM = (a: number) => `rgba(255, 156, 84, ${a})`;

/**
 * Face-anchored HUD geometry drawn from live landmarks: face lock brackets,
 * contour, eye reticles around each iris, bridge line and head-pose readouts.
 * Also publishes the face centre as CSS variables (--fx/--fy) so panels can
 * drift with the head.
 */
export function FaceHud({ rootRef }: { rootRef: React.RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    let latest: FaceEvent | null = null;
    let raf = 0;
    const fc = { x: 0, y: 0 };
    const off = visor.on("face", (e) => (latest = e));

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = Math.min(2, devicePixelRatio);
      const W = canvas.clientWidth * dpr;
      const H = canvas.clientHeight * dpr;
      if (canvas.width !== W) canvas.width = W;
      if (canvas.height !== H) canvas.height = H;
      ctx.clearRect(0, 0, W, H);
      const e = latest;
      if (!e) return;
      const t = performance.now() / 1000;
      const vw = vision.camera.video.videoWidth || 640;
      const vh = vision.camera.video.videoHeight || 480;
      const scale = Math.max(W / vw, H / vh);
      const ox = (W - vw * scale) / 2;
      const oy = (H - vh * scale) / 2;
      const pts = e.face.points;
      const P = (i: number) => ({ x: ox + (1 - pts[i].x) * vw * scale, y: oy + pts[i].y * vh * scale });
      const u = dpr;

      // Face bounds from the contour
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const i of LM.faceOval) {
        const p = P(i);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      const bw = maxX - minX;
      const bh = maxY - minY;
      const pad = bw * 0.14;
      const bx0 = minX - pad, by0 = minY - pad, bx1 = maxX + pad, by1 = maxY + pad * 0.6;

      // Publish face centre for panel parallax (eased).
      fc.x += ((minX + maxX) / 2 / W - 0.5 - fc.x) * 0.15;
      fc.y += ((minY + maxY) / 2 / H - 0.5 - fc.y) * 0.15;
      rootRef.current?.style.setProperty("--fx", fc.x.toFixed(3));
      rootRef.current?.style.setProperty("--fy", fc.y.toFixed(3));

      const v = useArc.getState().visor;
      ctx.lineCap = "round";

      // Contour: thin, broken
      ctx.strokeStyle = CYAN(0.22);
      ctx.lineWidth = 1 * u;
      ctx.setLineDash([6 * u, 5 * u]);
      ctx.beginPath();
      LM.faceOval.forEach((i, k) => {
        const p = P(i);
        if (k === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // Brows
      ctx.strokeStyle = CYAN(0.35);
      for (const brow of [LM.rightBrow, LM.leftBrow]) {
        ctx.beginPath();
        brow.forEach((i, k) => {
          const p = P(i);
          if (k === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
      }

      // Face-lock brackets
      const L = Math.min(bw, bh) * 0.16;
      ctx.strokeStyle = v.face === "TRACKING" ? CYAN(0.85) : WARM(0.8);
      ctx.lineWidth = 1.6 * u;
      const corner = (x: number, y: number, dx: number, dy: number) => {
        ctx.beginPath();
        ctx.moveTo(x + dx * L, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + dy * L);
        ctx.stroke();
      };
      corner(bx0, by0, 1, 1);
      corner(bx1, by0, -1, 1);
      corner(bx0, by1, 1, -1);
      corner(bx1, by1, -1, -1);

      // Scan sweep while acquiring
      if (v.phase === "boot" || v.face === "SCANNING") {
        const sy = by0 + ((t * 0.9) % 1) * (by1 - by0);
        const g = ctx.createLinearGradient(0, sy - 30 * u, 0, sy);
        g.addColorStop(0, CYAN(0));
        g.addColorStop(1, CYAN(0.35));
        ctx.fillStyle = g;
        ctx.fillRect(bx0, sy - 30 * u, bx1 - bx0, 30 * u);
        ctx.fillStyle = CYAN(0.9);
        ctx.fillRect(bx0, sy, bx1 - bx0, 1 * u);
      }

      // Eye reticles
      const eyes = [
        { eye: LM.rightEye, warm: false },
        { eye: LM.leftEye, warm: true },
      ];
      const centres: { x: number; y: number; r: number }[] = [];
      for (const { eye, warm } of eyes) {
        const c = P(eye.iris);
        const a = P(eye.outer);
        const b = P(eye.inner);
        const ew = Math.hypot(b.x - a.x, b.y - a.y);
        const R = ew * 0.95;
        const ring = P(eye.ring[0]);
        const irisR = Math.max(3 * u, Math.hypot(ring.x - c.x, ring.y - c.y));
        centres.push({ x: c.x, y: c.y, r: R });
        // rotating segmented ring
        ctx.lineWidth = 1.4 * u;
        for (let k = 0; k < 3; k++) {
          const start = t * (warm ? -0.6 : 0.6) + (k * Math.PI * 2) / 3;
          ctx.strokeStyle = warm && k === 0 ? WARM(0.85) : CYAN(0.75);
          ctx.beginPath();
          ctx.arc(c.x, c.y, R, start, start + 1.25);
          ctx.stroke();
        }
        ctx.strokeStyle = CYAN(0.3);
        ctx.lineWidth = 1 * u;
        ctx.beginPath();
        ctx.arc(c.x, c.y, R * 0.66, 0, Math.PI * 2);
        ctx.stroke();
        // ticks
        ctx.strokeStyle = CYAN(0.6);
        for (let k = 0; k < 4; k++) {
          const ang = (k * Math.PI) / 2;
          ctx.beginPath();
          ctx.moveTo(c.x + Math.cos(ang) * R * 1.08, c.y + Math.sin(ang) * R * 1.08);
          ctx.lineTo(c.x + Math.cos(ang) * R * 1.24, c.y + Math.sin(ang) * R * 1.24);
          ctx.stroke();
        }
        // iris lock
        ctx.strokeStyle = e.sample.blink ? WARM(0.7) : "rgba(225, 248, 255, 0.9)";
        ctx.lineWidth = 1.2 * u;
        ctx.beginPath();
        ctx.arc(c.x, c.y, irisR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(235, 250, 255, 0.95)";
        ctx.beginPath();
        ctx.arc(c.x, c.y, 1.6 * u, 0, Math.PI * 2);
        ctx.fill();
      }

      // Bridge between reticles
      if (centres.length === 2) {
        const [l, r] = centres[0].x < centres[1].x ? centres : [centres[1], centres[0]];
        const ax = l.x + l.r * 1.3, bx = r.x - r.r * 1.3;
        if (bx > ax) {
          const y = (l.y + r.y) / 2;
          ctx.strokeStyle = CYAN(0.45);
          ctx.lineWidth = 1 * u;
          ctx.beginPath();
          ctx.moveTo(ax, l.y);
          ctx.lineTo(bx, r.y);
          ctx.stroke();
          const mx = (ax + bx) / 2;
          ctx.fillStyle = CYAN(0.9);
          ctx.beginPath();
          ctx.moveTo(mx, y - 3 * u);
          ctx.lineTo(mx + 3 * u, y);
          ctx.lineTo(mx, y + 3 * u);
          ctx.lineTo(mx - 3 * u, y);
          ctx.fill();
        }
      }

      // Readouts (real values)
      const hp = e.sample.head;
      ctx.font = `${10 * u}px "JetBrains Mono", monospace`;
      ctx.fillStyle = CYAN(0.85);
      ctx.textAlign = "left";
      ctx.fillText(v.face === "TRACKING" ? "FACE LOCKED" : "SCANNING FACE…", bx0, by0 - 8 * u);
      ctx.textAlign = "right";
      ctx.fillText(`GAZE ${v.gaze}${v.confidence !== null && v.gaze !== "UNCALIBRATED" ? ` ${Math.round(v.confidence * 100)}%` : ""}`, bx1, by0 - 8 * u);
      ctx.fillStyle = CYAN(0.6);
      ctx.fillText(`YAW ${fmt(hp.yaw)}  PITCH ${fmt(hp.pitch)}  ROLL ${fmt(hp.roll)}`, bx1, by1 + 16 * u);
    };
    draw();
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [rootRef]);

  return <canvas ref={ref} className="face-hud" />;
}

const fmt = (deg: number) => `${deg >= 0 ? "+" : "−"}${Math.abs(deg).toFixed(1)}°`;
