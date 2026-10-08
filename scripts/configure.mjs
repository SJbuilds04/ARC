// npm run configure — connects JARVIS to Groq by writing your key into ARC's .env file.
// It changes nothing else, and the key never leaves this PC except to Groq itself.
// Non-interactive: npm run configure -- --key=gsk_...
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

// No process.exit() anywhere: on Windows it can trip over a network handle that's still closing.
process.exitCode = await main();

async function main() {
  const fromArgs = process.argv.find((a) => a.startsWith("--key="))?.slice("--key=".length) ?? "";
  const current = readEnv().match(/^GROQ_API_KEY=(.*)$/m)?.[1]?.trim() ?? "";

  console.log("\nARC · connect JARVIS to Groq\n");
  console.log("JARVIS uses Groq (free) to understand you and to talk back. Getting a key takes a minute:");
  console.log("  1. Sign in at https://console.groq.com");
  console.log('  2. Open "API Keys" → "Create API Key" and copy it (it starts with gsk_)\n');
  if (current) console.log(`A key is already set (${mask(current)}). Paste a new one to replace it, or press Enter to keep it.\n`);

  let key = fromArgs.trim();
  if (!key) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    key = (await rl.question("Groq API key: ")).trim();
    rl.close();
  }
  if (!key) {
    console.log(current ? "\nKept the existing key." : "\nSkipped. ARC still runs (local commands, 3D, the visor) — run `npm run configure` any time to add a key.");
    return 0;
  }
  key = key.replace(/^["']|["']$/g, "");
  if (!/^gsk_[A-Za-z0-9]{20,}$/.test(key)) console.log("\n! That doesn't look like a Groq key (they start with gsk_). Saving it anyway.");

  process.stdout.write("\nChecking the key with Groq… ");
  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) console.log("✓ it works.");
    else if (res.status === 401) {
      console.log("✗ Groq says this key is invalid. Nothing was saved — copy the key again and re-run `npm run configure`.");
      return 1;
    } else console.log(`couldn't confirm (Groq answered ${res.status}). Saving it anyway.`);
  } catch {
    console.log("couldn't reach Groq (offline?). Saving it anyway.");
  }

  writeKey(key);
  console.log("✓ Saved to .env in the ARC folder (it stays on your PC and is never uploaded to GitHub).");
  console.log("\nNext: npm run build, then npm start.\n");
  return 0;
}

function readEnv() {
  if (fs.existsSync(envPath)) return fs.readFileSync(envPath, "utf8");
  if (fs.existsSync(examplePath)) return fs.readFileSync(examplePath, "utf8");
  return "";
}

function writeKey(value) {
  let text = readEnv();
  if (/^GROQ_API_KEY=.*$/m.test(text)) text = text.replace(/^GROQ_API_KEY=.*$/m, `GROQ_API_KEY=${value}`);
  else text = `GROQ_API_KEY=${value}\n${text}`;
  fs.writeFileSync(envPath, text);
}

function mask(k) {
  return k.length > 10 ? `${k.slice(0, 4)}…${k.slice(-4)}` : "set";
}
