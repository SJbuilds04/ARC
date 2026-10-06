import https from "node:https";
import { config, lanAddresses } from "./config";
import { ArcCore } from "./core/ArcCore";
import { PairingRegistry } from "./security/pairing";
import { loadOrCreateCertificate } from "./security/certs";
import { GroqProvider, groqFetch } from "./ai/GroqProvider";
import { GroqVoice } from "./voice/VoiceProvider";
import { ActionExecutor } from "./actions/ActionExecutor";
import { DeviceHub } from "./websocket/DeviceHub";
import { Jarvis } from "./jarvis/Jarvis";
import { serveStatic } from "./http/static";

/**
 * ARC server — boots once and stays up. Every module below is created exactly
 * once for the life of the process; modes, cameras and devices change state,
 * never the objects themselves.
 */
async function main() {
  const core = new ArcCore();
  const pairing = new PairingRegistry();
  const groq = new GroqProvider(config.groq.apiKey, config.groq.models, config.groq.sttModel);
  const voice = new GroqVoice(config.groq.apiKey, config.groq.ttsModel, config.groq.ttsVoice);
  const executor = new ActionExecutor();

  const { key, cert } = await loadOrCreateCertificate();
  const server = https.createServer({ key, cert }, serveStatic);
  const hub = new DeviceHub(server, core, pairing);
  const jarvis = new Jarvis(core, groq, groq, voice, executor, hub);
  hub.attach(jarvis);

  server.listen(config.port, "0.0.0.0", () => {
    const lan = lanAddresses();
    console.log("\n  ARC — AUGMENTED REALITY COMMAND");
    console.log("  ────────────────────────────────");
    console.log(`  PC console   https://localhost:${config.port}`);
    for (const ip of lan) console.log(`  LAN          https://${ip}:${config.port}`);
    console.log(`  Groq         ${config.groq.apiKey ? `configured · ${config.groq.models[0]}` : "NOT CONFIGURED — set GROQ_API_KEY in .env"}`);
    console.log(`  File access  ${config.fileRoots.join(" | ")}`);
    console.log("");
  });

  // Real reachability check for the HUD (lists models; no tokens spent).
  if (config.groq.apiKey) {
    groqFetch(config.groq.apiKey, "/models", { method: "GET" }, 6000)
      .then((res) => core.setService("ai", res.ok ? { status: "ONLINE" } : { status: "OFFLINE", detail: `HTTP ${res.status}` }))
      .catch((err) => core.setService("ai", { status: "OFFLINE", detail: err.message }));
  }

  const shutdown = () => {
    core.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// A single failing request must never take ARC down.
process.on("unhandledRejection", (err) => console.error("[arc] unhandled rejection:", err));
process.on("uncaughtException", (err) => console.error("[arc] uncaught exception:", err));

main().catch((err) => {
  console.error("[arc] failed to start:", err);
  process.exit(1);
});
