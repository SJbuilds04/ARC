import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { JsonStore } from "../core/store";
import type { PairedDeviceInfo } from "../../shared/types";

interface StoredDevice {
  id: string;
  name: string;
  tokenHash: string;
  pairedAt: number;
  lastSeen: number;
}

const PAIR_TOKEN_TTL = 10 * 60_000;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Device pairing. The PC shows a QR code containing a short-lived pairing token.
 * A phone that presents it receives a long-lived device token (only its hash is
 * stored), which it uses for every later reconnect — no re-pairing needed.
 */
export class PairingRegistry {
  private readonly store = new JsonStore<{ devices: StoredDevice[] }>("devices.json");
  private readonly devices: StoredDevice[];
  private pairToken = "";
  private pairExpires = 0;

  constructor() {
    this.devices = this.store.load({ devices: [] }).devices;
  }

  currentPairToken(): { token: string; expiresAt: number } {
    if (Date.now() > this.pairExpires - 60_000) {
      this.pairToken = randomBytes(16).toString("base64url");
      this.pairExpires = Date.now() + PAIR_TOKEN_TTL;
    }
    return { token: this.pairToken, expiresAt: this.pairExpires };
  }

  /** Exchange a valid pairing token for a new device identity. */
  pair(pairToken: string, name: string): { id: string; deviceToken: string } | null {
    if (!this.pairToken || Date.now() > this.pairExpires || !safeEqual(pairToken, this.pairToken)) return null;
    const deviceToken = randomBytes(32).toString("base64url");
    const device: StoredDevice = {
      id: randomUUID(),
      name: name.slice(0, 60) || "Phone",
      tokenHash: hash(deviceToken),
      pairedAt: Date.now(),
      lastSeen: Date.now(),
    };
    this.devices.push(device);
    // One-time token: rotate so the same QR cannot pair a second device.
    this.pairExpires = 0;
    this.persist();
    return { id: device.id, deviceToken };
  }

  authenticate(deviceToken: string): StoredDevice | null {
    const h = hash(deviceToken);
    const device = this.devices.find((d) => safeEqual(d.tokenHash, h));
    if (!device) return null;
    device.lastSeen = Date.now();
    this.persist();
    return device;
  }

  unpair(id: string): boolean {
    const i = this.devices.findIndex((d) => d.id === id);
    if (i < 0) return false;
    this.devices.splice(i, 1);
    this.persist();
    return true;
  }

  list(connectedIds: Set<string>): PairedDeviceInfo[] {
    return this.devices.map((d) => ({
      id: d.id,
      name: d.name,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      connected: connectedIds.has(d.id),
    }));
  }

  private persist() {
    this.store.save({ devices: this.devices });
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
