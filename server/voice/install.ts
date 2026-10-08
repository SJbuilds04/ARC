// `npm run setup` (second half): installs the Piper voice engine and JARVIS's default voice.
// The server also does this by itself on first start; this just gets it out of the way up front.
import { config } from "../config";
import { VoiceLibrary } from "./VoiceLibrary";

const lib = new VoiceLibrary(config.voicesDir, config.piperDir);
let shown = "";
lib.on("change", () => {
  const d = lib.download;
  if (!d) return;
  const line = d.error ? `  ✗ ${d.label} — ${d.error}` : `  ↓ ${d.label} ${Math.floor(d.progress * 10) * 10}%`;
  if (line !== shown) console.log((shown = line));
});

console.log("ARC voice setup");
const engine = await lib.ensureEngine();
console.log(engine ? "  ✓ Piper voice engine" : "  ✗ Piper voice engine — JARVIS will use the Windows voice");
if (engine && !lib.files(config.defaultVoice)) await lib.add(config.defaultVoice).catch(() => undefined);
console.log(lib.files(config.defaultVoice) ? `  ✓ voice ${config.defaultVoice}` : `  ✗ voice ${config.defaultVoice} (add one later in Settings → JARVIS VOICE)`);
