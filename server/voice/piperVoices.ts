import type { VoiceInfo } from "../../shared/types";

/**
 * Piper voices: where to download them from, what to call them, how to time them.
 * Pure helpers (unit-tested); the downloading and the engine live elsewhere.
 */

/** "en_US-bryce-medium": language_REGION-name-quality, the layout of the official voice library. */
const VOICE_KEY = /^([a-z]{2,3})_([A-Z]{2})-([a-z0-9_]+)-(x_low|low|medium|high)$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const SAFE_REPO_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/;

/** A voice ready to download: the file key it is saved under and its two files. */
export interface VoiceSource {
  id: string;
  onnx: string;
  json: string;
}

/** A Hugging Face folder that has to be listed first to find the voice in it. */
export interface VoiceFolder {
  repo: string;
  rev: string;
  path: string;
}

export type ResolvedSource = VoiceSource | VoiceFolder | { error: string };

/** The subset of a Piper .onnx.json that ARC reads. */
export interface PiperConfig {
  dataset?: string;
  audio: { sample_rate: number; quality?: string };
  language?: { code?: string; name_english?: string; country_english?: string };
  espeak?: { voice?: string };
  inference?: { length_scale?: number };
  num_speakers?: number;
}

export const isVoiceId = (id: string): boolean => SAFE_ID.test(id) && !id.includes("..");

const HOW = "Paste a Piper voice link from Hugging Face, or a voice name like en_GB-alan-medium.";

function fromKey(key: string, rev = "main"): VoiceSource {
  const [, family, region, name, quality] = VOICE_KEY.exec(key)!;
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/${encodeURIComponent(rev)}/${family}/${family}_${region}/${name}/${quality}/${key}.onnx`;
  return { id: key, onnx: base, json: `${base}.json` };
}

/**
 * Turn whatever was pasted into download links. Accepts a voice name ("en_GB-alan-medium"), the
 * samples page (rhasspy.github.io/piper-samples/#en_US-bryce-medium), or a Hugging Face link to a
 * voice folder or its .onnx / .onnx.json file. Everything else is refused: voices only come from
 * Hugging Face.
 */
export function resolveVoiceSource(input: string): ResolvedSource {
  const raw = input.trim();
  const bare = raw.replace(/\.onnx(\.json)?$/i, "");
  if (VOICE_KEY.test(bare)) return fromKey(bare);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: HOW };
  }
  if (url.protocol !== "https:") return { error: "Only https links can add a voice." };
  if (url.hostname === "rhasspy.github.io") {
    const key = decodeURIComponent(url.hash.replace(/^#/, ""));
    return VOICE_KEY.test(key) ? fromKey(key) : { error: "Pick a voice on the samples page first, then copy the link." };
  }
  if (url.hostname !== "huggingface.co") return { error: "Voices can only be added from Hugging Face." };

  // /<owner>/<repo>/(tree|blob|resolve)/<rev>/<path…>
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { error: HOW };
  }
  const [owner, name, kind, rev = "main", ...rest] = parts;
  if (!owner || !name || !SAFE_REPO_PART.test(owner) || !SAFE_REPO_PART.test(name)) return { error: HOW };
  if (kind && !["tree", "blob", "resolve"].includes(kind)) return { error: HOW };
  // no tricks hidden in encoded segments ("..%2F..%2F")
  if (parts.some((p) => p === ".." || p === "." || p.includes("/") || p.includes("\\"))) return { error: HOW };
  const repo = `${owner}/${name}`;

  // The official library: <family>/<locale>/<name>/<quality>[/file]
  if (repo === "rhasspy/piper-voices" && rest.length >= 4) {
    const key = `${rest[1]}-${rest[2]}-${rest[3]}`;
    if (VOICE_KEY.test(key)) return fromKey(key, rev);
  }
  const filePath = rest.join("/");
  if (/\.onnx(\.json)?$/i.test(filePath)) {
    const onnxPath = filePath.replace(/\.json$/i, "");
    const id = onnxPath.split("/").pop()!.replace(/\.onnx$/i, "");
    if (!isVoiceId(id)) return { error: "That voice file has a name ARC can't use." };
    const base = `https://huggingface.co/${repo}/resolve/${encodeURIComponent(rev)}/${onnxPath.split("/").map(encodeURIComponent).join("/")}`;
    return { id, onnx: base, json: `${base}.json` };
  }
  return { repo, rev, path: filePath };
}

