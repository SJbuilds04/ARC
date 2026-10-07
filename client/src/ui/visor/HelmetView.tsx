import { useEffect, useRef } from "react";
import { gestures, visor, vision, voiceIn, voiceOut } from "../../core/services";
import { useArc } from "../../core/store";
import type { FaceEvent } from "../../visor/VisorManager";
import { HudPainter, type HudData } from "./hud/HudPainter";
import { VisorScene } from "./hud/VisorScene";

const WEAK = (navigator.hardwareConcurrency || 4) <= 4;
/** How old a frame/mask may be and still count as current (slow machines get ~5-10 fps). */
const FRESH_MS = 700;

const freq = new Uint8Array(128);
/** n bars 0..1: JARVIS's voice while he speaks, otherwise your mic level with a little life in it. */
function spectrumOf(t: number) {
  return (n: number): number[] => {
    const out = new Array<number>(n);
    if (useArc.getState().local.speaking && voiceOut.analyser) {
      voiceOut.analyser.getByteFrequencyData(freq);
      for (let i = 0; i < n; i++) out[i] = Math.min(1, freq[2 + Math.floor((i / n) * 60)] / 210);
      return out;
    }
    const lv = Math.min(1, voiceIn.level * 1.8);
    for (let i = 0; i < n; i++) out[i] = Math.min(1, lv * (0.5 + 0.5 * Math.abs(Math.sin(i * 1.7 + t * 9))) + 0.04 * Math.abs(Math.sin(i * 0.9 + t * 2)));
    return out;
  };
}

function contextOf(): { kicker: string; title: string } {
  const s = useArc.getState();
  const pending = s.state?.pending;
  const activity = s.state?.jarvis.activity;
  if (pending) return { kicker: "AWAITING CONFIRMATION", title: pending.title.replace(/\?$/, "").toUpperCase() };
  if (s.visor.target) return { kicker: s.visor.target.phase === "locked" ? "TARGET LOCKED" : "TARGET ACQUIRED", title: s.visor.target.label };
  if (s.local.speaking || activity === "SPEAKING") return { kicker: "J.A.R.V.I.S.", title: "RESPONDING" };
  if (activity === "THINKING") return { kicker: "J.A.R.V.I.S.", title: "ANALYZING" };
  if (s.local.mic === "recording") return { kicker: "AUDIO", title: "LISTENING" };
  return { kicker: "SYSTEM STATUS", title: "ALL SYSTEMS NOMINAL" };
}

/**
 * The helmet view: your face (WebGL, sharpened, HUD-lit, person-masked) + the HUD (2D canvas,
 * composited with visor curvature, glow and chromatic aberration). One canvas, one render loop.
 */
