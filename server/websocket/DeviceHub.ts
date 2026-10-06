import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import { WebSocketServer, WebSocket } from "ws";
import { ClientMessageSchema, type ClientMessage } from "../../shared/schemas";
import type { DeviceRole, ServerMessage } from "../../shared/types";
import type { ArcCore } from "../core/ArcCore";
import type { PairingRegistry } from "../security/pairing";
import type { Jarvis, Outbound } from "../jarvis/Jarvis";
import { config, lanAddresses } from "../config";
import { memoryUsage, sampleCpu } from "../actions/system";
import os from "node:os";

export const WS_PATH = "/arc-ws";
const HELLO_TIMEOUT_MS = 5000;
const HEARTBEAT_MS = 10_000;

interface Client {
  id: string;
  ws: WebSocket;
  role: DeviceRole | null;
  deviceId: string | null;
  loopback: boolean;
  alive: boolean;
  pingSentAt: number;
  lastAudioAt: number;
}

const isLoopback = (addr = "") => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

/**
 * DeviceHub — the persistent WebSocket link between ARC Core and its devices.
 * One socket per device for the life of the session; it carries state, voice,
 * confirmations, hand landmarks and playground commands. Devices reconnect
 * automatically and resume the same session (state lives in ArcCore, not here).
 */
