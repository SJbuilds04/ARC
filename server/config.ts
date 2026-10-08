import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const envFile = path.join(ROOT, ".env");
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

/** Session, pairing and certificate storage. Override to run an isolated instance (e.g. for tests). */
export const DATA_DIR = process.env.ARC_DATA_DIR ? path.resolve(process.env.ARC_DATA_DIR) : path.join(ROOT, ".arc");

const env = (key: string, fallback = "") => (process.env[key] ?? "").trim() || fallback;
const list = (value: string) =>
  value
    .split(/[,;]/)
    .map((v) => v.trim())
    .filter(Boolean);

const home = os.homedir();

export const config = {
  port: Number(env("ARC_PORT", "7777")),
  groq: {
    apiKey: env("GROQ_API_KEY"),
    models: [env("GROQ_MODEL", "qwen/qwen3.8-27b"), ...list(env("GROQ_FALLBACK_MODELS", "openai/gpt-oss-120b,openai/gpt-oss-20b"))],
    sttModel: env("GROQ_STT_MODEL", "whisper-large-v3-turbo"),
    ttsModel: env("GROQ_TTS_MODEL", "canopylabs/orpheus-v1-english"),
    ttsVoice: env("GROQ_TTS_VOICE", "daniel"),
  },
  fileRoots: list(env("ARC_FILE_ROOTS")).length
    ? list(env("ARC_FILE_ROOTS")).map((p) => path.resolve(p))
    : ["Desktop", "Documents", "Downloads"].map((d) => path.join(home, d)).filter((p) => fs.existsSync(p)),
  createDir: path.join(home, "Documents", "ARC"),
  /** 3D model library folder (drop .glb/.gltf/.obj/.stl/.fbx files here). */
  modelsDir: env("ARC_MODELS_DIR") ? path.resolve(env("ARC_MODELS_DIR")) : path.join(ROOT, "models"),
  /** Where files sent from the phone land (anything that isn't a 3D model). */
  inboxDir: env("ARC_INBOX_DIR") ? path.resolve(env("ARC_INBOX_DIR")) : path.join(home, "Downloads", "ARC"),
  /** Piper speech engine — JARVIS's voice. Installed by `npm run setup` (or on first start). */
  piperDir: env("ARC_PIPER_DIR") ? path.resolve(env("ARC_PIPER_DIR")) : path.join(ROOT, "vendor", "piper"),
  /** JARVIS's voices: Piper .onnx + .onnx.json pairs (add more from Settings → JARVIS VOICE). */
  voicesDir: env("ARC_VOICES_DIR") ? path.resolve(env("ARC_VOICES_DIR")) : path.join(ROOT, "voices"),
  /** The voice JARVIS starts with until another is picked in Settings. */
  defaultVoice: env("ARC_VOICE", "en_US-bryce-medium"),
  /** Backup voice (Windows speech) when Piper can't speak. "off" disables it. */
  localVoice: env("ARC_LOCAL_VOICE", "George"),
  autoExecuteLowRisk: env("ARC_AUTO_EXECUTE_LOW_RISK", "false").toLowerCase() === "true",
  clientDist: path.join(ROOT, "client", "dist"),
};

export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
    if (/vethernet|virtualbox|vmware|wsl|docker|loopback/i.test(name)) continue;
    for (const i of ifaces ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}
