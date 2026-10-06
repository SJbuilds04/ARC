import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { ServiceStatus } from "@shared/types";

export function Panel({ children, className = "", title, right, style, cut = 12 }: { children: ReactNode; className?: string; title?: ReactNode; right?: ReactNode; style?: CSSProperties; cut?: number }) {
  return (
    <section className={`panel ${className}`} style={{ ...style, ["--cut" as string]: `${cut}px` }}>
      <div className="panel__inner">
        {title !== undefined && (
          <header className="panel__head">
            <span className="panel__title">{title}</span>
            {right}
          </header>
        )}
        {children}
      </div>
    </section>
  );
}

export type DotTone = "ok" | "warn" | "bad" | "off" | "busy";

export function toneFor(status: ServiceStatus | "ACTIVE" | "IDLE" | "STARTING" | "ERROR" | boolean | undefined): DotTone {
  if (status === true || status === "ONLINE" || status === "ACTIVE") return "ok";
  if (status === "DEGRADED" || status === "STARTING") return "warn";
  if (status === "OFFLINE" || status === "ERROR") return "bad";
  return "off";
}

export function Dot({ tone }: { tone: DotTone }) {
  return <i className={`dot dot--${tone}`} />;
}

export function StatusRow({ label, value, tone }: { label: string; value: ReactNode; tone?: DotTone }) {
  return (
    <div className="status-row">
      <span className="status-row__label">{label}</span>
      <span className={`status-row__value ${tone ? `is-${tone}` : ""}`}>
        {tone && <Dot tone={tone} />}
        {value}
      </span>
    </div>
  );
}

/**
 * Button that must be held (touch, mouse, or a sustained hand pinch via the
 * HandPointer's arc-press / arc-release events) before it fires.
 */
export function HoldButton({ holdMs, onConfirm, className = "", children }: { holdMs: number; onConfirm: () => void; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | null>(null);
  const [holding, setHolding] = useState(false);

  useEffect(() => {
    const el = ref.current!;
    const start = () => {
      if (timer.current) return;
      setHolding(true);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setHolding(false);
        onConfirm();
      }, holdMs);
    };
    const cancel = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      setHolding(false);
    };
    el.addEventListener("arc-press", start);
    el.addEventListener("arc-release", cancel);
    el.addEventListener("pointerdown", start);
    el.addEventListener("pointerup", cancel);
    el.addEventListener("pointerleave", cancel);
    el.addEventListener("pointercancel", cancel);
    return () => {
      cancel();
      el.removeEventListener("arc-press", start);
      el.removeEventListener("arc-release", cancel);
      el.removeEventListener("pointerdown", start);
      el.removeEventListener("pointerup", cancel);
      el.removeEventListener("pointerleave", cancel);
      el.removeEventListener("pointercancel", cancel);
    };
  }, [holdMs, onConfirm]);

  return (
    <button ref={ref} type="button" data-hold className={`${className} ${holding ? "is-holding" : ""}`} style={{ ["--hold-ms" as string]: `${holdMs}ms` }} onClick={(e) => e.preventDefault()}>
      <span className="hold-fill" />
      <span className="hold-label">{children}</span>
    </button>
  );
}

/** Live waveform drawn from a level/analyser source (no React re-renders per frame). */
export function Waveform({ source, bars = 40, className = "" }: { source: () => number | Uint8Array | null; bars?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const history = new Array<number>(bars).fill(0);
    let raf = 0;
    let t = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      t += 0.05;
      const dpr = Math.min(2, window.devicePixelRatio);
      const w = canvas.clientWidth * dpr;
      const h = canvas.clientHeight * dpr;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const src = source();
      let levels: number[];
      if (src instanceof Uint8Array) {
        levels = Array.from({ length: bars }, (_, i) => src[Math.floor((i / bars) * src.length * 0.7)] / 255);
      } else {
        history.push(typeof src === "number" ? src : 0);
        history.shift();
        levels = history;
      }
      ctx.clearRect(0, 0, w, h);
      const gap = w / bars;
      for (let i = 0; i < bars; i++) {
        const idle = 0.05 + 0.04 * Math.sin(t + i * 0.5);
        const v = Math.max(idle, Math.min(1, levels[i] * 1.6));
        const bh = v * h * 0.9;
        const center = 1 - Math.abs(i - bars / 2) / (bars / 2);
        ctx.fillStyle = `rgba(110, 215, 255, ${0.35 + center * 0.6})`;
        ctx.fillRect(i * gap + gap * 0.3, (h - bh) / 2, Math.max(1, gap * 0.4), bh);
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [source, bars]);
  return <canvas ref={ref} className={`waveform ${className}`} />;
}

/** The JARVIS core: concentric rotating rings; state drives speed and glow. */
export function JarvisOrb({ activity, size = 120 }: { activity: string; size?: number }) {
  return (
    <div className={`jarvis-orb is-${activity.toLowerCase()}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 120 120">
        <defs>
          <radialGradient id="orbCore" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#e6fbff" />
            <stop offset="35%" stopColor="#6fdcff" />
            <stop offset="100%" stopColor="#0a4a7a" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle className="orb-ring orb-ring--outer" cx="60" cy="60" r="56" strokeDasharray="4 6" />
        <circle className="orb-ring orb-ring--mid" cx="60" cy="60" r="46" strokeDasharray="60 14 6 14" />
        <circle className="orb-ring orb-ring--inner" cx="60" cy="60" r="36" strokeDasharray="2 4" />
        <path className="orb-ring orb-arc" d="M60 14 A46 46 0 0 1 106 60" />
        <circle className="orb-core" cx="60" cy="60" r="22" fill="url(#orbCore)" />
        <circle className="orb-ring" cx="60" cy="60" r="14" />
      </svg>
    </div>
  );
}

export function Clock({ withDate = false }: { withDate?: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000 * 15);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="clock">
      <span className="clock__time">{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
      {withDate && <span className="clock__date">{now.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</span>}
    </div>
  );
}

export function ArcLogo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`arc-logo ${compact ? "is-compact" : ""}`}>
      <svg viewBox="0 0 170 44" className="arc-logo__mark" aria-label="ARC">
        <path d="M2 42 22 4h4l20 38" />
        <path d="M58 42V4h30a10 10 0 0 1 0 20H64l26 18" />
        <path d="M166 4h-48a12 12 0 0 0-12 12v14a12 12 0 0 0 12 12h48" />
      </svg>
      {!compact && <span className="arc-logo__sub">Augmented Reality Command</span>}
    </div>
  );
}