export class DeviceHub implements Outbound {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024, perMessageDeflate: false });
  private readonly clients = new Set<Client>();
  private jarvis: Jarvis | null = null;

  constructor(
    server: Server,
    private readonly core: ArcCore,
    private readonly pairing: PairingRegistry,
  ) {
    server.on("upgrade", (req, socket, head) => this.onUpgrade(req, socket, head));
    this.wss.on("connection", (ws, req) => this.onConnection(ws, req));

    core.on("state", (state) => this.broadcast({ type: "STATE", state }));
    core.on("mode-transition", (t) => this.broadcast({ type: "MODE_TRANSITION", ...t }));
    core.on("camera-switch", (c) => this.broadcast({ type: "CAMERA_SWITCH", ...c }));
    core.on("vision-lost", ({ source, reason }) =>
      this.broadcast({ type: "NOTIFY", level: "error", code: "VISION_LOST", title: "VISION SOURCE LOST", text: `${source} CAMERA · ${reason}` }),
    );

    setInterval(() => this.heartbeat(), HEARTBEAT_MS).unref();
    setInterval(() => this.broadcast({ type: "TELEMETRY", cpu: sampleCpu(), memory: memoryUsage(), uptime: os.uptime(), t: Date.now() }), 3000).unref();
  }

  attach(jarvis: Jarvis): void {
    this.jarvis = jarvis;
  }

  // ─── Outbound ───

  broadcast(msg: ServerMessage): void {
    const data = JSON.stringify(msg);
    for (const c of this.clients) if (c.role && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }

  sendTo(role: DeviceRole, msg: ServerMessage): boolean {
    const c = this.byRole(role);
    if (!c) return false;
    c.ws.send(JSON.stringify(msg));
    return true;
  }

  isConnected(role: DeviceRole): boolean {
    return Boolean(this.byRole(role));
  }

  private byRole(role: DeviceRole): Client | undefined {
    for (const c of this.clients) if (c.role === role && c.ws.readyState === WebSocket.OPEN) return c;
    return undefined;
  }

  private send(c: Client, msg: ServerMessage): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
  }

  // ─── Connection lifecycle ───

  private allowedOrigin(origin: string | undefined): boolean {
    if (!origin) return false;
    try {
      const u = new URL(origin);
      const hosts = new Set(["localhost", "127.0.0.1", os.hostname().toLowerCase(), ...lanAddresses()]);
      return u.protocol === "https:" && hosts.has(u.hostname.toLowerCase()) && Number(u.port || 443) === config.port;
    } catch {
      return false;
    }
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? "").split("?")[0];
    if (path !== WS_PATH) return; // not ours
    // Blocks other websites open in a browser on this PC from driving ARC via localhost.
    if (!this.allowedOrigin(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws, req));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const client: Client = {
      id: randomUUID(),
      ws,
      role: null,
      deviceId: null,
      loopback: isLoopback(req.socket.remoteAddress),
      alive: true,
      pingSentAt: 0,
      lastAudioAt: 0,
    };
    this.clients.add(client);
    const helloTimer = setTimeout(() => !client.role && ws.close(4000, "HELLO timeout"), HELLO_TIMEOUT_MS);

    ws.on("pong", () => {
      client.alive = true;
      if (client.role && client.pingSentAt) this.core.setLatency(client.role, Date.now() - client.pingSentAt);
    });
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg: ClientMessage;
      try {
        const parsed = ClientMessageSchema.safeParse(JSON.parse(raw.toString()));
        if (!parsed.success) {
          this.send(client, { type: "ERROR", code: "BAD_MESSAGE", message: parsed.error.issues[0]?.message ?? "Invalid message" });
          return;
        }
        msg = parsed.data;
      } catch {
        return;
      }
      if (msg.type === "HELLO") {
        clearTimeout(helloTimer);
        void this.onHello(client, msg);
        return;
      }
      if (!client.role) return; // unauthenticated clients may only say HELLO
      try {
        this.route(client, msg);
      } catch (err) {
        console.error(`[hub] error handling ${msg.type}:`, err);
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      this.clients.delete(client);
      if (client.role && !this.byRole(client.role)) {
        this.core.deviceDisconnected(client.role);
        console.log(`[hub] ${client.role} disconnected`);
      }
    });
    ws.on("error", (err) => console.warn("[hub] socket error:", err.message));
  }

  private async onHello(client: Client, hello: Extract<ClientMessage, { type: "HELLO" }>): Promise<void> {
    let deviceToken: string | undefined;
    const known = hello.role === "PHONE" && hello.deviceToken ? this.pairing.authenticate(hello.deviceToken) : null;

    if (hello.role === "PC") {
      // The desktop console must run on this machine.
      if (!client.loopback) return this.reject(client, "PC_REMOTE", "The PC console can only be opened on the ARC machine.");
      client.deviceId = "pc-local";
    } else if (known) {
      client.deviceId = known.id;
    } else if (hello.pairToken) {
      const paired = this.pairing.pair(hello.pairToken, hello.deviceName);
      if (!paired) return this.reject(client, "PAIR_INVALID", "This pairing code has expired. Scan the QR code on the PC again.");
      client.deviceId = paired.id;
      deviceToken = paired.deviceToken;
      console.log(`[hub] paired new device "${hello.deviceName}"`);
      this.refreshPairingInfo();
    } else if (client.loopback) {
      client.deviceId = "phone-local"; // phone UI opened on the PC itself (testing)
    } else {
      return this.reject(client, "PAIRING_REQUIRED", "Scan the pairing QR code on the PC to connect.");
    }

    // One live socket per role: a newer tab/device supersedes the old one.
    for (const other of this.clients) {
      if (other !== client && other.role === hello.role) {
        other.role = null;
        other.ws.close(4001, "Superseded by a newer connection");
      }
    }
    client.role = hello.role;
    this.core.deviceConnected(hello.role, hello.deviceName);
    this.send(client, {
      type: "WELCOME",
      deviceId: client.deviceId!,
      role: hello.role,
      deviceToken,
      state: this.core.getState(),
      serverTime: Date.now(),
    });
    console.log(`[hub] ${hello.role} connected (${hello.deviceName})`);
  }

  private reject(client: Client, code: string, message: string): void {
    this.send(client, { type: "ERROR", code, message });
    client.ws.close(4003, code);
  }

  private route(client: Client, msg: ClientMessage): void {
    const role = client.role!;
    const jarvis = this.jarvis;
    switch (msg.type) {
      case "PING":
        this.send(client, { type: "PONG", t: msg.t, serverTime: Date.now() });
        return;
      case "UTTERANCE":
        jarvis?.handleUtterance(msg.text, role);
        return;
      case "AUDIO": {
        const now = Date.now();
        if (now - client.lastAudioAt < 300) return; // basic flood guard
        client.lastAudioAt = now;
        void jarvis?.handleAudio(Buffer.from(msg.data, "base64"), msg.mime, role, msg.handsFree);
        return;
      }
      case "CONFIRM_RESPONSE":
        jarvis?.confirm(msg.id, msg.approved, msg.via);
        return;
      case "ACTION_REQUEST":
        jarvis?.requestAction(msg.action, role);
        return;
      case "CANCEL":
        jarvis?.cancel();
        return;
      case "VISION_STATUS":
        if (msg.source === role) this.core.setVisionStatus(role, { status: msg.status, error: msg.error, fps: msg.fps, hands: msg.hands });
        return;
      case "HAND_FRAME": {
        if (msg.source !== role) return;
        // Relay landmarks to every consumer of this source that isn't the sender.
        const data = JSON.stringify(msg);
        for (const route of this.core.getState().vision.routes) {
          if (route.source !== role || route.consumer === role) continue;
          const target = this.byRole(route.consumer);
          if (target && target.ws.bufferedAmount < 256 * 1024) target.ws.send(data);
        }
        return;
      }
      case "GESTURE":
        return;
      case "VISOR_STATUS": {
        const { face, gaze, hands, confidence, calibrated, target } = msg;
        const { mode, visor } = this.core.getState();
        const runsGaze = (mode === "VISOR" && visor.device === role) || (mode === "PLAYGROUND" && role === "PC");
        if (runsGaze) this.core.setVisorStatus({ face, gaze, hands, confidence, calibrated, target });
        return;
      }
      case "JARVIS_ACTIVITY":
        if (role === this.core.getState().primaryDevice) this.core.setActivity(msg.activity);
        return;
      case "SCENE_STATE":
        if (role === "PC") this.core.setScene(msg.scene);
        return;
      case "REQUEST_PAIRING":
        if (role === "PC") void this.sendPairingInfo(client);
        return;
      case "UNPAIR":
        if (role !== "PC") return;
        if (this.pairing.unpair(msg.deviceId)) {
          for (const c of this.clients) if (c.deviceId === msg.deviceId) c.ws.close(4004, "Unpaired");
        }
        this.refreshPairingInfo();
        return;
      case "HELLO":
        return;
    }
  }

  private refreshPairingInfo(): void {
    const pc = this.byRole("PC");
    if (pc) void this.sendPairingInfo(pc);
  }

  private async sendPairingInfo(client: Client): Promise<void> {
    const addresses = lanAddresses();
    const { token, expiresAt } = this.pairing.currentPairToken();
    const host = addresses[0] ?? "localhost";
    const url = `https://${host}:${config.port}/?pair=${encodeURIComponent(token)}`;
    const qrSvg = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#bfefffff", light: "#00000000" } });
    const connected = new Set([...this.clients].filter((c) => c.role === "PHONE" && c.deviceId).map((c) => c.deviceId!));
    this.send(client, { type: "PAIRING_INFO", url, qrSvg, addresses, expiresAt, devices: this.pairing.list(connected) });
  }

  private heartbeat(): void {
    for (const c of this.clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.pingSentAt = Date.now();
      c.ws.ping();
    }
  }
}
