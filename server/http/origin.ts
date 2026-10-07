import os from "node:os";
import { config, lanAddresses } from "../config";

/**
 * Requests that can change things (WebSocket, uploads) must come from ARC's own pages.
 * This blocks other websites open in a browser on this PC from driving ARC via localhost.
 */
export function allowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    const hosts = new Set(["localhost", "127.0.0.1", os.hostname().toLowerCase(), ...lanAddresses()]);
    return u.protocol === "https:" && hosts.has(u.hostname.toLowerCase()) && Number(u.port || 443) === config.port;
  } catch {
    return false;
  }
}

export const isLoopback = (addr = "") => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
