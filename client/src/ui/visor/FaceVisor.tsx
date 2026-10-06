import { useEffect, useRef } from "react";
import { visor, vision } from "../../core/services";
import { useArc } from "../../core/store";
import type { FaceEvent } from "../../visor/VisorManager";

/**
 * ARC VISOR renderer — one canvas, every display frame:
 *   1. the face is cropped, centred and scaled into the HUD zone (it follows you),
 *   2. colour-graded + scanlines, then feathered into black (background blacked out),
 *   3. an armoured helmet HUD assembles over it from live landmarks.
 * Landmarks are interpolated between camera frames so motion stays smooth at
 * display refresh rate regardless of camera / inference rate.
 */

// Landmark sets (MediaPipe face mesh, subject's perspective)
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYE_R = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
const EYE_L = [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249];
const BROW = [70, 63, 105, 66, 107, 9, 336, 296, 334, 293, 300];
const LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
const NOSE = [168, 6, 197, 195, 5, 4];
// Armour plates
const FOREHEAD_PLATE = [54, 103, 67, 109, 10, 338, 297, 332, 284, 300, 293, 334, 296, 336, 9, 107, 66, 105, 63, 70];
const SIDE_R = [33, 234, 93, 132, 58, 172, 123];
const SIDE_L = [263, 454, 323, 361, 288, 397, 352];
const N = 478;

const CYAN = (a: number) => `rgba(130, 220, 255, ${a})`;
const WHITE = (a: number) => `rgba(235, 250, 255, ${a})`;
const GOLD = (a: number) => `rgba(255, 186, 110, ${a})`;
const CRIMSON = (a: number) => `rgba(190, 28, 38, ${a})`;

let tessellation: Uint16Array | null = null;
void import("@mediapipe/tasks-vision").then((m) => {
  const edges = m.FaceLandmarker.FACE_LANDMARKS_TESSELATION;
  tessellation = new Uint16Array(edges.length * 2);
  edges.forEach((e, i) => {
    tessellation![i * 2] = e.start;
    tessellation![i * 2 + 1] = e.end;
  });
});

function scanlinePattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 4;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillRect(0, 0, 4, 1);
  g.fillStyle = "rgba(140,220,255,0.10)";
  g.fillRect(0, 2, 4, 1);
  return ctx.createPattern(c, "repeat");
}

