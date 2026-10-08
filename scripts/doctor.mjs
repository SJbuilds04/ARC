// npm run doctor — checks that ARC is installed correctly and says how to fix anything that isn't.
// Read-only: it never changes or downloads anything.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const at = (...p) => path.join(root, ...p);
const env = loadEnv();
const port = Number(process.env.ARC_PORT || env.ARC_PORT || 7777);
let problems = 0;
let warnings = 0;

const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg, fix) => {
  problems++;
  console.log(`  ✗ ${msg}\n      → ${fix}`);
};
const warn = (msg, fix) => {
  warnings++;
  console.log(`  ! ${msg}${fix ? `\n      → ${fix}` : ""}`);
};

// No process.exit() anywhere: on Windows it can trip over a network handle that's still closing.
await main();
finish();

async function main() {
  console.log("\nARC doctor\n");

  // ── Node.js ──
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major > 22 || (major === 22 && minor >= 12)) ok(`Node.js ${process.versions.node}`);
  else bad(`Node.js ${process.versions.node} is too old`, "install the LTS version from https://nodejs.org (22.12 or newer)");

  // ── Install ──
  if (!fs.existsSync(at("package.json")) || JSON.parse(fs.readFileSync(at("package.json"), "utf8")).name !== "arc") {
    bad("This doesn't look like the ARC folder", "open a terminal inside the ARC folder and run npm run doctor again");
    return;
  }
  if (fs.existsSync(at("node_modules", "three")) && fs.existsSync(at("node_modules", "tsx"))) ok("Dependencies installed");
  else bad("Dependencies are missing", "run npm ci");

  const assets = ["client/public/models/hand_landmarker.task", "client/public/models/face_landmarker.task", "client/public/mediapipe"];
  const missingAssets = assets.filter((a) => !fs.existsSync(at(a)));
  if (!missingAssets.length) ok("Hand / face tracking models downloaded");
  else bad(`Tracking assets missing (${missingAssets.map((a) => path.basename(a)).join(", ")})`, "run npm run setup");

  const piper = at("vendor", "piper", process.platform === "win32" ? "piper.exe" : "piper");
  const voices = fs.existsSync(at("voices")) ? fs.readdirSync(at("voices")).filter((f) => f.endsWith(".onnx")) : [];
  if (fs.existsSync(piper) && voices.length) ok(`JARVIS's voice installed (Piper · ${voices.length} voice${voices.length === 1 ? "" : "s"})`);
  else warn("JARVIS's voice (Piper) isn't installed yet", "run npm run setup — or just start ARC: it downloads it on first start");

  if (fs.existsSync(at("client", "dist", "index.html"))) ok("Interface built");
  else bad("The interface isn't built", "run npm run build");

  // ── Groq ──
  const key = (process.env.GROQ_API_KEY || env.GROQ_API_KEY || "").trim();
  if (!fs.existsSync(at(".env"))) warn("No .env settings file yet", "run npm run configure to connect JARVIS to Groq");
  if (!key) warn("No Groq key: JARVIS can't chat or hear you (local commands, 3D and the visor still work)", "run npm run configure");
  else {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      if (res.ok) ok("Groq key works");
      else if (res.status === 401) bad("Groq rejected the key", "create a new key at https://console.groq.com and run npm run configure");
      else warn(`Groq answered ${res.status} (try again later)`);
    } catch {
      warn("Couldn't reach Groq (no internet?) — JARVIS needs it for conversation");
    }
  }

  // ── Network ──
  const portState = await new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (e) => resolve(e.code === "EADDRINUSE" ? "busy" : "error"));
    s.once("listening", () => s.close(() => resolve("free")));
    s.listen(port, "0.0.0.0");
  });
  if (portState === "free") ok(`Port ${port} is free`);
  else if (await arcRunning()) ok(`ARC is running → https://localhost:${port}`);
  else bad(`Port ${port} is used by another program`, "close it, or set ARC_PORT=7778 (any free port) in .env");

  const lan = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/vethernet|virtualbox|vmware|wsl|docker|loopback/i.test(name))
    .flatMap(([, ifs]) => (ifs ?? []).filter((i) => i.family === "IPv4" && !i.internal).map((i) => i.address));
  if (lan.length) ok(`Phone address: https://${lan[0]}:${port} (phone and PC on the same Wi-Fi)`);
  else warn("No Wi-Fi / network address found: the phone can't connect, the PC console still works");

  const dataDir = process.env.ARC_DATA_DIR ? path.resolve(process.env.ARC_DATA_DIR) : at(".arc");
  if (fs.existsSync(path.join(dataDir, "certs", "cert.pem"))) ok("Local HTTPS certificate created");
  else console.log("  · The local HTTPS certificate is created on first start (your browser will ask you to trust it once).");
}

function finish() {
  console.log("");
  if (problems) console.log(`${problems} thing${problems === 1 ? "" : "s"} to fix (see → above).`);
  else console.log(warnings ? "ARC is ready (with the notes above)." : "Everything looks good. Start ARC with npm start.");
  console.log("");
  process.exitCode = problems ? 1 : 0;
}

function loadEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(root, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env yet
  }
  return out;
}

function arcRunning() {
  return new Promise((resolve) => {
    const req = https.get({ host: "localhost", port, path: "/", rejectUnauthorized: false, timeout: 3000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(/ARC/.test(body)));
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}
