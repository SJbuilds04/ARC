/**
 * One Euro filter (Casiez et al.) — low jitter when the hand is still,
 * low lag when it moves fast. Used for the hand pointer.
 */
class LowPass {
  private y: number | null = null;
  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }
  last(): number | null {
    return this.y;
  }
  reset(): void {
    this.y = null;
  }
}

const alpha = (cutoff: number, dt: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuroFilter {
  private x = new LowPass();
  private dx = new LowPass();
  private lastT: number | null = null;

  constructor(
    private minCutoff = 1.5,
    private beta = 3,
    private dCutoff = 1,
  ) {}

  filter(value: number, tMs: number): number {
    const dt = this.lastT === null ? 1 / 60 : Math.max(1e-3, (tMs - this.lastT) / 1000);
    this.lastT = tMs;
    const prev = this.x.last();
    const deriv = prev === null ? 0 : (value - prev) / dt;
    const edx = this.dx.filter(deriv, alpha(this.dCutoff, dt));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.x.filter(value, alpha(cutoff, dt));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastT = null;
  }
}
