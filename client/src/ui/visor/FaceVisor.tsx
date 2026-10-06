import { useEffect, useRef } from "react";
import { visor, vision, voiceIn, voiceOut } from "../../core/services";
import { useArc } from "../../core/store";
import type { FaceEvent } from "../../visor/VisorManager";

/**
 * ARC VISOR renderer (helmet-interior view).
 *  - Draws the exact camera frame the face landmarks were computed on (worker path),
 *    so face-locked HUD elements never drift; falls back to live video when needed.
 *  - The face stays where it is in the frame (no re-centring lag).
 *  - Cut-out follows the real face contour + hairline with a soft feather; the rest is dark.
 *  - Face-locked HUD: eye targeting reticle, tech frame, voice rings.
 */

const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const N = 478;
const CYAN = (a: number) => `rgba(140, 222, 255, ${a})`;
const WHITE = (a: number) => `rgba(236, 250, 255, ${a})`;
const AMBER = (a: number) => `rgba(255, 176, 92, ${a})`;
const MASK_SCALE = 0.25; // mask canvas resolution (feathered edges hide the low res)

const freq = new Uint8Array(64);
function voiceLevel(): number {
  if (useArc.getState().local.speaking && voiceOut.analyser) {
    voiceOut.analyser.getByteFrequencyData(freq);
    let s = 0;
    for (let i = 2; i < 24; i++) s += freq[i];
    return Math.min(1, s / (22 * 170));
  }
  return Math.min(1, voiceIn.level * 1.6);
}

/** Jitter filter for HUD anchors: snaps on real movement, smooths sub-pixel noise. */
class Anchor {
  x = 0;
  y = 0;
  r = 0;
  private init = false;
  update(x: number, y: number, r: number) {
    if (!this.init) {
      this.x = x;
      this.y = y;
      this.r = r;
      this.init = true;
      return;
    }
    const d = Math.hypot(x - this.x, y - this.y);
    const k = d > 5 ? 1 : 0.35 + d * 0.13;
    this.x += (x - this.x) * k;
    this.y += (y - this.y) * k;
    this.r += (r - this.r) * 0.3;
  }
}

