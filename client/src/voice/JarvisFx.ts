/**
 * The JARVIS sound. A clean voice becomes an AI speaking through the suit:
 * - a presence lift and a trimmed low end, so it cuts through like a film mix;
 * - a slight digital doubling (two drifting delay taps, left and right);
 * - a faint metallic shimmer (a short resonant comb on the highs);
 * - a short studio space, or inside the visor a tight, band-limited helmet.
 * `amount` 0 = untouched voice, 1 = full effect. Native Web Audio nodes only — cheap on a phone.
 */

interface Profile {
  hp: number;
  lowmidHz: number;
  lowmid: number;
  presenceHz: number;
  presence: number;
  air: number;
  top: number;
  ratio: number;
  threshold: number;
  double: number;
  studio: number;
  helmet: number;
  shimmer: number;
}

/** Full-effect settings for the two rooms (scaled by `amount`). */
const STUDIO: Profile = { hp: 120, lowmidHz: 280, lowmid: -3, presenceHz: 3000, presence: 3.5, air: 3, top: 18000, ratio: 3, threshold: -22, double: 0.3, studio: 0.24, helmet: 0, shimmer: 0.07 };
const HELMET: Profile = { hp: 170, lowmidHz: 360, lowmid: -4.5, presenceHz: 2500, presence: 5, air: 0, top: 7200, ratio: 4.5, threshold: -26, double: 0.38, studio: 0, helmet: 0.3, shimmer: 0.14 };

/** A stereo reverb tail: decaying noise that darkens as it fades. */
function impulse(ctx: BaseAudioContext, seconds: number, brightness: number, predelay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const pre = Math.floor(predelay * rate);
  const len = pre + Math.floor(seconds * rate);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / rate;
      const k = 0.08 + 0.9 * brightness * Math.exp(-t * 4);
      lp += (Math.random() * 2 - 1 - lp) * k;
      d[i] = lp * Math.exp((-6.9 * t) / seconds);
    }
  }
  return buf;
}

export class JarvisFx {
  readonly input: GainNode;
  private readonly hp: BiquadFilterNode;
  private readonly lowmid: BiquadFilterNode;
  private readonly presence: BiquadFilterNode;
  private readonly air: BiquadFilterNode;
  private readonly top: BiquadFilterNode;
  private readonly comp: DynamicsCompressorNode;
  private readonly double: GainNode;
  private readonly studio: GainNode;
  private readonly helmet: GainNode;
  private readonly shimmer: GainNode;
  private readonly out: GainNode;
  private key = "";

  constructor(
    private readonly ctx: BaseAudioContext,
    destination: AudioNode,
  ) {
    const c = ctx;
    this.input = c.createGain();
    // Piper speaks at full scale and resampling overshoots it a little: leave some headroom
    this.input.gain.value = 0.9;
    const filter = (type: BiquadFilterType, frequency: number, q = 0.7) => {
      const f = c.createBiquadFilter();
      f.type = type;
      f.frequency.value = frequency;
      f.Q.value = q;
      return f;
    };
    this.hp = filter("highpass", 60);
    this.lowmid = filter("peaking", 280, 1.1);
    this.presence = filter("peaking", 3000, 0.9);
    this.air = filter("highshelf", 8500);
    this.top = filter("lowpass", 18000, 0.5);
    this.comp = c.createDynamicsCompressor();
    this.comp.knee.value = 8;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.18;
    this.input.connect(this.hp).connect(this.lowmid).connect(this.presence).connect(this.air).connect(this.top).connect(this.comp);

    this.out = c.createGain();
    this.out.connect(destination);
    this.comp.connect(this.out); // dry

    // digital doubling: two drifting delay taps, panned apart
    this.double = c.createGain();
    this.double.connect(this.out);
    for (const [base, rate, pan] of [
      [0.009, 0.23, -0.35],
      [0.014, 0.37, 0.35],
    ] as const) {
      const delay = c.createDelay(0.05);
      delay.delayTime.value = base;
      const lfo = c.createOscillator();
      lfo.frequency.value = rate;
      const depth = c.createGain();
      depth.gain.value = 0.0011;
      lfo.connect(depth).connect(delay.delayTime);
      lfo.start();
      const panner = c.createStereoPanner();
      panner.pan.value = pan;
      this.comp.connect(delay).connect(panner).connect(this.double);
    }

    // metallic shimmer: a short resonant comb on the top end
    const shimmerHp = filter("highpass", 2600);
    const comb = c.createDelay(0.02);
    comb.delayTime.value = 0.0053;
    const feedback = c.createGain();
    feedback.gain.value = 0.42;
    this.shimmer = c.createGain();
    this.comp.connect(shimmerHp).connect(comb).connect(feedback).connect(comb);
    comb.connect(this.shimmer).connect(this.out);

    // rooms: a short studio, and a tight bright helmet
    const room = (seconds: number, brightness: number, predelay: number) => {
      const conv = c.createConvolver();
      conv.buffer = impulse(c, seconds, brightness, predelay);
      const send = c.createGain();
      this.comp.connect(conv).connect(send).connect(this.out);
      return send;
    };
    this.studio = room(1.1, 0.55, 0.016);
    this.helmet = room(0.32, 0.9, 0.004);
    this.set(0, false, true);
  }

  /** Effect amount 0..1; `inHelmet` for the visor. Glides there so a change never clicks. */
  set(amount: number, inHelmet: boolean, now = false): void {
    const a = Math.max(0, Math.min(1, amount));
    const key = `${a.toFixed(2)}|${inHelmet}`;
    if (key === this.key) return;
    this.key = key;
    const p = inHelmet ? HELMET : STUDIO;
    const t = this.ctx.currentTime;
    const glide = (param: AudioParam, v: number) => (now ? (param.value = v) : param.setTargetAtTime(v, t, 0.12));
    glide(this.hp.frequency, 60 + (p.hp - 60) * a);
    glide(this.lowmid.frequency, p.lowmidHz);
    glide(this.lowmid.gain, p.lowmid * a);
    glide(this.presence.frequency, p.presenceHz);
    glide(this.presence.gain, p.presence * a);
    glide(this.air.gain, p.air * a);
    glide(this.top.frequency, 18000 + (p.top - 18000) * a);
    glide(this.comp.ratio, 1 + (p.ratio - 1) * a);
    glide(this.comp.threshold, p.threshold);
    glide(this.double.gain, p.double * a);
    glide(this.studio.gain, p.studio * a);
    glide(this.helmet.gain, p.helmet * a);
    glide(this.shimmer.gain, p.shimmer * a);
    // compression takes level off and the wet layers add some: about the same loudness at every setting
    glide(this.out.gain, (1 + 0.3 * a) / (1 + 0.45 * a));
  }
}
