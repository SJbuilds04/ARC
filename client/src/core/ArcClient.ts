import type { ClientMessage, ServerMessage, ServerMessageOf } from "@shared/types";
import { Emitter } from "./emitter";
import { ROLE, PAIR_TOKEN, clearPairParam, deviceName, loadDeviceToken, saveDeviceToken } from "./device";
import { useArc, notify, dismissCode } from "./store";

type Events = { [K in ServerMessage["type"]]: ServerMessageOf<K> } & { open: void; close: void };

/** Messages worth delivering after a reconnect. Ephemeral ones (hand frames, pings) are dropped. */
const QUEUEABLE = new Set<ClientMessage["type"]>(["UTTERANCE", "CONFIRM_RESPONSE", "ACTION_REQUEST", "SCENE_STATE", "CANCEL"]);

/**
 * ArcClient — the device's single persistent link to ARC Core.
 * Created once per page load and never recreated. If the socket drops it
 * reconnects with backoff while the UI stays exactly as it is; the server
 * holds the session, so nothing is lost.
 */
export class ArcClient extends Emitter<Events> {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private outbox: ClientMessage[] = [];
  private pairToken = PAIR_TOKEN;
  private welcomed = false;
  private stopped = false;

  constructor() {
    super();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && !this.isOpen() && !this.stopped) this.connectNow();
    });
    window.addEventListener("online", () => !this.isOpen() && !this.stopped && this.connectNow());
  }

  get online(): boolean {
    return this.welcomed && this.isOpen();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Re-take the session after another tab superseded this one. */
  reclaim(): void {
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  /** Forget this device's pairing (phone). The PC must show a new QR to pair again. */
  forget(): void {
    saveDeviceToken(null);
    this.stopped = true;
    this.ws?.close(4000, "Forgotten");
    useArc.setState({ conn: { status: "rejected", error: { code: "UNPAIRED", message: "This phone is no longer paired. Scan the QR code on the PC to pair again." } } });
  }

  send(msg: ClientMessage): void {
    if (this.online) {
      this.ws!.send(JSON.stringify(msg));
      return;
    }
    if (QUEUEABLE.has(msg.type)) {
      this.outbox.push(msg);
      if (this.outbox.length > 50) this.outbox.shift();
    }
  }

  /** Bypasses the queue — only for latency-sensitive streams that are useless when stale. */
  sendVolatile(msg: ClientMessage): void {
    if (this.online && this.ws!.bufferedAmount < 128 * 1024) this.ws!.send(JSON.stringify(msg));
  }

  private isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private connectNow(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const status = this.welcomed || this.attempt > 0 ? "reconnecting" : "connecting";
    useArc.setState((s) => ({ conn: { ...s.conn, status } }));

    const ws = new WebSocket(`wss://${location.host}/arc-ws`);
    this.ws = ws;

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: "HELLO",
          role: ROLE,
          deviceName: deviceName(),
          deviceToken: loadDeviceToken(),
          pairToken: this.pairToken,
        } satisfies ClientMessage),
      );
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "WELCOME") this.onWelcome(msg);
      else if (msg.type === "STATE") useArc.setState({ state: msg.state });
      else if (msg.type === "PONG") useArc.setState((s) => ({ conn: { ...s.conn, latencyMs: Math.round(performance.now() - msg.t) } }));
      else if (msg.type === "ERROR") this.onError(msg);
      this.emit(msg.type, msg as never);
    };

    ws.onclose = (ev) => {
      const wasWelcomed = this.welcomed;
      this.welcomed = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws === ws) this.ws = null;
      this.emit("close", undefined);

      if (ev.code === 4001) {
        this.stopped = true;
        useArc.setState({ conn: { status: "superseded", error: { code: "SUPERSEDED", message: "ARC was opened in another tab." } } });
        return;
      }
      if (ev.code === 4004) {
        saveDeviceToken(null);
        this.stopped = true;
        useArc.setState({ conn: { status: "rejected", error: { code: "UNPAIRED", message: "This phone was unpaired. Scan the QR code on the PC to pair again." } } });
        return;
      }
      if (ev.code === 4003) {
        // Pairing problems won't fix themselves by retrying quickly.
        this.stopped = true;
        return;
      }
      if (wasWelcomed) notify({ level: "warning", title: "CONNECTION LOST", text: "Reconnecting to ARC Core…", code: "CONN" }, 0);
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows and handles retry
    };
  }

  private onWelcome(msg: ServerMessageOf<"WELCOME">): void {
    this.welcomed = true;
    this.attempt = 0;
    if (msg.deviceToken) saveDeviceToken(msg.deviceToken);
    if (this.pairToken) {
      this.pairToken = undefined;
      clearPairParam();
    }
    useArc.setState({ state: msg.state, conn: { status: "online" } });
    dismissCode("CONN");

    const queued = this.outbox.splice(0);
    for (const m of queued) this.ws!.send(JSON.stringify(m));

    if (this.pingTimer) clearInterval(this.pingTimer);
    const ping = () => this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ type: "PING", t: performance.now() }));
    ping();
    this.pingTimer = window.setInterval(ping, 2000);
    this.emit("open", undefined);
  }

  private onError(msg: ServerMessageOf<"ERROR">): void {
    if (["PAIRING_REQUIRED", "PAIR_INVALID", "PC_REMOTE"].includes(msg.code)) {
      if (msg.code === "PAIR_INVALID") this.pairToken = undefined;
      useArc.setState({ conn: { status: "rejected", error: { code: msg.code, message: msg.message } } });
    } else {
      console.warn(`[arc] server error ${msg.code}: ${msg.message}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = Math.min(8000, 400 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt++;
    useArc.setState((s) => ({ conn: { ...s.conn, status: "reconnecting" } }));
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}
