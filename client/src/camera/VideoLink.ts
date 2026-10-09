import type { DeviceRole, RtcSignal, ServerMessageOf } from "@shared/types";
import type { ArcClient } from "../core/ArcClient";

/** The preview only: ~640 px on the long side, 30 fps, under 1 Mbit/s — sharp in the panel, easy on the phone. */
const PREVIEW_LONG_SIDE = 640;
const PREVIEW_BITRATE = 900_000;

/**
 * Live camera video from one device to another (the phone's camera shown on the PC), sent straight
 * over the local network with WebRTC. ARC's server only passes the handshake along; the video never
 * leaves the Wi-Fi. Hand landmarks travel separately (HAND_FRAME), so tracking never waits on video.
 *
 * The sender always makes the offer; the receiver asks for one when it starts watching (and after a
 * reconnect), so either side can start first.
 */
export class VideoLink {
  private pc: RTCPeerConnection | null = null;
  private peer: DeviceRole | null = null;
  private sending: MediaStream | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private retries = 0;
  private retryTimer = 0;
  /** Receiver: the remote video arrived (or went away). */
  onRemote: (stream: MediaStream | null) => void = () => undefined;

  constructor(private readonly arc: ArcClient) {
    arc.on("RTC_SIGNAL", (msg) => void this.onSignal(msg).catch((err) => console.warn("[video-link]", err)));
  }

  /** Sender: stream `stream` to `to`. */
  send(stream: MediaStream, to: DeviceRole): void {
    this.sending = stream;
    this.peer = to;
    this.retries = 0;
    void this.offer().catch((err) => console.warn("[video-link] offer failed", err));
  }

  /** Receiver: ask `from` for its video. */
  receive(from: DeviceRole): void {
    this.sending = null;
    this.peer = from;
    this.signal({ kind: "request" });
  }

  stop(): void {
    if (this.peer) this.signal({ kind: "bye" });
    this.close();
    this.sending = null;
    this.peer = null;
  }

  private newConnection(): RTCPeerConnection {
    // same Wi-Fi: the devices' own addresses are enough, no outside (STUN/TURN) servers
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.onicecandidate = (e) => {
      if (e.candidate && this.pc === pc) this.signal({ kind: "ice", candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      if (this.pc === pc) this.onRemote(e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "connected") this.retries = 0;
      if (pc.connectionState !== "failed") return;
      // a dropped Wi-Fi moment: the sender tries again a few times
      if (this.sending && this.retries++ < 4) {
        clearTimeout(this.retryTimer);
        this.retryTimer = window.setTimeout(() => void this.offer().catch(() => undefined), 1500);
      } else if (!this.sending) this.onRemote(null);
    };
    return pc;
  }

  private async offer(): Promise<void> {
    const stream = this.sending;
    if (!stream || !this.peer) return;
    this.close();
    const pc = (this.pc = this.newConnection());
    for (const track of stream.getVideoTracks()) {
      const s = track.getSettings();
      const scale = Math.max(1, Math.max(s.width ?? PREVIEW_LONG_SIDE, s.height ?? PREVIEW_LONG_SIDE) / PREVIEW_LONG_SIDE);
      pc.addTransceiver(track, {
        direction: "sendonly",
        streams: [stream],
        sendEncodings: [{ maxBitrate: PREVIEW_BITRATE, maxFramerate: 30, scaleResolutionDownBy: scale }],
      });
    }
    const offer = await pc.createOffer();
    if (this.pc !== pc) return;
    await pc.setLocalDescription(offer);
    this.signal({ kind: "offer", sdp: pc.localDescription?.sdp ?? offer.sdp ?? "" });
  }

  private async onSignal(msg: ServerMessageOf<"RTC_SIGNAL">): Promise<void> {
    const { from, signal } = msg;
    if (from !== this.peer) return;
    switch (signal.kind) {
      case "request":
        if (this.sending) {
          this.retries = 0;
          await this.offer();
        }
        return;
      case "offer": {
        if (this.sending || !signal.sdp) return;
        this.close();
        const pc = (this.pc = this.newConnection());
        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        await this.flushIce(pc);
        const answer = await pc.createAnswer();
        if (this.pc !== pc) return;
        await pc.setLocalDescription(answer);
        this.signal({ kind: "answer", sdp: pc.localDescription?.sdp ?? answer.sdp ?? "" });
        return;
      }
      case "answer":
        if (this.pc && this.pc.signalingState === "have-local-offer" && signal.sdp) {
          await this.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
          await this.flushIce(this.pc);
        }
        return;
      case "ice":
        if (!signal.candidate) return;
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(signal.candidate).catch(() => undefined);
        else this.pendingIce.push(signal.candidate);
        return;
      case "bye":
        this.close();
        // the sender stopped: it offers again when it restarts; the receiver keeps waiting
        return;
    }
  }

  private async flushIce(pc: RTCPeerConnection): Promise<void> {
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const c of queued) await pc.addIceCandidate(c).catch(() => undefined);
  }

  private close(): void {
    clearTimeout(this.retryTimer);
    const had = this.pc;
    this.pc = null;
    this.pendingIce = [];
    if (had) {
      had.close();
      if (!this.sending) this.onRemote(null);
    }
  }

  private signal(signal: RtcSignal): void {
    if (this.peer) this.arc.sendVolatile({ type: "RTC_SIGNAL", to: this.peer, signal });
  }
}
