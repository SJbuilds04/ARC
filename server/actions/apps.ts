import fs from "node:fs";
import path from "node:path";
import { launch, powershell, runningProcesses } from "./process";

/**
 * Application registry. Known apps are matched first (with precise executable
 * paths and process names); anything else is matched against the Windows Start
 * menu (Get-StartApps), which covers installed desktop and Store apps.
 * Only registered/installed apps can ever be launched.
 */

interface KnownApp {
  id: string;
  name: string;
  aliases: string[];
  /** Candidate executables, first existing wins. */
  exe?: string[];
  args?: string[];
  /** shell:/URI fallback launched through explorer.exe. */
  uri?: string;
  /** Start-menu name to fall back to. */
  startName?: string;
  processes: string[];
  closeable?: boolean;
}

const env = (k: string) => process.env[k] ?? "";
const PF = env("ProgramFiles") || "C:\\Program Files";
const PF86 = env("ProgramFiles(x86)") || "C:\\Program Files (x86)";
const LAD = env("LOCALAPPDATA");
const AD = env("APPDATA");
const SYS = path.join(env("SystemRoot") || "C:\\Windows", "System32");

const KNOWN: KnownApp[] = [
  {
    id: "vscode",
    name: "Visual Studio Code",
    aliases: ["vs code", "vscode", "visual studio code", "code", "v s code"],
    exe: [path.join(LAD, "Programs", "Microsoft VS Code", "Code.exe"), path.join(PF, "Microsoft VS Code", "Code.exe")],
    startName: "Visual Studio Code",
    processes: ["code.exe"],
  },
  {
    id: "chrome",
    name: "Google Chrome",
    aliases: ["chrome", "google chrome"],
    exe: [path.join(PF, "Google", "Chrome", "Application", "chrome.exe"), path.join(PF86, "Google", "Chrome", "Application", "chrome.exe"), path.join(LAD, "Google", "Chrome", "Application", "chrome.exe")],
    startName: "Google Chrome",
    processes: ["chrome.exe"],
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    aliases: ["edge", "microsoft edge"],
    exe: [path.join(PF86, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(PF, "Microsoft", "Edge", "Application", "msedge.exe")],
    processes: ["msedge.exe"],
  },
  {
    id: "firefox",
    name: "Firefox",
    aliases: ["firefox", "mozilla firefox"],
    exe: [path.join(PF, "Mozilla Firefox", "firefox.exe"), path.join(PF86, "Mozilla Firefox", "firefox.exe")],
    processes: ["firefox.exe"],
  },
  {
    id: "brave",
    name: "Brave",
    aliases: ["brave", "brave browser"],
    exe: [path.join(PF, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), path.join(LAD, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")],
    processes: ["brave.exe"],
  },
  { id: "notepad", name: "Notepad", aliases: ["notepad", "note pad"], exe: [path.join(SYS, "notepad.exe")], processes: ["notepad.exe"] },
  { id: "calculator", name: "Calculator", aliases: ["calculator", "calc"], exe: [path.join(SYS, "calc.exe")], processes: ["calculatorapp.exe"] },
  { id: "paint", name: "Paint", aliases: ["paint", "ms paint", "mspaint"], exe: [path.join(SYS, "mspaint.exe")], startName: "Paint", processes: ["mspaint.exe"] },
  {
    id: "explorer",
    name: "File Explorer",
    aliases: ["file explorer", "explorer", "files", "my files", "this pc"],
    exe: [path.join(env("SystemRoot") || "C:\\Windows", "explorer.exe")],
    processes: ["explorer.exe"],
    closeable: false,
  },
  {
    id: "terminal",
    name: "Windows Terminal",
    aliases: ["terminal", "windows terminal"],
    exe: [path.join(LAD, "Microsoft", "WindowsApps", "wt.exe")],
    processes: ["windowsterminal.exe"],
  },
  { id: "taskmgr", name: "Task Manager", aliases: ["task manager", "taskmgr"], exe: [path.join(SYS, "Taskmgr.exe")], processes: ["taskmgr.exe"], closeable: false },
  { id: "settings", name: "Settings", aliases: ["settings", "windows settings", "pc settings"], uri: "ms-settings:", processes: ["systemsettings.exe"] },
  {
    id: "spotify",
    name: "Spotify",
    aliases: ["spotify"],
    exe: [path.join(AD, "Spotify", "Spotify.exe")],
    startName: "Spotify",
    processes: ["spotify.exe"],
  },
  {
    id: "discord",
    name: "Discord",
    aliases: ["discord"],
    exe: [path.join(LAD, "Discord", "Update.exe")],
    args: ["--processStart", "Discord.exe"],
    processes: ["discord.exe"],
  },
  { id: "word", name: "Microsoft Word", aliases: ["word", "microsoft word", "ms word"], startName: "Word", processes: ["winword.exe"] },
  { id: "excel", name: "Microsoft Excel", aliases: ["excel", "microsoft excel"], startName: "Excel", processes: ["excel.exe"] },
  { id: "powerpoint", name: "PowerPoint", aliases: ["powerpoint", "power point", "ppt"], startName: "PowerPoint", processes: ["powerpnt.exe"] },
  { id: "outlook", name: "Outlook", aliases: ["outlook"], startName: "Outlook", processes: ["outlook.exe", "olk.exe"] },
  { id: "whatsapp", name: "WhatsApp", aliases: ["whatsapp", "whats app"], startName: "WhatsApp", processes: ["whatsapp.exe", "whatsapp.root.exe"] },
  { id: "cursor", name: "Cursor", aliases: ["cursor"], exe: [path.join(LAD, "Programs", "cursor", "Cursor.exe")], processes: ["cursor.exe"] },
  { id: "steam", name: "Steam", aliases: ["steam"], exe: [path.join(PF86, "Steam", "steam.exe")], processes: ["steam.exe"] },
  { id: "obs", name: "OBS Studio", aliases: ["obs", "obs studio"], startName: "OBS Studio", processes: ["obs64.exe"] },
  { id: "camera", name: "Camera", aliases: ["camera app", "windows camera"], startName: "Camera", processes: ["windowscamera.exe"] },
];

/** Processes ARC must never close regardless of what is asked. */
const PROTECTED = new Set(["explorer.exe", "node.exe", "svchost.exe", "csrss.exe", "winlogon.exe", "lsass.exe", "services.exe", "system", "dwm.exe", "taskmgr.exe"]);

export interface StartApp {
  name: string;
  appId: string;
}

export interface ResolvedApp {
  id: string;
  name: string;
  known?: KnownApp;
  start?: StartApp;
  processes: string[];
  closeable: boolean;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\.(exe|app)$/, "")
    .replace(/[^a-z0-9+#]+/g, " ")
    .replace(/\b(the|app|application|program)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export class AppRegistry {
  private startApps: StartApp[] = [];
  private indexedAt = 0;
  private indexing: Promise<void> | null = null;

  constructor() {
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (process.platform !== "win32") return Promise.resolve();
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      try {
        const { stdout } = await powershell("Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress", {}, 30_000);
        const parsed = JSON.parse(stdout || "[]");
        const list: { Name: string; AppID: string }[] = Array.isArray(parsed) ? parsed : [parsed];
        this.startApps = list
          // Start-menu "apps" that are really web links (OEM bloat) are excluded.
          .filter((a) => a?.Name && a?.AppID && !/^https?:/i.test(a.AppID))
          .map((a) => ({ name: a.Name, appId: a.AppID }));
        this.indexedAt = Date.now();
        console.log(`[apps] indexed ${this.startApps.length} Start menu apps`);
      } catch (err) {
        console.warn("[apps] Start menu index failed:", (err as Error).message);
      } finally {
        this.indexing = null;
      }
    })();
    return this.indexing;
  }

  async resolve(query: string): Promise<ResolvedApp | null> {
    const q = norm(query);
    if (!q) return null;

    const known = KNOWN.find((k) => k.aliases.some((a) => norm(a) === q) || norm(k.name) === q);
    if (known) return this.fromKnown(known);

    if (Date.now() - this.indexedAt > 10 * 60_000) await this.refresh();
    const start = this.matchStart(q);
    if (start) {
      const guess = `${norm(start.name).split(" ")[0]}.exe`;
      return { id: start.appId, name: start.name, start, processes: [guess], closeable: !PROTECTED.has(guess) };
    }

    // Loose alias match (e.g. "open visual studio" → VS Code) after the exact Start menu pass.
    const loose = KNOWN.find((k) => k.aliases.some((a) => q.includes(norm(a)) && norm(a).length >= 4));
    return loose ? this.fromKnown(loose) : null;
  }

  private fromKnown(k: KnownApp): ResolvedApp {
    const start = k.startName ? this.startApps.find((s) => norm(s.name) === norm(k.startName!)) : undefined;
    return { id: k.id, name: k.name, known: k, start, processes: k.processes, closeable: k.closeable !== false };
  }

  private matchStart(q: string): StartApp | null {
    let best: { app: StartApp; score: number } | null = null;
    for (const app of this.startApps) {
      const n = norm(app.name);
      let score = 0;
      if (n === q) score = 100;
      else if (n.startsWith(q + " ") || n.startsWith(q)) score = 70 - (n.length - q.length) * 0.5;
      else if (n.includes(q) && q.length >= 3) score = 45 - (n.length - q.length) * 0.3;
      else {
        const qt = q.split(" ");
        const nt = new Set(n.split(" "));
        const overlap = qt.filter((t) => nt.has(t)).length;
        if (overlap && overlap === qt.length) score = 35;
      }
      // Avoid uninstallers, help files and similar noise.
      if (/uninstall|readme|help|documentation|release notes/i.test(app.name)) score -= 50;
      if (score > 25 && (!best || score > best.score)) best = { app, score };
    }
    return best?.app ?? null;
  }

  async launch(app: ResolvedApp): Promise<void> {
    const k = app.known;
    if (k?.exe) {
      const exe = k.exe.find((p) => p && fs.existsSync(p));
      if (exe) return launch(exe, k.args ?? []);
    }
    if (k?.uri) return launch("explorer.exe", [k.uri]);
    if (app.start) return launch("explorer.exe", [`shell:AppsFolder\\${app.start.appId}`]);
    throw new Error(`${app.name} is not installed on this PC`);
  }

  async isRunning(app: ResolvedApp): Promise<boolean> {
    const running = await runningProcesses();
    return app.processes.some((p) => running.has(p.toLowerCase()));
  }

  /** Wait until one of the app's processes appears (used to report "ready" truthfully). */
  async waitForProcess(app: ResolvedApp, timeoutMs = 8000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isRunning(app)) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  protectedProcess(name: string): boolean {
    return PROTECTED.has(name.toLowerCase());
  }

  /** Names the LLM is told about so it maps requests onto real targets. */
  knownNames(): string[] {
    return KNOWN.map((k) => k.name);
  }
}