export function HelmetView() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const hud = document.createElement("canvas");
    const painter = new HudPainter(hud);
    const scene = new VisorScene(hud, WEAK);
    host.current!.appendChild(scene.canvas);

    // Latest face (landmarks in normalized image coords).
    let face: FaceEvent | null = visor.latest;
    let faceAt = face ? performance.now() : 0;
    const off = visor.on("face", (e: FaceEvent | null) => {
      if (e) {
        face = e;
        faceAt = performance.now();
      }
    });

    let W = 0;
    let H = 0;
    let hudScale = 1;
    const resize = () => {
      const r = host.current!.getBoundingClientRect();
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
      scene.setSize(W, H);
      hudScale = Math.min(devicePixelRatio, WEAK ? 1 : 1.5);
      hud.width = Math.round(W * hudScale);
      hud.height = Math.round(H * hudScale);
      scene.setHudSize(hud.width, hud.height);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host.current!);

    const born = performance.now();
    const view = { ox: NaN, oy: NaN };
    let speak = 0;
    let presence = 0;
    let maskAt = 0;
    let last = performance.now();
    let frameMs = 16;
    let hudSkip = 0;
    let rightPanelX = 0;
    let panelCheck = 0;
    let raf = 0;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      frameMs = frameMs * 0.92 + dt * 1000 * 0.08;
      const t = now / 1000;

      // Frame + mask: the exact frame the worker analysed, else the live video.
      const lf = vision.latestFrame;
      const fresh = lf && now - lf.at < FRESH_MS;
      const video = vision.camera.video;
      const image: TexImageSource | null = fresh ? lf.bitmap : video.readyState >= 2 ? video : null;
      const srcW = fresh ? lf.bitmap.width : video.videoWidth || 640;
      const srcH = fresh ? lf.bitmap.height : video.videoHeight || 480;
      scene.setFace({ image, width: srcW, height: srcH, mask: fresh ? lf.mask : null });

      // Framing: the face stays centred like inside a helmet (fast, so it never feels behind).
      // Scaled to fit the height — no zoom, so a webcam frame isn't blown up further.
      const s = Math.min((H * 0.96) / srcH, (W * 1.15) / srcW);
      const p = face?.face.points;
      const hasFace = Boolean(p) && now - faceAt < 1500;
      const fx = p ? (1 - (p[234].x + p[454].x) / 2) * srcW : srcW / 2;
      const fy = p ? ((p[10].y + p[152].y) / 2) * srcH : srcH * 0.45;
      const tx = W / 2 - fx * s;
      const ty = Math.min(H * 0.04, Math.max(H * 0.98 - srcH * s, H * 0.47 - fy * s));
      const k = Number.isNaN(view.ox) ? 1 : 1 - Math.exp(-dt * 14);
      view.ox = Number.isNaN(view.ox) ? tx : view.ox + (tx - view.ox) * k;
      view.oy = Number.isNaN(view.oy) ? ty : view.oy + (ty - view.oy) * k;
      const rect = { x: view.ox, y: view.oy, w: srcW * s, h: srcH * s };
      const toScreen = (lx: number, ly: number) => ({ x: rect.x + (1 - lx) * rect.w, y: rect.y + ly * rect.h });

      // Presence: the person mask keeps you visible even if face landmarks drop for a moment.
      if (lf?.mask) maskAt = lf.at;
      const want = now - maskAt < 1500 || hasFace ? 1 : 0;
      presence += (want - presence) * (1 - Math.exp(-dt * (want > presence ? 12 : 4)));

      const sp = useArc.getState().local.speaking;
      let lvl = 0;
      if (sp && voiceOut.analyser) {
        voiceOut.analyser.getByteFrequencyData(freq);
        let sum = 0;
        for (let i = 2; i < 30; i++) sum += freq[i];
        lvl = Math.min(1, sum / (28 * 150));
      }
      speak += ((sp ? 0.35 + lvl * 0.65 : 0) - speak) * (1 - Math.exp(-dt * 10));

      const yaw = face?.sample.head.yaw ?? 0;
      const pitch = face?.sample.head.pitch ?? 0;
      const roll = face?.sample.head.roll ?? 0;
      let ellipse: [number, number, number, number] = [0.5, 0.45, 0.2, 0.28];
      let eye: HudData["eye"] = null;
      let faceCenter = { x: W / 2, y: H * 0.47 };
      if (p) {
        // Fallback silhouette in video uv (the shader mirrors x itself).
        const cxv = (p[234].x + p[454].x) / 2;
        const cyv = (p[10].y + p[152].y) / 2 - 0.02;
        ellipse = [cxv, cyv, Math.abs(p[454].x - p[234].x) * 0.62, Math.abs(p[152].y - p[10].y) * 0.66];
        const a = toScreen(p[473].x, p[473].y);
        const b = toScreen(p[468].x, p[468].y);
        const main = a.x > b.x ? a : b; // viewer-right eye
        const eyeW = Math.hypot((p[263].x - p[362].x) * rect.w, (p[263].y - p[362].y) * rect.h);
        eye = hasFace ? { x: main.x, y: main.y, r: eyeW * 0.75, blink: Math.max(face!.face.blinkLeft, face!.face.blinkRight) } : null;
        faceCenter = toScreen((p[234].x + p[454].x) / 2, (p[10].y + p[152].y) / 2);
      }
      scene.setLayout({ rect, screen: { w: W, h: H }, ellipse, faceCenter, presence, speak, time: t, parallax: { x: (yaw / 90) * 0.012, y: (pitch / 90) * 0.012 } });

      // HUD: repaint every frame; on slow machines every other frame if we're falling behind.
      if (++panelCheck % 30 === 1) {
        const panel = document.querySelector(".vpanel");
        rightPanelX = panel ? panel.getBoundingClientRect().left : W * 0.76;
      }
      const repaint = !(WEAK && frameMs > 24 && hudSkip++ % 2 === 1);
      if (repaint) {
        const st = useArc.getState();
        const tgtEl = document.querySelector<HTMLElement>(".visor .is-hand-hover");
        const tr = tgtEl?.getBoundingClientRect();
        painter.paint(
          {
            t,
            boot: (now - born) / 1000,
            W,
            H,
            yaw,
            pitch,
            roll,
            eye,
            face: st.visor.face,
            hands: st.visor.hands,
            handPoints: gestures.hands.map((h) => h.pointer),
            cpu: st.telemetry?.cpu ?? null,
            mem: st.telemetry?.memory ?? null,
            latency: st.conn.latencyMs ?? null,
            vision: st.local.perf?.face ?? null,
            activity: st.state?.jarvis.activity ?? "IDLE",
            speaking: sp,
            spectrum: spectrumOf(t),
            context: contextOf(),
            target: tr ? { x: tr.left, y: tr.top, w: tr.width, h: tr.height, label: (tgtEl!.getAttribute("aria-label") ?? tgtEl!.textContent ?? "").trim().slice(0, 28) } : null,
            alert: !hasFace && presence < 0.5 && now - born > 2500 ? "REACQUIRING FACE" : null,
            rightPanelX,
            compact: H < 520,
          },
          hudScale,
        );
      }
      scene.render(repaint);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      off();
      ro.disconnect();
      scene.canvas.remove();
      scene.dispose();
    };
  }, []);

  return <div className="helmet" ref={host} />;
}
