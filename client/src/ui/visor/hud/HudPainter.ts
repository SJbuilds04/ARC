/**
 * The visor HUD, drawn crisp on a 2D canvas every frame (then curved + glowed by VisorScene).
 * Avengers-era look: thin white/cyan lines, small sharp type, orange only for targets and alerts.
 * The centre stays clear for your face; everything lives around the periphery.
 */

export interface HudData {
  t: number;
  /** Seconds since the visor booted (drives the draw-in sequence). */
  boot: number;
  W: number;
  H: number;
  yaw: number;
  pitch: number;
  roll: number;
  eye: { x: number; y: number; r: number; blink: number } | null;
  face: string;
  hands: string;
  handPoints: { x: number; y: number }[];
  cpu: number | null;
  mem: number | null;
  latency: number | null;
  vision: number | null;
  activity: string;
  speaking: boolean;
  spectrum: (n: number) => number[];
  context: { kicker: string; title: string };
  target: { x: number; y: number; w: number; h: number; label: string } | null;
  alert: string | null;
  /** Left edge of the right-hand DOM panel (HUD art stays clear of it). */
  rightPanelX: number;
  compact: boolean;
}

const WHITE = (a: number) => `rgba(236, 249, 255, ${a})`;
const CYAN = (a: number) => `rgba(110, 214, 255, ${a})`;
const ORANGE = (a: number) => `rgba(255, 158, 64, ${a})`;
const TAU = Math.PI * 2;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const ease = (v: number) => 1 - (1 - clamp01(v)) ** 3;

/**
 * Holographic body scan: contour rings (y, half-width x, half-depth z) for the torso column and
 * the limbs; drawn as rotating ellipses joined by meridians.
 */
type Column = { x: number; arm: boolean; rings: [number, number, number][] };
const BODY: Column[] = [
  {
    x: 0,
    arm: false,
    rings: [
      [1.95, 0.0, 0.0], [1.9, 0.07, 0.08], [1.8, 0.1, 0.11], [1.68, 0.09, 0.1], [1.6, 0.05, 0.05],
      [1.52, 0.2, 0.1], [1.44, 0.24, 0.12], [1.3, 0.22, 0.12], [1.15, 0.18, 0.1], [1.02, 0.16, 0.09], [0.9, 0.19, 0.1], [0.78, 0.2, 0.11],
    ],
  },
  { x: -0.1, arm: false, rings: [[0.74, 0.09, 0.09], [0.5, 0.07, 0.07], [0.3, 0.05, 0.055], [0.08, 0.045, 0.05], [0.0, 0.05, 0.08]] },
  { x: 0.1, arm: false, rings: [[0.74, 0.09, 0.09], [0.5, 0.07, 0.07], [0.3, 0.05, 0.055], [0.08, 0.045, 0.05], [0.0, 0.05, 0.08]] },
  { x: -0.31, arm: true, rings: [[1.46, 0.06, 0.06], [1.25, 0.05, 0.05], [1.05, 0.04, 0.04], [0.85, 0.035, 0.035], [0.72, 0.03, 0.03]] },
  { x: 0.31, arm: true, rings: [[1.46, 0.06, 0.06], [1.25, 0.05, 0.05], [1.05, 0.04, 0.04], [0.85, 0.035, 0.035], [0.72, 0.03, 0.03]] },
];

const HEX = "0123456789ABCDEF";

export class HudPainter {
  private ctx: CanvasRenderingContext2D;
  private streams: { col: string[]; y: number; speed: number }[] = [];
  private bracket = { x: 0, y: 0, w: 0, h: 0, a: 0 };
  private u = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  paint(d: HudData, scale: number): void {
    const { ctx } = this;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, d.W, d.H);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    this.u = d.compact ? Math.max(0.62, d.H / 620) : Math.min(1.25, Math.max(0.8, d.H / 900));
    const reveal = (start: number, dur = 0.6) => ease((d.boot - start) / dur);

