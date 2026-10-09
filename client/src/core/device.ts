import type { DeviceRole } from "@shared/types";

/**
 * Which ARC device this browser is.
 *  - Opened on the ARC machine (localhost)      → PC console
 *  - Opened from the pairing QR / on the LAN    → PHONE
 *  - `?device=phone` / `?device=pc` overrides (e.g. testing the phone UI on the PC).
 */
const params = new URLSearchParams(location.search);
const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
// ?device=pc|phone overrides, and is remembered (another computer opened once with ?device=pc stays a PC)
const override = (() => {
  const asked = params.get("device")?.toUpperCase();
  try {
    if (asked === "PC" || asked === "PHONE") localStorage.setItem("arc.device", asked);
    return asked ?? localStorage.getItem("arc.device") ?? undefined;
  } catch {
    return asked;
  }
})();

export const ROLE: DeviceRole = override === "PHONE" || override === "PC" ? override : local ? "PC" : "PHONE";

export const PAIR_TOKEN = params.get("pair") ?? undefined;

const TOKEN_KEY = "arc.deviceToken";

export function loadDeviceToken(): string | undefined {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveDeviceToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private mode) — the phone will need to re-pair next time
  }
}

export function deviceName(): string {
  if (ROLE === "PC") return "ARC Desktop";
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  const android = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/);
  return android?.[1]?.trim() || "Phone";
}

/** Drop the one-time pairing token from the address bar without reloading. */
export function clearPairParam(): void {
  if (!params.has("pair")) return;
  params.delete("pair");
  const qs = params.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}`);
}

export function prefs<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(`arc.${key}`);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(`arc.${key}`, JSON.stringify(value));
  } catch {
    // ignore
  }
}