export function FaceVisor() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true })!;
    const mask = document.createElement("canvas");
    const mctx = mask.getContext("2d")!;
    const pts = new Float32Array(N * 2); // landmarks of the frame being drawn (source px, mirrored)
    let frame: CanvasImageSource | null = null; // the frame those landmarks belong to
    let srcW = 640;
    let srcH = 480;
    let hasFace = false;
    let lostAt = 0;
    let lockAt = 0;
    let blink = 0;
    let jaw = 0;
    let yaw = 0;
    let pitch = 0;
    let raf = 0;
    let last = performance.now();
    const crop = { x: NaN, y: NaN }; // cover-crop offset that keeps the face in view
    let zoom = 1; // gentle auto-zoom so the face fills the visor (slow — framing, not tracking)
    const eyeA = new Anchor();
    const eyeB = new Anchor();
    const mouthA = new Anchor();
    const cheekA = new Anchor();

    const take = (e: FaceEvent | null) => {
      if (!e) {
        if (hasFace) lostAt = performance.now();
        hasFace = false;
        // The synced bitmap is released by the pipeline; fade out over the live video instead.
        frame = vision.camera.video;
        srcW = vision.camera.video.videoWidth || srcW;
        srcH = vision.camera.video.videoHeight || srcH;
        return;
      }
      // Pair landmarks with the exact frame they came from when the worker returned it.
      const lf = vision.latestFrame;
      const synced = lf && performance.now() - lf.at < 60 ? lf.bitmap : null;
      frame = synced ?? vision.camera.video;
      srcW = synced ? synced.width : vision.camera.video.videoWidth || 640;
      srcH = synced ? synced.height : vision.camera.video.videoHeight || 480;
      const p = e.face.points;
      for (let i = 0; i < N; i++) {
        pts[i * 2] = (1 - p[i].x) * srcW;
        pts[i * 2 + 1] = p[i].y * srcH;
      }
      if (!hasFace && performance.now() - lostAt > 1000) lockAt = performance.now();
      hasFace = true;
      blink = Math.max(e.face.blinkLeft, e.face.blinkRight);
      jaw = e.face.jawOpen ?? 0;
      yaw = e.sample.head.yaw;
      pitch = e.sample.head.pitch;
    };
    take(visor.latest);
    const off = visor.on("face", take);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const dpr = Math.min(1.5, devicePixelRatio);
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      const W = Math.round(cw * dpr);
      const H = Math.round(ch * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
        mask.width = Math.max(1, Math.round(cw * MASK_SCALE));
        mask.height = Math.max(1, Math.round(ch * MASK_SCALE));
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const presence = hasFace ? 1 : Math.max(0, 1 - (now - lostAt) / 500);
      if (!frame || presence <= 0) return;

      // Cover-fit the frame (mirrored). The camera's aspect rarely matches the screen, so the
      // crop is shifted (only within the overflow margin) to keep the face in view.
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const faceHsrc = Math.hypot(pts[152 * 2] - pts[10 * 2], pts[152 * 2 + 1] - pts[10 * 2 + 1]);
      const cover = Math.max(cw / srcW, ch / srcH);
      const wantZoom = Math.min(1.6, Math.max(1, (ch * 0.5) / Math.max(1, faceHsrc * cover)));
      zoom += (wantZoom - zoom) * (1 - Math.exp(-dt * 1.2));
      const s = cover * zoom;
      const minX = cw - srcW * s;
      const minY = ch - srcH * s;
      const faceSX = (pts[234 * 2] + pts[454 * 2]) / 2;
      const faceSY = (pts[10 * 2 + 1] + pts[152 * 2 + 1]) / 2;
      const tx = Math.min(0, Math.max(minX, cw * 0.5 - faceSX * s));
      const ty = Math.min(0, Math.max(minY, ch * 0.44 - faceSY * s));
      const ck = Number.isNaN(crop.x) ? 1 : 1 - Math.exp(-dt * 8);
      crop.x = Number.isNaN(crop.x) ? tx : crop.x + (tx - crop.x) * ck;
      crop.y = Number.isNaN(crop.y) ? ty : crop.y + (ty - crop.y) * ck;
      const ox = crop.x;
      const oy = crop.y;
      const SX = (i: number) => ox + pts[i * 2] * s;
      const SY = (i: number) => oy + pts[i * 2 + 1] * s;

      ctx.globalAlpha = presence;
      ctx.setTransform(-s * dpr, 0, 0, s * dpr, (ox + srcW * s) * dpr, oy * dpr);
      try {
        ctx.drawImage(frame, 0, 0, srcW, srcH);
      } catch {
        frame = vision.camera.video; // frame was released between events — use live video
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Natural grade: slightly cool shadows, skin stays warm.
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "rgb(222, 232, 244)";
      ctx.fillRect(0, 0, cw, ch);
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = "rgba(0, 26, 44, 0.18)";
      ctx.fillRect(0, 0, cw, ch);

      // Contour mask: face outline, upper points pushed out to include the hair; layered feather.
      const cx = (SX(234) + SX(454)) / 2;
      const cy = (SY(10) + SY(152)) / 2;
      const eyeLine = (SY(33) + SY(263)) / 2;
      const faceH = Math.hypot(SX(152) - SX(10), SY(152) - SY(10));
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.clearRect(0, 0, mask.width, mask.height);
      mctx.setTransform(MASK_SCALE, 0, 0, MASK_SCALE, 0, 0);
      const contour = (grow: number) => {
        mctx.beginPath();
        OVAL.forEach((id, n) => {
          const x = SX(id);
          const y = SY(id);
          const above = Math.max(0, Math.min(1, (eyeLine - y) / Math.max(1, eyeLine - SY(10))));
          const fx = 1.06 + above * 0.1;
          const fy = y < cy ? 1.04 + above * 0.42 : 1.06; // hairline above, jaw below
          const px = cx + (x - cx) * fx * grow;
          const py = cy + (y - cy) * fy * grow - above * faceH * 0.06;
          if (n === 0) mctx.moveTo(px, py);
          else mctx.lineTo(px, py);
        });
        mctx.closePath();
      };
      for (const [grow, a] of [
        [1.16, 0.1],
        [1.12, 0.18],
        [1.08, 0.3],
        [1.04, 0.55],
        [1.0, 1],
      ] as const) {
        contour(grow);
        mctx.fillStyle = `rgba(0,0,0,${a})`;
        mctx.fill();
      }
      ctx.globalCompositeOperation = "destination-in";
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(mask, 0, 0, cw, ch);
      ctx.globalCompositeOperation = "source-over";

      // ─── Face-locked HUD ───
      const reveal = Math.min(1, (now - lockAt) / 700) * presence;
      const t = now / 1000;
      const level = voiceLevel();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const glowStroke = (w: number, a: number, color = CYAN) => {
        ctx.lineWidth = w * 4;
        ctx.strokeStyle = color(a * 0.12);
        ctx.stroke();
        ctx.lineWidth = w;
        ctx.strokeStyle = color(a);
        ctx.stroke();
      };

      const eyeW = (a: number, b: number) => Math.hypot(SX(b) - SX(a), SY(b) - SY(a));
      const e1 = { x: SX(473), y: SY(473), w: eyeW(263, 362) };
      const e2 = { x: SX(468), y: SY(468), w: eyeW(33, 133) };
      const mainIsE1 = e1.x > e2.x; // viewer-right eye gets the full reticle
      const main = mainIsE1 ? e1 : e2;
      const other = mainIsE1 ? e2 : e1;
      eyeA.update(main.x, main.y, main.w);
      eyeB.update(other.x, other.y, other.w);

      const R = eyeA.r * 1.05;
      ctx.save();
      ctx.translate(eyeA.x, eyeA.y);
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 0.42, Math.max(1, R * 0.42 * (1 - blink * 0.7)), 0, 0, Math.PI * 2);
      glowStroke(1.4, 0.9 * reveal, WHITE);
      for (let k = 0; k < 4; k++) {
        const a0 = t * 0.9 + (k * Math.PI) / 2;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.95, a0, a0 + 1.05);
        glowStroke(1.6, 0.85 * reveal);
      }
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.4, -t * 0.4, -t * 0.4 + Math.PI * 1.7);
      ctx.lineWidth = 1;
      ctx.strokeStyle = CYAN(0.55 * reveal);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + (k * Math.PI) / 2;
        const r0 = R * 1.62;
        ctx.save();
        ctx.rotate(a);
        ctx.beginPath();
        ctx.moveTo(r0, -R * 0.18);
        ctx.lineTo(r0, 0);
        ctx.lineTo(r0 - R * 0.18, 0);
        glowStroke(1.3, 0.8 * reveal, WHITE);
        ctx.restore();
      }
      ctx.beginPath();
      ctx.arc(0, 0, R * 1.18, Math.PI * 0.62, Math.PI * 0.86);
      glowStroke(2, 0.85 * reveal, AMBER);
      ctx.restore();

      // Angular tech frame from the reticle out to a callout.
      const fx0 = eyeA.x;
      const fy0 = eyeA.y;
      ctx.beginPath();
      ctx.moveTo(fx0 - R * 0.6, fy0 - R * 2.1);
      ctx.lineTo(fx0 + R * 1.9, fy0 - R * 2.1);
      ctx.lineTo(fx0 + R * 2.6, fy0 - R * 1.4);
      ctx.lineTo(fx0 + R * 2.6, fy0 + R * 0.2);
      glowStroke(1.3, 0.7 * reveal, WHITE);
      // Callout: right of the reticle if there's room before the glass panel, otherwise
      // mirrored out from the other eye on the left.
      ctx.font = `500 ${Math.round(Math.max(9, Math.min(12, R * 0.32)))}px "JetBrains Mono", monospace`;
      const label2 = `YAW ${fmt(yaw)}  PIT ${fmt(pitch)}`;
      const textW = Math.max(ctx.measureText(label2).width, ctx.measureText("TARGET LOCK").width);
      const wide = cw > 700;
      const rightLimit = cw * (wide ? 0.755 : 0.7) - textW - 12;
      const leftLimit = cw * (wide ? 0.245 : 0.3) + textW + 12;
      const drawCallout = (ox0: number, oy0: number, r0: number, dir: 1 | -1, limit: number) => {
        const start = ox0 + dir * r0 * 1.62;
        const lineEnd = dir > 0 ? Math.min(ox0 + r0 * 5.4, limit) : Math.max(ox0 - r0 * 5.4, limit);
        if ((lineEnd - start) * dir < r0 * 0.7) return false;
        const knee = start + dir * Math.min(r0 * 1.6, Math.abs(lineEnd - start) * 0.5);
        ctx.beginPath();
        ctx.moveTo(start, oy0);
        ctx.lineTo(knee, oy0);
        ctx.lineTo(knee + dir * r0 * 0.45, oy0 + r0 * 0.45);
        ctx.lineTo(lineEnd, oy0 + r0 * 0.45);
        glowStroke(1.2, 0.75 * reveal);
        ctx.textAlign = dir > 0 ? "left" : "right";
        const tx = lineEnd + dir * 8;
        ctx.fillStyle = CYAN(0.9 * reveal);
        ctx.fillText("TARGET LOCK", tx, oy0 + r0 * 0.45 - 4);
        ctx.fillStyle = WHITE(0.7 * reveal);
        ctx.fillText(label2, tx, oy0 + r0 * 0.45 + 12);
        return true;
      };
      if (!drawCallout(fx0, fy0, R, 1, rightLimit) && !drawCallout(eyeB.x, eyeB.y, eyeB.r * 1.05, -1, leftLimit)) {
        // No side room (face zoomed in): ride the top edge of the tech frame instead.
        ctx.textAlign = "left";
        ctx.fillStyle = CYAN(0.9 * reveal);
        ctx.fillText("TARGET LOCK", fx0 - R * 0.6, fy0 - R * 2.1 - 22);
        ctx.fillStyle = WHITE(0.7 * reveal);
        ctx.fillText(label2, fx0 - R * 0.6, fy0 - R * 2.1 - 9);
      }
      ctx.strokeStyle = CYAN(0.6 * reveal);
      ctx.lineWidth = 1;
      for (let k = 0; k < 6; k++) {
        const x = fx0 - R * 0.3 + k * R * 0.35;
        ctx.beginPath();
        ctx.moveTo(x, fy0 - R * 2.1);
        ctx.lineTo(x, fy0 - R * 2.1 + (k % 2 ? 4 : 7));
        ctx.stroke();
      }

      // Other eye: quiet ring + cross ticks.
      ctx.beginPath();
      ctx.arc(eyeB.x, eyeB.y, eyeB.r * 0.95, 0, Math.PI * 2);
      glowStroke(1, 0.35 * reveal);
      ctx.lineWidth = 1;
      ctx.strokeStyle = CYAN(0.5 * reveal);
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        ctx.beginPath();
        ctx.moveTo(eyeB.x + Math.cos(a) * eyeB.r * 1.1, eyeB.y + Math.sin(a) * eyeB.r * 1.1);
        ctx.lineTo(eyeB.x + Math.cos(a) * eyeB.r * 1.3, eyeB.y + Math.sin(a) * eyeB.r * 1.3);
        ctx.stroke();
      }

      // Voice ring at the mouth corner (pulses with your voice / JARVIS) + cheek ring.
      const corner = SX(61) < SX(291) ? 61 : 291;
      mouthA.update(SX(corner), SY(corner), faceH * 0.075);
      const vr = mouthA.r * (1 + level * 0.6 + jaw * 0.3);
      ctx.beginPath();
      ctx.arc(mouthA.x - mouthA.r * 0.4, mouthA.y, vr, 0, Math.PI * 2);
      glowStroke(2.2, (0.45 + level * 0.5) * reveal);
      ctx.beginPath();
      ctx.arc(mouthA.x - mouthA.r * 0.4, mouthA.y, vr * 1.45, t * 1.4, t * 1.4 + Math.PI * 1.2);
      glowStroke(1, 0.3 * reveal);
      const cheekId = SX(123) < SX(352) ? 123 : 352;
      cheekA.update(SX(cheekId), SY(cheekId), faceH * 0.05);
      ctx.beginPath();
      ctx.arc(cheekA.x, cheekA.y, cheekA.r, -t * 0.8, -t * 0.8 + Math.PI * 1.5);
      glowStroke(1.4, 0.4 * reveal);

      // Big angular frame arching around the reticle side of the face.
      const sideId = SX(454) > SX(234) === mainIsE1 ? 454 : 234;
      const dir = SX(sideId) > cx ? 1 : -1;
      const top = SY(10) - faceH * 0.08;
      const sideX = SX(sideId) + dir * faceH * 0.16;
      ctx.beginPath();
      ctx.moveTo(cx, top);
      ctx.lineTo(sideX - dir * faceH * 0.12, top);
      ctx.lineTo(sideX, top + faceH * 0.18);
      ctx.lineTo(sideX, cy + faceH * 0.16);
      ctx.lineTo(sideX - dir * faceH * 0.1, cy + faceH * 0.3);
      glowStroke(1.2, 0.45 * reveal);

      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={ref} className="face-visor" />;
}

const fmt = (deg: number) => `${deg >= 0 ? "+" : "−"}${Math.abs(deg).toFixed(1)}°`;