    this.frame(d, reveal(0));
    this.rings(d, reveal(0.15, 0.9));
    this.headingTape(d, reveal(0.35));
    this.pitchLadders(d, reveal(0.45));
    this.eyeReticle(d, reveal(0.7));
    this.leftCluster(d, reveal(0.55, 0.8));
    if (!d.compact) this.radar(d, reveal(0.8));
    if (!d.compact) this.dataStreams(d, reveal(1.0));
    this.contextBlock(d, reveal(0.6));
    this.jarvisRing(d, reveal(0.9));
    this.targetBrackets(d);
    if (d.alert) this.alertText(d);
  }

  // ─── helpers ───

  private text(s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "left", weight = 500, mono = true) {
    const { ctx } = this;
    ctx.font = `${weight} ${Math.round(size * this.u * 10) / 10}px ${mono ? '"JetBrains Mono", ui-monospace, monospace' : 'Rajdhani, "Segoe UI", sans-serif'}`;
    ctx.textAlign = align;
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }

  private line(x0: number, y0: number, x1: number, y1: number, color: string, w = 1) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.stroke();
  }

  private arc(x: number, y: number, r: number, a0: number, a1: number, color: string, w = 1) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.arc(x, y, r, a0, a1);
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    ctx.stroke();
  }

  // ─── elements ───

  /** Corner brackets of the visor glass. */
  private frame(d: HudData, a: number) {
    if (a <= 0) return;
    const m = 22 * this.u;
    const L = 46 * this.u * a;
    const c = WHITE(0.55 * a);
    for (const [x, y, sx, sy] of [
      [m, m, 1, 1],
      [d.W - m, m, -1, 1],
      [m, d.H - m, 1, -1],
      [d.W - m, d.H - m, -1, -1],
    ]) {
      this.line(x, y, x + sx * L, y, c, 1.2);
      this.line(x, y, x, y + sy * L, c, 1.2);
      this.line(x + sx * 6, y + sy * 6, x + sx * 6 + sx * L * 0.35, y + sy * 6, CYAN(0.35 * a));
    }
  }

  /** Helmet reticle rings around the view centre — framing the face, never on it. */
  private rings(d: HudData, a: number) {
    if (a <= 0) return;
    const cx = d.W / 2;
    const cy = d.H * 0.47;
    const R = Math.min(d.H * 0.43, d.W * 0.3);
    const t = d.t;
    // Four slow segments with gaps
    for (let k = 0; k < 4; k++) {
      const a0 = t * 0.05 + (k * TAU) / 4 + 0.18;
      this.arc(cx, cy, R, a0, a0 + (TAU / 4 - 0.36) * a, WHITE(0.32 * a), 1);
    }
    // Counter-rotating dashed ring
    this.ctx.setLineDash([2, 7]);
    this.arc(cx, cy, R * 1.05, -t * 0.03, -t * 0.03 + TAU * a, CYAN(0.28 * a), 1);
    this.ctx.setLineDash([]);
    // Tick sectors left and right
    for (const side of [Math.PI, 0]) {
      for (let i = -12; i <= 12; i++) {
        const ang = side + (i * Math.PI) / 120;
        const r0 = R * 0.965;
        const r1 = R * (i % 4 === 0 ? 0.93 : 0.95);
        this.line(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0, cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1, WHITE((i % 4 === 0 ? 0.6 : 0.3) * a));
      }
    }
    // Small triangles at the top/bottom of the ring
    for (const [ang, flip] of [[-Math.PI / 2, 1], [Math.PI / 2, -1]] as const) {
      const x = cx + Math.cos(ang) * R * 1.09;
      const y = cy + Math.sin(ang) * R * 1.09;
      const s = 5 * this.u;
      this.ctx.beginPath();
      this.ctx.moveTo(x - s, y - flip * s);
      this.ctx.lineTo(x + s, y - flip * s);
      this.ctx.lineTo(x, y + flip * s * 0.4);
      this.ctx.closePath();
      this.ctx.fillStyle = CYAN(0.6 * a);
      this.ctx.fill();
    }
  }

  /** Compass tape driven by head yaw. */
  private headingTape(d: HudData, a: number) {
    if (a <= 0) return;
    const cx = d.W / 2;
    const y = 58 * this.u;
    const span = 70; // degrees shown
    const width = Math.min(560 * this.u, d.W * 0.36) * a;
    const heading = (((-d.yaw * 2.2) % 360) + 360) % 360;
    const pxPerDeg = width / span;
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(cx - width / 2, y - 26 * this.u, width, 52 * this.u);
    this.ctx.clip();
    const start = Math.floor((heading - span / 2) / 5) * 5;
    for (let deg = start; deg <= heading + span / 2; deg += 5) {
      const x = cx + (deg - heading) * pxPerDeg;
      const edge = 1 - Math.abs(x - cx) / (width / 2);
      const major = deg % 15 === 0;
      this.line(x, y, x, y + (major ? 9 : 5) * this.u, WHITE((major ? 0.75 : 0.4) * edge * a));
      if (major) {
        const n = ((deg % 360) + 360) % 360;
        const label = n === 0 ? "N" : n === 90 ? "E" : n === 180 ? "S" : n === 270 ? "W" : String(n).padStart(3, "0");
        this.text(label, x, y - 6 * this.u, 10, WHITE(0.8 * edge * a), "center");
      }
    }
    this.ctx.restore();
    this.line(cx - width / 2, y + 12 * this.u, cx + width / 2, y + 12 * this.u, CYAN(0.35 * a));
    // caret + readout
    const s = 5 * this.u;
    this.ctx.beginPath();
    this.ctx.moveTo(cx, y + 13 * this.u);
    this.ctx.lineTo(cx - s, y + 13 * this.u + s * 1.4);
    this.ctx.lineTo(cx + s, y + 13 * this.u + s * 1.4);
    this.ctx.closePath();
    this.ctx.fillStyle = ORANGE(0.9 * a);
    this.ctx.fill();
    this.text(`HDG ${String(Math.round(heading)).padStart(3, "0")}°`, cx, y + 34 * this.u, 10, CYAN(0.85 * a), "center", 600);
  }

  /** Curved pitch ladders either side of the face. */
  private pitchLadders(d: HudData, a: number) {
    if (a <= 0) return;
    const cx = d.W / 2;
    const cy = d.H * 0.47;
    const R = Math.min(d.H * 0.43, d.W * 0.3) * 1.16;
    for (const side of [-1, 1]) {
      for (let i = -8; i <= 8; i++) {
        const ang = (i * Math.PI) / 52;
        const x = cx + side * Math.cos(ang) * R;
        const y = cy + Math.sin(ang) * R;
        const major = i % 4 === 0;
        this.line(x, y, x - side * (major ? 10 : 5) * this.u, y, WHITE((major ? 0.55 : 0.28) * a));
        if (major && i !== 0) this.text(`${-i * 5}`, x + side * 8 * this.u, y + 3 * this.u, 8.5, WHITE(0.45 * a), side > 0 ? "left" : "right");
      }
      // marker following head pitch
      const ang = Math.max(-0.6, Math.min(0.6, (d.pitch * Math.PI) / 180));
      const mx = cx + side * Math.cos(ang) * R;
      const my = cy + Math.sin(ang) * R;
      const s = 6 * this.u;
      this.ctx.beginPath();
      this.ctx.moveTo(mx + side * 2, my);
      this.ctx.lineTo(mx + side * (2 + s * 1.5), my - s);
      this.ctx.lineTo(mx + side * (2 + s * 1.5), my + s);
      this.ctx.closePath();
      this.ctx.strokeStyle = CYAN(0.9 * a);
      this.ctx.lineWidth = 1.2;
      this.ctx.stroke();
    }
    this.text(`PITCH ${d.pitch >= 0 ? "+" : "−"}${Math.abs(d.pitch).toFixed(1)}°`, cx + R + 18 * this.u, cy - R * 0.42, 9, CYAN(0.7 * a), "left");
    this.text(`ROLL ${d.roll >= 0 ? "+" : "−"}${Math.abs(d.roll).toFixed(1)}°`, cx - R - 18 * this.u, cy - R * 0.42, 9, CYAN(0.7 * a), "right");
  }

  /** Small, precise optic reticle on one eye. */
  private eyeReticle(d: HudData, a: number) {
    if (a <= 0 || !d.eye) return;
    const { x, y } = d.eye;
    const r = Math.max(10, d.eye.r * 0.95);
    const t = d.t;
    const sq = 1 - d.eye.blink * 0.75;
    this.ctx.save();
    this.ctx.translate(x, y);
    this.ctx.scale(1, sq);
    for (let k = 0; k < 4; k++) {
      const a0 = (k * TAU) / 4 + t * 0.6;
      this.arc(0, 0, r, a0 + 0.2, a0 + TAU / 4 - 0.2, WHITE(0.8 * a), 1.1);
    }
    this.ctx.restore();
    for (let k = 0; k < 4; k++) {
      const ang = (k * TAU) / 4;
      this.line(x + Math.cos(ang) * r * 1.25, y + Math.sin(ang) * r * 1.25, x + Math.cos(ang) * r * 1.6, y + Math.sin(ang) * r * 1.6, CYAN(0.75 * a), 1);
    }
    this.ctx.beginPath();
    this.ctx.arc(x, y, 1.6, 0, TAU);
    this.ctx.fillStyle = ORANGE(0.95 * a);
    this.ctx.fill();
    // leader to a tiny tag
    const tx = x + r * 2.6;
    const ty = y - r * 1.8;
    this.ctx.beginPath();
    this.ctx.moveTo(x + r * 1.15, y - r * 0.8);
    this.ctx.lineTo(tx - 8 * this.u, ty);
    this.ctx.lineTo(tx + 52 * this.u, ty);
    this.ctx.strokeStyle = WHITE(0.5 * a);
    this.ctx.lineWidth = 1;
    this.ctx.stroke();
    this.text("OPTIC LOCK", tx, ty - 4 * this.u, 8.5, CYAN(0.85 * a), "left", 600);
  }

  /** Suit diagnostics: rotating wireframe, power ring (CPU), readouts, link states. */
  private leftCluster(d: HudData, a: number) {
    if (a <= 0) return;
    const u = this.u;
    const x0 = (d.compact ? 22 : 44) * u;
    const y0 = (d.compact ? 70 : 110) * u;
    this.text("MARK VII", x0, y0, 9, CYAN(0.8 * a), "left", 600);
    this.text("SUIT DIAGNOSTIC", x0 + 62 * u, y0, 9, WHITE(0.55 * a));
    this.line(x0, y0 + 7 * u, x0 + 230 * u * a, y0 + 7 * u, WHITE(0.35 * a));
    this.line(x0, y0 + 7 * u, x0 + 18 * u, y0 + 7 * u, ORANGE(0.9 * a), 2);

    // Holographic body scan (rotating)
    const sx = x0 + 52 * u;
    const sy = y0 + (d.compact ? 150 : 205) * u;
    const sc = (d.compact ? 68 : 92) * u;
    const rot = d.t * 0.6;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const handsOn = d.hands === "TRACKING";
    const ctx = this.ctx;
    for (const col of BODY) {
      const color = col.arm && handsOn ? ORANGE : WHITE;
      const cx = sx + col.x * cos * sc; // column centre swings with the rotation
      // contour rings
      for (const [y, rx, rz] of col.rings) {
        if (rx <= 0) continue;
        const ex = Math.sqrt((rx * cos) ** 2 + (rz * sin) ** 2) * sc;
        ctx.beginPath();
        ctx.ellipse(cx, sy - y * sc, ex, Math.max(0.6, ex * 0.18), 0, 0, TAU);
        ctx.strokeStyle = color(0.42 * a);
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
      // meridians (front, back and sides) joining the rings
      for (let m = 0; m < 4; m++) {
        const ang = rot + (m * TAU) / 4;
        ctx.beginPath();
        col.rings.forEach(([y, rx, rz], i) => {
          const px = cx + Math.cos(ang) * rx * sc;
          const py = sy - y * sc + Math.sin(ang) * rz * sc * 0.18;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.strokeStyle = color((Math.sin(ang) > 0 ? 0.55 : 0.2) * a);
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }
    // scan line sweeping the suit
    const scanY = sy - ((d.t * 0.45) % 1) * 1.95 * sc;
    this.line(sx - 0.55 * sc, scanY, sx + 0.55 * sc, scanY, CYAN(0.55 * a), 1);
    this.line(sx - 0.62 * sc, sy + 4, sx + 0.62 * sc, sy + 4, WHITE(0.3 * a));

    // Power ring = CPU load
    const gx = x0 + (d.compact ? 150 : 178) * u;
    const gy = y0 + (d.compact ? 70 : 82) * u;
    const gr = (d.compact ? 30 : 40) * u;
    const cpu = d.cpu ?? 0;
    this.arc(gx, gy, gr, Math.PI * 0.75, Math.PI * 2.25, WHITE(0.18 * a), 3);
    this.arc(gx, gy, gr, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * (cpu / 100) * a, cpu > 85 ? ORANGE(0.95 * a) : CYAN(0.95 * a), 3);
    for (let i = 0; i <= 10; i++) {
      const ang = Math.PI * 0.75 + (Math.PI * 1.5 * i) / 10;
      this.line(gx + Math.cos(ang) * (gr + 5 * u), gy + Math.sin(ang) * (gr + 5 * u), gx + Math.cos(ang) * (gr + 8 * u), gy + Math.sin(ang) * (gr + 8 * u), WHITE(0.4 * a));
    }
    this.text(d.cpu === null ? "—" : String(Math.round(cpu)), gx, gy + 6 * u, d.compact ? 18 : 22, WHITE(0.95 * a), "center", 600, false);
    this.text("CPU LOAD", gx, gy + gr + 18 * u, 8.5, WHITE(0.55 * a), "center");

    // Readouts
    const rx = x0 + (d.compact ? 112 : 128) * u;
    let ry = y0 + (d.compact ? 132 : 160) * u;
    const row = (k: string, v: string, frac: number | null, warn = false) => {
      this.text(k, rx, ry, 8.5, WHITE(0.5 * a));
      this.text(v, rx + 108 * u, ry, 10, warn ? ORANGE(0.95 * a) : WHITE(0.9 * a), "right", 600);
      if (frac !== null) {
        this.line(rx, ry + 5 * u, rx + 108 * u, ry + 5 * u, WHITE(0.15 * a), 2);
        this.line(rx, ry + 5 * u, rx + 108 * u * clamp01(frac) * a, ry + 5 * u, warn ? ORANGE(0.9 * a) : CYAN(0.85 * a), 2);
      }
      ry += 22 * u;
    };
    row("MEMORY", d.mem === null ? "—" : `${Math.round(d.mem)}%`, d.mem === null ? null : d.mem / 100, (d.mem ?? 0) > 90);
    row("NET LINK", d.latency === null ? "—" : `${d.latency}ms`, d.latency === null ? null : 1 - Math.min(1, d.latency / 300));
    row("OPTICS", d.vision === null ? "—" : `${d.vision}fps`, d.vision === null ? null : Math.min(1, d.vision / 30), (d.vision ?? 30) < 12);
    ry += 4 * u;
    const chip = (k: string, v: string, ok: boolean) => {
      this.text(k, rx, ry, 8.5, WHITE(0.5 * a));
      this.text(v, rx + 108 * u, ry, 8.5, ok ? CYAN(0.9 * a) : ORANGE(0.9 * a), "right", 600);
      ry += 16 * u;
    };
    chip("FACE", d.face, d.face === "TRACKING");
    chip("HANDS", d.hands, d.hands === "TRACKING" || d.hands === "OFF" || d.hands === "STANDBY");
    chip("J.A.R.V.I.S.", d.activity === "IDLE" ? "ONLINE" : d.activity, true);
  }

  /** Mini radar: your hands as blips. */
  private radar(d: HudData, a: number) {
    if (a <= 0) return;
    const u = this.u;
    const x = 110 * u;
    const y = d.H - 150 * u;
    const r = 52 * u;
    this.arc(x, y, r, 0, TAU * a, WHITE(0.35 * a));
    this.arc(x, y, r * 0.6, 0, TAU * a, WHITE(0.18 * a));
    this.line(x - r, y, x + r, y, WHITE(0.12 * a));
    this.line(x, y - r, x, y + r, WHITE(0.12 * a));
    const sweep = d.t * 1.6;
    const g = this.ctx.createConicGradient(sweep - 0.9, x, y);
    g.addColorStop(0, "rgba(110,214,255,0)");
    g.addColorStop(0.14, `rgba(110,214,255,${0.22 * a})`);
    g.addColorStop(0.15, "rgba(110,214,255,0)");
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
    this.ctx.arc(x, y, r, 0, TAU);
    this.ctx.fillStyle = g;
    this.ctx.fill();
    this.line(x, y, x + Math.cos(sweep) * r, y + Math.sin(sweep) * r, CYAN(0.7 * a));
    for (const p of d.handPoints) {
      const bx = x + (p.x - 0.5) * r * 1.6;
      const by = y + (p.y - 0.5) * r * 1.6;
      this.ctx.beginPath();
      this.ctx.arc(bx, by, 2.6 * u, 0, TAU);
      this.ctx.fillStyle = ORANGE(0.95 * a);
      this.ctx.fill();
    }
    this.text("PROXIMITY", x, y + r + 16 * u, 8.5, WHITE(0.5 * a), "center");
  }

  /** Faint scrolling hex columns at the far edges. */
  private dataStreams(d: HudData, a: number) {
    if (a <= 0) return;
    const u = this.u;
    if (!this.streams.length) {
      for (let i = 0; i < 4; i++) {
        this.streams.push({ col: Array.from({ length: 40 }, () => HEX[(Math.random() * 16) | 0] + HEX[(Math.random() * 16) | 0]), y: Math.random() * 400, speed: 18 + Math.random() * 22 });
      }
    }
    const xs = [8 * u, 26 * u, d.W - 26 * u, d.W - 8 * u];
    this.streams.forEach((s, i) => {
      s.y = (s.y + s.speed / 60) % (s.col.length * 12);
      if (Math.random() < 0.05) s.col[(Math.random() * s.col.length) | 0] = HEX[(Math.random() * 16) | 0] + HEX[(Math.random() * 16) | 0];
      for (let k = 0; k < s.col.length; k++) {
        const y = ((k * 12 * u + s.y) % (s.col.length * 12 * u)) + d.H * 0.22;
        if (y > d.H * 0.78) continue;
        this.text(s.col[k], xs[i], y, 7.5, CYAN(0.16 * a), i < 2 ? "left" : "right");
      }
    });
  }

  /** What ARC is doing, above the right-hand panel. */
  private contextBlock(d: HudData, a: number) {
    if (a <= 0) return;
    const u = this.u;
    const x = d.rightPanelX;
    const y = (d.compact ? 70 : 110) * u;
    this.text(d.context.kicker, x, y, 9, CYAN(0.8 * a), "left", 600);
    this.line(x, y + 7 * u, x + 250 * u * a, y + 7 * u, WHITE(0.35 * a));
    this.line(x, y + 7 * u, x + 18 * u, y + 7 * u, ORANGE(0.9 * a), 2);
    // Title shrinks to fit the strip.
    let size = d.compact ? 18 : 26;
    this.ctx.font = `600 ${size * u}px Rajdhani, "Segoe UI", sans-serif`;
    const maxW = 250 * u;
    const tw = this.ctx.measureText(d.context.title).width;
    if (tw > maxW) size = Math.max(11, size * (maxW / tw));
    this.text(d.context.title, x, y + (d.compact ? 28 : 36) * u, size, WHITE(0.95 * a), "left", 600, false);
    // spectrum line
    const n = 48;
    const v = d.spectrum(n);
    const w = 250 * u;
    const by = y + (d.compact ? 46 : 62) * u;
    for (let i = 0; i < n; i++) {
      const h = (2 + v[i] * 16) * u;
      const bx = x + (i / n) * w;
      this.line(bx, by - h / 2, bx, by + h / 2, (d.speaking ? ORANGE : CYAN)((0.35 + v[i] * 0.6) * a), 1.4);
    }
  }

  /** JARVIS voice ring at the bottom centre. */
  private jarvisRing(d: HudData, a: number) {
    if (a <= 0) return;
    const u = this.u;
    const x = d.W / 2;
    const y = d.H - (d.compact ? 150 : 150) * u;
    const r = (d.compact ? 18 : 26) * u;
    const v = d.spectrum(48);
    this.arc(x, y, r, 0, TAU * a, WHITE(0.6 * a), 1.2);
    this.arc(x, y, r * 0.55, d.t * 2, d.t * 2 + Math.PI * 1.3, CYAN(0.7 * a), 1);
    for (let i = 0; i < 48; i++) {
      const ang = (i / 48) * TAU - Math.PI / 2;
      const len = (2 + v[i] * 14) * u;
      this.line(x + Math.cos(ang) * (r + 4 * u), y + Math.sin(ang) * (r + 4 * u), x + Math.cos(ang) * (r + 4 * u + len), y + Math.sin(ang) * (r + 4 * u + len), (d.speaking ? ORANGE : CYAN)((0.3 + v[i] * 0.65) * a), 1.2);
    }
  }

  /** Brackets snap onto whatever your hand is pointing at. */
  private targetBrackets(d: HudData) {
    const b = this.bracket;
    const t = d.target;
    if (t) {
      const pad = 6;
      const k = b.a < 0.05 ? 1 : 0.35;
      b.x += (t.x - pad - b.x) * k;
      b.y += (t.y - pad - b.y) * k;
      b.w += (t.w + pad * 2 - b.w) * k;
      b.h += (t.h + pad * 2 - b.h) * k;
      b.a = Math.min(1, b.a + 0.2);
    } else b.a = Math.max(0, b.a - 0.12);
    if (b.a <= 0) return;
    const L = Math.min(14, b.w / 3, b.h / 3);
    const c = ORANGE(0.95 * b.a);
    for (const [x, y, sx, sy] of [
      [b.x, b.y, 1, 1],
      [b.x + b.w, b.y, -1, 1],
      [b.x, b.y + b.h, 1, -1],
      [b.x + b.w, b.y + b.h, -1, -1],
    ]) {
      this.line(x, y, x + sx * L, y, c, 1.6);
      this.line(x, y, x, y + sy * L, c, 1.6);
    }
    if (t?.label) this.text(`◢ ${t.label.toUpperCase()}`, b.x, b.y - 6, 8.5, ORANGE(0.95 * b.a), "left", 600);
  }

  private alertText(d: HudData) {
    const blink = Math.sin(d.t * 6) > -0.3 ? 1 : 0.35;
    this.text(d.alert!, d.W / 2, d.H * 0.47, 12, ORANGE(0.9 * blink), "center", 600);
  }
}