/** The Hugging Face API listing for a folder. */
export const folderListingUrl = (f: VoiceFolder): string =>
  `https://huggingface.co/api/models/${f.repo}/tree/${encodeURIComponent(f.rev)}${f.path ? "/" + f.path.split("/").map(encodeURIComponent).join("/") : ""}`;

/** Pick the voice out of a folder listing: exactly one .onnx that has its .onnx.json next to it. */
export function voiceFromListing(f: VoiceFolder, entries: { type: string; path: string }[]): VoiceSource | { error: string } {
  const files = new Set(entries.filter((e) => e.type === "file").map((e) => e.path));
  const voices = [...files].filter((p) => p.toLowerCase().endsWith(".onnx") && files.has(`${p}.json`));
  if (!voices.length) return { error: "No Piper voice in that folder (it needs a .onnx file and its .onnx.json)." };
  if (voices.length > 1) return { error: `That folder has ${voices.length} voices. Paste the link to the one you want.` };
  const onnxPath = voices[0];
  const id = onnxPath.split("/").pop()!.replace(/\.onnx$/i, "");
  if (!isVoiceId(id)) return { error: "That voice file has a name ARC can't use." };
  const base = `https://huggingface.co/${f.repo}/resolve/${encodeURIComponent(f.rev)}/${onnxPath.split("/").map(encodeURIComponent).join("/")}`;
  return { id, onnx: base, json: `${base}.json` };
}

/** A Piper config ARC can run, or null. */
export function parseVoiceConfig(json: unknown): PiperConfig | null {
  if (!json || typeof json !== "object") return null;
  const c = json as Record<string, unknown>;
  const audio = c.audio as { sample_rate?: unknown } | undefined;
  if (!audio || typeof audio.sample_rate !== "number" || audio.sample_rate < 8000) return null;
  if (!c.phoneme_id_map || typeof c.phoneme_id_map !== "object") return null;
  return c as unknown as PiperConfig;
}

const titleCase = (s: string) =>
  s
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");

/** What the voice library shows for a voice. */
export function describeVoice(id: string, cfg: PiperConfig, bytes: number): VoiceInfo {
  const key = VOICE_KEY.exec(id);
  const lang = cfg.language;
  const language = lang?.name_english ? (lang.country_english ? `${lang.name_english} (${lang.country_english})` : lang.name_english) : (lang?.code ?? cfg.espeak?.voice ?? "Unknown");
  return {
    id,
    name: titleCase(key ? key[3] : (cfg.dataset ?? id)),
    language,
    quality: (cfg.audio.quality ?? key?.[4] ?? "").replace("_", "-"),
    speakers: Math.max(1, cfg.num_speakers ?? 1),
    sizeMb: Math.round(bytes / 1e5) / 10,
  };
}

/**
 * Speed and pitch → Piper's phoneme length and the playback rate. The client shifts pitch by playing
 * faster or slower (`rate`), which also changes the tempo — so Piper speaks that much slower or faster
 * to cancel it out, and only the pitch changes. `baseLength` is the voice's own default length.
 */
export function voiceTiming(speed: number, pitch: number, baseLength = 1): { lengthScale: number; rate: number } {
  const rate = Math.pow(2, pitch / 12);
  return { lengthScale: Math.round(((baseLength * rate) / speed) * 1000) / 1000, rate: Math.round(rate * 10000) / 10000 };
}

/** Find an installed voice by id or by what someone would call it ("bryce", "northern english male"). */
export function findVoice(voices: VoiceInfo[], query: string): VoiceInfo | null {
  const q = query.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!q) return null;
  return (
    voices.find((v) => v.id.toLowerCase() === query.toLowerCase()) ??
    voices.find((v) => v.name.toLowerCase() === q) ??
    voices.find((v) => q.includes(v.name.toLowerCase()) || v.name.toLowerCase().includes(q)) ??
    null
  );
}
