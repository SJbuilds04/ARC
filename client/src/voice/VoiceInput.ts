import type { ArcClient } from "../core/ArcClient";
import { setLocal, useArc, notify } from "../core/store";

const TARGET_RATE = 16_000;
const PREROLL_MS = 450;
const SILENCE_END_MS = 850;
const MAX_UTTERANCE_MS = 15_000;
const MIN_SPEECH_MS = 320;

// AudioWorklet that forwards mono Float32 blocks (batched) to the main thread.
const WORKLET = `
class ArcCapture extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor('arc-capture', ArcCapture);`;

/**
 * Microphone → speech segments → JARVIS.
 *  - push-to-talk: begin()/end()
 *  - hands-free: voice-activity detection; the server only acts on segments
 *    that contain the wake word "JARVIS" (or follow-ups within a short window).
 * Audio is captured as PCM so a pre-roll can be kept (the first syllable isn't lost).
 */
export class VoiceInput {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private preroll: Float32Array[] = [];
  private segment: Float32Array[] | null = null;
  private segmentStart = 0;
  private lastVoice = 0;
  private voiceRun = 0;
  private noiseFloor = 0.01;
  private pushToTalk = false;
  private suspendedUntil = 0;
  level = 0;

  constructor(private readonly arc: ArcClient) {}

  get supported(): boolean {
    return Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioWorkletNode !== "undefined";
  }

  /** Opens the microphone. Must be called from a user gesture on mobile. */
  async enable(): Promise<boolean> {
    if (this.ctx) {
      if (this.ctx.state === "suspended") await this.ctx.resume();
      return true;
    }
    if (!this.supported) {
      setLocal({ mic: "error", micError: window.isSecureContext ? "Microphone not supported" : "Microphone needs HTTPS" });
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      this.ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, "arc-capture");
      this.node.port.onmessage = (e) => this.onBlock(e.data as Float32Array);
      source.connect(this.node);
      // Keep the graph pulling without making sound.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.node.connect(mute).connect(this.ctx.destination);
      setLocal({ mic: "idle", micError: undefined });
      return true;
    } catch (err) {
      const name = (err as DOMException).name;
      const message = name === "NotAllowedError" ? "Microphone permission denied" : (err as Error).message || "Microphone unavailable";
      setLocal({ mic: "error", micError: message });
      notify({ level: "error", title: "MICROPHONE", text: message, code: "MIC" });
      return false;
    }
  }

  /** Pause detection while JARVIS is speaking so he never hears himself. */
  suspendFor(ms: number): void {
    this.suspendedUntil = Math.max(this.suspendedUntil, performance.now() + ms);
  }

  begin(): void {
    if (!this.ctx) return;
    this.pushToTalk = true;
    this.segment = [...this.preroll];
    this.segmentStart = performance.now();
    setLocal({ mic: "recording" });
  }

  end(): void {
    if (!this.pushToTalk) return;
    this.pushToTalk = false;
    this.finish(false);
  }

  private onBlock(block: Float32Array): void {
    const rate = this.ctx!.sampleRate;
    const now = performance.now();
    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    this.level = this.level * 0.6 + Math.min(1, rms * 8) * 0.4;

    // Rolling pre-roll buffer.
    this.preroll.push(block);
    const maxBlocks = Math.ceil((PREROLL_MS / 1000) * rate / block.length);
    while (this.preroll.length > maxBlocks) this.preroll.shift();

    if (this.pushToTalk) {
      this.segment!.push(block);
      if (now - this.segmentStart > MAX_UTTERANCE_MS) this.end();
      return;
    }

    const handsFree = useArc.getState().local.handsFree;
    const speaking = useArc.getState().local.speaking;
    if (!handsFree || speaking || now < this.suspendedUntil) {
      if (this.segment) this.segment = null;
      this.voiceRun = 0;
      return;
    }

    const threshold = Math.max(0.012, this.noiseFloor * 3.2);
    const isVoice = rms > threshold;
    if (!this.segment) this.noiseFloor = this.noiseFloor * 0.97 + Math.min(rms, 0.05) * 0.03;

    if (isVoice) {
      this.lastVoice = now;
      this.voiceRun++;
      if (!this.segment && this.voiceRun >= 3) {
        this.segment = [...this.preroll];
        this.segmentStart = now;
        setLocal({ mic: "recording" });
      }
    } else this.voiceRun = 0;

    if (this.segment) {
      this.segment.push(block);
      if (now - this.lastVoice > SILENCE_END_MS || now - this.segmentStart > MAX_UTTERANCE_MS) this.finish(true);
    }
  }

  private finish(handsFree: boolean): void {
    const blocks = this.segment;
    this.segment = null;
    const rate = this.ctx?.sampleRate ?? 48_000;
    const duration = blocks ? (blocks.length * (blocks[0]?.length ?? 0) * 1000) / rate : 0;
    if (!blocks || duration < MIN_SPEECH_MS + PREROLL_MS * (handsFree ? 1 : 0)) {
      setLocal({ mic: this.ctx ? "idle" : "off" });
      return;
    }
    setLocal({ mic: "sending" });
    const wav = encodeWav(blocks, rate);
    this.arc.send({ type: "AUDIO", mime: "audio/wav", data: toBase64(wav), handsFree });
    setTimeout(() => setLocal({ mic: "idle" }), 250);
  }
}

function encodeWav(blocks: Float32Array[], inRate: number): Uint8Array {
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const ratio = inRate / TARGET_RATE;
  const outLen = Math.floor(total / ratio);
  const pcm = new Int16Array(outLen);
  // Concatenate lazily + box-filter downsample.
  let blockIdx = 0;
  let offset = 0;
  const sampleAt = (i: number) => {
    while (blockIdx < blocks.length && i >= offset + blocks[blockIdx].length) {
      offset += blocks[blockIdx].length;
      blockIdx++;
    }
    return blockIdx < blocks.length ? blocks[blockIdx][i - offset] : 0;
  };
  for (let o = 0; o < outLen; o++) {
    const start = Math.floor(o * ratio);
    const end = Math.min(total, Math.floor((o + 1) * ratio));
    let acc = 0;
    for (let i = start; i < end; i++) acc += sampleAt(i);
    const v = Math.max(-1, Math.min(1, acc / Math.max(1, end - start)));
    pcm[o] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  dv.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, TARGET_RATE, true);
  dv.setUint32(28, TARGET_RATE * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  str(36, "data");
  dv.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