export function FaceVisor({ zoneRef }: { zoneRef: React.RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true })!;
    const pattern = scanlinePattern(ctx);
    const target = new Float32Array(N * 2); // latest landmarks, video px (mirrored)
    const smooth = new Float32Array(N * 2); // interpolated for drawing
    let hasTarget = false;
    let primed = false;
    let lockAt = 0;
    let lostAt = 0;
    let blink = 0;
    let yaw = 0, pitch = 0, roll = 0;
    let zone = { x: 0, y: 0, w: 1, h: 1 };
    const view = { cx: 0, cy: 0, s: 1, ready: false };
    let raf = 0;
    let last = performance.now();

    const measureZone = () => {
      const r = zoneRef.current?.getBoundingClientRect();
      const c = canvas.getBoundingClientRect();
      if (r) zone = { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
    };
    const ro = new ResizeObserver(measureZone);
    if (zoneRef.current) ro.observe(zoneRef.current);
    ro.observe(canvas);
    measureZone();

    const take = (e: FaceEvent | null) => {
      if (!e) {
        if (hasTarget) lostAt = performance.now();
        hasTarget = false;
        return;
      }
      const vw = vision.camera.video.videoWidth || 640;
      const vh = vision.camera.video.videoHeight || 480;
      const p = e.face.points;
      for (let i = 0; i < N; i++) {
        target[i * 2] = (1 - p[i].x) * vw;
        target[i * 2 + 1] = p[i].y * vh;
      }
      if (!hasTarget && (!primed || performance.now() - lostAt > 1200)) lockAt = performance.now();
      if (!primed) smooth.set(target);
      primed = true;
      hasTarget = true;
      blink = Math.max(e.face.blinkLeft, e.face.blinkRight);
      yaw = e.sample.head.yaw;
      pitch = e.sample.head.pitch;
      roll = e.sample.head.roll;
    };
    take(visor.latest);
    const off = visor.on("face", take);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const dpr = Math.min(1.5, devicePixelRatio);
      const W = Math.round(canvas.clientWidth * dpr);
      const H = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const t = now / 1000;
      const presence = hasTarget ? 1 : Math.max(0, 1 - (now - lostAt) / 600);
      if (!primed || presence <= 0) return;

      // 1. Interpolate landmarks toward the latest observation.
      const k = 1 - Math.exp(-dt * 22);
      for (let i = 0; i < N * 2; i++) smooth[i] += (target[i] - smooth[i]) * k;
      const X = (i: number) => smooth[i * 2];
      const Y = (i: number) => smooth[i * 2 + 1];

      // Face frame in video px
      const fcx = (X(234) + X(454)) / 2;
      const fcy = (Y(10) * 0.45 + Y(152) * 0.55);
      const faceH = Math.hypot(X(152) - X(10), Y(152) - Y(10));
      const faceW = Math.hypot(X(454) - X(234), Y(454) - Y(234));
      // View: keep the face centred in the zone at a constant size (eased → no jitter).
      const desired = Math.min(zone.h * 0.52, zone.w * 0.6) / Math.max(1, faceH);
      const zcx = zone.x + zone.w / 2;
      const zcy = zone.y + zone.h * 0.5;
      const vk = view.ready ? 1 - Math.exp(-dt * 6) : 1;
      view.cx += (fcx - view.cx) * vk;
      view.cy += (fcy - view.cy) * vk;
      view.s += (desired - view.s) * vk;
      view.ready = true;
      const s = view.s;
      const vw = vision.camera.video.videoWidth || 640;
      // screen (CSS px) of a landmark
      const SX = (i: number) => (X(i) - view.cx) * s + zcx;
      const SY = (i: number) => (Y(i) - view.cy) * s + zcy;
      const scx = (fcx - view.cx) * s + zcx;
      const scy = (fcy - view.cy) * s + zcy;
      const rx = faceW * s * 0.64;
      const ry = faceH * s * 0.74;
      // Mask centre: midway forehead↔chin, nudged up to keep the hairline and drop the neck.
      const mcxS = ((X(10) + X(152)) / 2 - view.cx) * s + zcx;
      const mcyS = ((Y(10) + Y(152)) / 2 - faceH * 0.1 - view.cy) * s + zcy;
      const rollRad = (Math.atan2(Y(454) - Y(234), X(454) - X(234)));

      // 2. Video (mirrored) placed by the view transform.
      ctx.globalAlpha = presence;
      ctx.setTransform(-s * dpr, 0, 0, s * dpr, ((vw - view.cx) * s + zcx) * dpr, (zcy - view.cy * s) * dpr);
      if (vision.camera.video.readyState >= 2) ctx.drawImage(vision.camera.video, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Visor grade: cool multiply, teal lift, scanlines.
      ctx.globalCompositeOperation = "multiply";
      ctx.fillStyle = "rgb(150, 205, 255)";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = "rgba(0, 55, 85, 0.35)";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "source-over";
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.globalAlpha = 0.35 * presence;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = presence;
      }

      // Feathered face mask: everything else goes to black.
      ctx.globalCompositeOperation = "destination-in";
      ctx.save();
      ctx.translate(mcxS, mcyS);
      ctx.rotate(rollRad);
      ctx.scale(rx, ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(0.68, "rgba(0,0,0,1)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.globalCompositeOperation = "source-over";

      // 3. Helmet HUD — assembles over ~1.1s after lock.
      const asm = Math.min(1, (now - lockAt) / 1100);
      const ease = 1 - Math.pow(1 - asm, 3);
      const u = 1;
      const speaking = useArc.getState().local.speaking;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      const path = (ids: readonly number[], close = false, scaleAbout?: { x: number; y: number; f: number; fy?: number }) => {
        ctx.beginPath();
        ids.forEach((id, n) => {
          let x = SX(id);
          let y = SY(id);
          if (scaleAbout) {
            x = scaleAbout.x + (x - scaleAbout.x) * scaleAbout.f;
            y = scaleAbout.y + (y - scaleAbout.y) * (scaleAbout.fy ?? scaleAbout.f);
          }
          if (n === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        if (close) ctx.closePath();
      };
      const reveal = (from: number, to: number) => Math.max(0, Math.min(1, (ease - from) / (to - from)));

      // Holographic mesh (faint) + scan band
      if (tessellation) {
        const meshA = 0.07 * reveal(0, 0.5) * presence;
        const drawMesh = () => {
          ctx.beginPath();
          for (let i = 0; i < tessellation!.length; i += 2) {
            const a = tessellation![i];
            const b = tessellation![i + 1];
            ctx.moveTo(SX(a), SY(a));
            ctx.lineTo(SX(b), SY(b));
          }
          ctx.stroke();
        };
        ctx.lineWidth = 0.6 * u;
        ctx.strokeStyle = CYAN(meshA);
        drawMesh();
        const top = SY(10) - 10;
        const bottom = SY(152) + 10;
        const band = top + (((t * 0.45) % 1) * (bottom - top + 120) - 60);
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, band - 22, W, 44);
        ctx.clip();
        ctx.strokeStyle = CYAN(0.32 * presence);
        drawMesh();
        ctx.restore();
      }

      const centre = { x: scx, y: scy };
      // Faceplate edge: double line
      ctx.setLineDash([]);
      const plate = reveal(0.1, 0.7);
      if (plate > 0) {
        ctx.lineWidth = 1 * u;
        ctx.strokeStyle = CYAN(0.35 * presence);
        path(OVAL, true, { ...centre, f: 1.09 });
        ctx.stroke();
        const perim = faceH * s * 3.3;
        ctx.lineWidth = 6 * u;
        ctx.strokeStyle = CYAN(0.12 * presence);
        ctx.setLineDash([perim * plate, perim]);
        path(OVAL, true, { ...centre, f: 1.03 });
        ctx.stroke();
        ctx.lineWidth = 1.6 * u;
        ctx.strokeStyle = WHITE(0.85 * presence);
        ctx.setLineDash([perim * plate, perim]);
        path(OVAL, true, { ...centre, f: 1.03 });
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Armour plates: crimson sides, gold forehead (translucent, so the face still reads)
      const plates = reveal(0.25, 0.8) * presence;
      if (plates > 0) {
        path(SIDE_R, true);
        ctx.fillStyle = CRIMSON(0.22 * plates);
        ctx.fill();
        path(SIDE_L, true);
        ctx.fill();
        const fg = ctx.createLinearGradient(0, SY(10), 0, SY(9));
        fg.addColorStop(0, GOLD(0.26 * plates));
        fg.addColorStop(1, GOLD(0.08 * plates));
        path(FOREHEAD_PLATE, true);
        ctx.fillStyle = fg;
        ctx.fill();
        ctx.lineWidth = 1 * u;
        ctx.strokeStyle = GOLD(0.55 * plates);
        ctx.stroke();
        ctx.strokeStyle = CRIMSON(0.0);
      }

      // Seams
      const seam = reveal(0.35, 0.85) * presence;
      if (seam > 0) {
        ctx.lineWidth = 1.2 * u;
        ctx.strokeStyle = CYAN(0.7 * seam);
        path(BROW);
        ctx.stroke();
        path(NOSE);
        ctx.stroke();
        // Forehead crest (V) + centre line
        ctx.strokeStyle = GOLD(0.7 * seam);
        ctx.beginPath();
        ctx.moveTo(SX(67), SY(67));
        ctx.lineTo(SX(151), SY(151));
        ctx.lineTo(SX(297), SY(297));
        ctx.moveTo(SX(10), SY(10));
        ctx.lineTo(SX(9), SY(9));
        ctx.stroke();
        // Cheek seams: nose wing → cheekbone → jaw (curved)
        ctx.strokeStyle = CYAN(0.6 * seam);
        for (const [a, m, b] of [
          [98, 123, 172],
          [327, 352, 397],
        ]) {
          ctx.beginPath();
          ctx.moveTo(SX(a), SY(a));
          ctx.quadraticCurveTo(SX(m), SY(m), SX(b), SY(b));
          ctx.stroke();
        }
        // Temple lines: outer eye corner → face side
        for (const [a, b] of [
          [33, 234],
          [263, 454],
        ]) {
          ctx.beginPath();
          ctx.moveTo(SX(a), SY(a));
          ctx.lineTo(SX(b), SY(b));
          ctx.stroke();
        }
        // Chin chevron
        ctx.beginPath();
        ctx.moveTo(SX(148), SY(148));
        ctx.lineTo(SX(152), SY(152) - 6);
        ctx.lineTo(SX(377), SY(377));
        ctx.stroke();
        // Mouth plate + grille (moves with your mouth)
        const mcx = (SX(61) + SX(291)) / 2;
        const mcy = (SY(0) + SY(17)) / 2;
        ctx.strokeStyle = CYAN(0.75 * seam);
        path(LIPS, true, { x: mcx, y: mcy, f: 1.35, fy: 1.6 });
        ctx.stroke();
        const mw = Math.abs(SX(291) - SX(61)) * 0.5;
        const mh = Math.abs(SY(17) - SY(0)) * 0.8 + 3;
        ctx.strokeStyle = CYAN(0.45 * seam);
        ctx.beginPath();
        for (const f of [-0.33, 0, 0.33]) {
          const y = mcy + f * mh;
          ctx.moveTo(mcx - mw * (1 - Math.abs(f) * 0.6), y);
          ctx.lineTo(mcx + mw * (1 - Math.abs(f) * 0.6), y);
        }
        ctx.stroke();
        // Bolts
        ctx.fillStyle = WHITE(0.8 * seam);
        for (const id of [234, 454, 172, 397]) {
          ctx.beginPath();
          ctx.arc(SX(id), SY(id), 2.2 * u, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Eye lenses — angular, glowing; they close when you blink.
      const lens = reveal(0.6, 1) * presence;
      if (lens > 0) {
        const open = 1 - Math.min(1, blink * 1.4);
        for (const eye of [EYE_R, EYE_L]) {
          let ex = 0, ey = 0;
          for (const id of eye) {
            ex += SX(id);
            ey += SY(id);
          }
          ex /= eye.length;
          ey /= eye.length;
          const outer = eye[0];
          const ox = SX(outer) - ex;
          const oy = SY(outer) - ey;
          ctx.beginPath();
          eye.forEach((id, n) => {
            let dx = SX(id) - ex;
            let dy = SY(id) - ey;
            dx *= 1.45;
            dy = dy * 1.9 * Math.max(0.12, open);
            // Sweep the outer end up toward the temple for an angular lens.
            const towardOuter = (dx * ox + dy * oy) / (ox * ox + oy * oy || 1);
            if (towardOuter > 0) dy -= towardOuter * Math.abs(ox) * 0.35;
            if (n === 0) ctx.moveTo(ex + dx, ey + dy);
            else ctx.lineTo(ex + dx, ey + dy);
          });
          ctx.closePath();
          const glow = ctx.createLinearGradient(ex - Math.abs(ox) * 1.5, ey, ex + Math.abs(ox) * 1.5, ey);
          const pulse = speaking ? 0.12 * Math.sin(t * 18) : 0.04 * Math.sin(t * 2.4);
          glow.addColorStop(0, WHITE((0.55 + pulse) * lens));
          glow.addColorStop(0.5, `rgba(190, 240, 255, ${(0.78 + pulse) * lens})`);
          glow.addColorStop(1, WHITE((0.55 + pulse) * lens));
          ctx.fillStyle = glow;
          ctx.fill();
          ctx.lineWidth = 5 * u;
          ctx.strokeStyle = CYAN(0.22 * lens);
          ctx.stroke();
          ctx.lineWidth = 1.2 * u;
          ctx.strokeStyle = WHITE(0.95 * lens);
          ctx.stroke();
        }
      }

      // Outer HUD ring + readouts
      const ring = reveal(0.2, 0.9) * presence;
      if (ring > 0) {
        const R = Math.min(faceH * s * 0.9, Math.min(zone.w, zone.h) / 2 - 38);
        ctx.save();
        ctx.translate(scx, scy);
        ctx.lineWidth = 1 * u;
        ctx.strokeStyle = CYAN(0.28 * ring);
        ctx.beginPath();
        ctx.arc(0, 0, R, Math.PI * 1.08, Math.PI * 1.92);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, R, Math.PI * 0.12, Math.PI * 0.88);
        ctx.stroke();
        ctx.strokeStyle = CYAN(0.55 * ring);
        for (let a = -60; a <= 60; a += 10) {
          const r1 = a % 30 === 0 ? R * 1.04 : R * 1.02;
          const ang = ((a - 90) * Math.PI) / 180;
          ctx.beginPath();
          ctx.moveTo(Math.cos(ang) * R, Math.sin(ang) * R);
          ctx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
          ctx.stroke();
        }
        // Yaw needle on the top arc
        const yawAng = ((Math.max(-55, Math.min(55, yaw)) - 90) * Math.PI) / 180;
        ctx.fillStyle = GOLD(0.9 * ring);
        ctx.beginPath();
        ctx.moveTo(Math.cos(yawAng) * R * 0.97, Math.sin(yawAng) * R * 0.97);
        ctx.lineTo(Math.cos(yawAng - 0.03) * R * 0.9, Math.sin(yawAng - 0.03) * R * 0.9);
        ctx.lineTo(Math.cos(yawAng + 0.03) * R * 0.9, Math.sin(yawAng + 0.03) * R * 0.9);
        ctx.fill();
        // Rotating inner segment
        ctx.strokeStyle = WHITE(0.5 * ring);
        ctx.lineWidth = 1.6 * u;
        ctx.beginPath();
        ctx.arc(0, 0, R * 0.94, t * 0.5, t * 0.5 + 0.5);
        ctx.stroke();
        ctx.restore();

        ctx.font = `500 ${10}px "JetBrains Mono", monospace`;
        ctx.fillStyle = CYAN(0.85 * ring);
        ctx.textAlign = "center";
        ctx.fillText(hasTarget ? "FACE LOCK" : "SIGNAL LOST", scx, scy - R - 10);
        ctx.fillStyle = CYAN(0.6 * ring);
        ctx.fillText(`YAW ${fmt(yaw)}   PITCH ${fmt(pitch)}   ROLL ${fmt(roll)}`, scx, scy + R + 16);
      }
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => {
      off();
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [zoneRef]);

  return <canvas ref={ref} className="face-visor" />;
}

const fmt = (deg: number) => `${deg >= 0 ? "+" : "−"}${Math.abs(deg).toFixed(1)}°`;
