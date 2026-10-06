import path from "node:path";
import type { Attachment, DesktopAction } from "../../shared/types";
import { AppRegistry } from "./apps";
import { createFile, isBlocked, openPath, recycle, resolveInside, roots, searchFiles } from "./files";
import { closeWindows, launch, run } from "./process";
import { pressMediaKey, systemReport, typeText } from "./system";

export interface Prepared {
  ok: true;
  action: DesktopAction;
  /** What the confirmation panel shows, e.g. "Open Visual Studio Code?" */
  title: string;
  detail?: string;
}
export type PrepareResult = Prepared | { ok: false; message: string; attachments?: Attachment[] };

export interface ExecResult {
  ok: boolean;
  message: string;
  attachments?: Attachment[];
}

const SITES: Record<string, string> = {
  google: "https://www.google.com",
  youtube: "https://www.youtube.com",
  gmail: "https://mail.google.com",
  github: "https://github.com",
  spotify: "https://open.spotify.com",
  netflix: "https://www.netflix.com",
  instagram: "https://www.instagram.com",
  whatsapp: "https://web.whatsapp.com",
  chatgpt: "https://chatgpt.com",
  "chat gpt": "https://chatgpt.com",
  claude: "https://claude.ai",
  twitter: "https://x.com",
  x: "https://x.com",
  linkedin: "https://www.linkedin.com",
  reddit: "https://www.reddit.com",
  amazon: "https://www.amazon.com",
  maps: "https://maps.google.com",
  "google maps": "https://maps.google.com",
  groq: "https://console.groq.com",
};

/** Map a spoken site name or domain to a safe http(s) URL, or null. */
export function siteUrl(input: string): string | null {
  const name = input.toLowerCase().replace(/^the\s+/, "").replace(/\s+(website|site|dot com)$/, "").trim();
  if (SITES[name]) return SITES[name];
  const candidate = /^https?:\/\//i.test(name) ? name : /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(name) ? `https://${name}` : null;
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The only component allowed to touch the PC. It accepts validated, structured
 * actions and maps each to a fixed implementation. There is no generic
 * "run command" path.
 */
export class ActionExecutor {
  readonly apps = new AppRegistry();

  async prepare(action: DesktopAction): Promise<PrepareResult> {
    switch (action.action) {
      case "OPEN_APPLICATION": {
        const app = await this.apps.resolve(action.target);
        if (!app) {
          const url = siteUrl(action.target);
          if (url) return { ok: true, action: { action: "OPEN_WEBSITE", url }, title: `Open ${new URL(url).hostname}?` };
          return { ok: false, message: `I couldn't find ${action.target} on this PC, boss.` };
        }
        return { ok: true, action: { ...action, target: app.name }, title: `Open ${app.name}?` };
      }
      case "CLOSE_APPLICATION": {
        const app = await this.apps.resolve(action.target);
        if (!app) return { ok: false, message: `I don't know an app called ${action.target}, boss.` };
        if (!app.closeable || app.processes.some((p) => this.apps.protectedProcess(p))) {
          return { ok: false, message: `${app.name} is protected, boss. I won't close it.` };
        }
        if (!(await this.apps.isRunning(app))) return { ok: false, message: `${app.name} isn't running, boss.` };
        return { ok: true, action: { ...action, target: app.name }, title: `Close ${app.name}?`, detail: "Unsaved work may be lost." };
      }
      case "OPEN_WEBSITE": {
        const url = siteUrl(action.url);
        if (!url) return { ok: false, message: "That doesn't look like a valid web address, boss." };
        return { ok: true, action: { ...action, url }, title: `Open ${new URL(url).hostname}?`, detail: url };
      }
      case "SEARCH_WEB":
        return { ok: true, action, title: `Search ${action.engine === "youtube" ? "YouTube" : "Google"}?`, detail: action.query };
      case "OPEN_FILE":
      case "DELETE_FILE": {
        const verb = action.action === "OPEN_FILE" ? "Open" : "Delete";
        const resolved = await this.resolveFile(action.path);
        if (!resolved.ok) return resolved;
        if (action.action === "OPEN_FILE" && isBlocked(resolved.path)) {
          return { ok: false, message: "That's an executable file, boss. I don't open those for safety." };
        }
        return {
          ok: true,
          action: { ...action, path: resolved.path },
          title: `${verb} ${path.basename(resolved.path)}?`,
          detail: action.action === "DELETE_FILE" ? `${resolved.path}\nMoves to the Recycle Bin.` : resolved.path,
        };
      }
      case "CREATE_FILE":
        return { ok: true, action, title: `Create ${action.name}?`, detail: `In ${roots().at(-1)}` };
      case "TYPE_TEXT":
        return { ok: true, action, title: "Type text into the active window?", detail: action.text.slice(0, 160) };
      case "QUERY_APPLICATION":
      case "SEARCH_FILE":
      case "SYSTEM_INFORMATION":
      case "CONTROL_MEDIA":
        return { ok: true, action, title: describe(action) };
    }
  }

  async execute(action: DesktopAction): Promise<ExecResult> {
    switch (action.action) {
      case "OPEN_APPLICATION": {
        const app = await this.apps.resolve(action.target);
        if (!app) return { ok: false, message: `I couldn't find ${action.target}, boss.` };
        await this.apps.launch(app);
        const ready = await this.apps.waitForProcess(app);
        return { ok: true, message: ready ? `${app.name} is ready, boss.` : `Launching ${app.name}, boss.` };
      }
      case "CLOSE_APPLICATION": {
        const app = await this.apps.resolve(action.target);
        if (!app || !app.closeable) return { ok: false, message: `I can't close ${action.target}, boss.` };
        const procs = app.processes.filter((p) => !this.apps.protectedProcess(p));
        // Graceful close only (WM_CLOSE, never /F): apps get the chance to prompt about unsaved work.
        if (process.platform === "win32") {
          await closeWindows(procs).catch(async () => {
            for (const proc of procs) await run("taskkill.exe", ["/IM", proc]).catch(() => undefined);
          });
        }
        await new Promise((r) => setTimeout(r, 1500));
        const still = await this.apps.isRunning(app);
        return still
          ? { ok: true, message: `I've asked ${app.name} to close, boss. It may be waiting on unsaved work.` }
          : { ok: true, message: `${app.name} is closed, boss.` };
      }
      case "QUERY_APPLICATION": {
        const app = await this.apps.resolve(action.target);
        if (!app) return { ok: true, message: `I don't see ${action.target} installed, boss.` };
        return { ok: true, message: (await this.apps.isRunning(app)) ? `Yes, boss. ${app.name} is open.` : `No, boss. ${app.name} isn't running.` };
      }
      case "OPEN_WEBSITE": {
        const url = siteUrl(action.url);
        if (!url) return { ok: false, message: "That address isn't valid, boss." };
        await openUrl(url);
        return { ok: true, message: `${new URL(url).hostname.replace(/^www\./, "")} is open, boss.` };
      }
      case "SEARCH_WEB": {
        const url =
          action.engine === "youtube"
            ? `https://www.youtube.com/results?search_query=${encodeURIComponent(action.query)}`
            : `https://www.google.com/search?q=${encodeURIComponent(action.query)}`;
        await openUrl(url);
        return { ok: true, message: `Here are the results for ${action.query}, boss.` };
      }
      case "OPEN_FILE": {
        const real = resolveInside(action.path);
        if (!real) return { ok: false, message: "That file is outside the folders I can access, boss." };
        await openPath(real);
        return { ok: true, message: `${path.basename(real)} is open, boss.` };
      }
      case "SEARCH_FILE": {
        const hits = await searchFiles(action.query);
        if (!hits.length) return { ok: true, message: `I found no files matching ${action.query}, boss.` };
        return {
          ok: true,
          message: hits.length === 1 ? `I found ${hits[0].name}, boss.` : `I found ${hits.length} matches, boss.`,
          attachments: [{ kind: "files", items: hits }],
        };
      }
      case "CREATE_FILE": {
        const created = await createFile(action.name, action.content);
        return {
          ok: true,
          message: `${path.basename(created)} is created, boss.`,
          attachments: [{ kind: "files", items: [{ name: path.basename(created), path: created }] }],
        };
      }
      case "DELETE_FILE": {
        const real = resolveInside(action.path);
        if (!real) return { ok: false, message: "That path is outside the folders I can access, boss." };
        await recycle(real);
        return { ok: true, message: `${path.basename(real)} is in the Recycle Bin, boss.` };
      }
      case "TYPE_TEXT":
        await typeText(action.text);
        return { ok: true, message: "Typed, boss." };
      case "SYSTEM_INFORMATION": {
        const report = await systemReport(action.topic);
        return { ok: true, message: report.message, attachments: [{ kind: "system", items: report.items }] };
      }
      case "CONTROL_MEDIA":
        await pressMediaKey(action.command);
        return { ok: true, message: mediaReply(action.command) };
    }
  }

  private async resolveFile(input: string): Promise<{ ok: true; path: string } | { ok: false; message: string; attachments?: Attachment[] }> {
    const direct = resolveInside(input);
    if (direct) return { ok: true, path: direct };
    if (path.isAbsolute(input)) return { ok: false, message: "That path is outside the folders I can access, boss." };
    const hits = await searchFiles(input, 6);
    if (!hits.length) return { ok: false, message: `I couldn't find ${input}, boss.` };
    const exact = hits.filter((h) => h.name.toLowerCase() === input.toLowerCase() || h.name.toLowerCase().replace(/\.[^.]+$/, "") === input.toLowerCase());
    if (exact.length === 1 || hits.length === 1) return { ok: true, path: (exact[0] ?? hits[0]).path };
    return {
      ok: false,
      message: `I found ${hits.length} files matching ${input}, boss. Which one?`,
      attachments: [{ kind: "files", items: hits }],
    };
  }
}

async function openUrl(url: string): Promise<void> {
  if (process.platform === "win32") return launch("explorer.exe", [url]);
  return launch(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

function mediaReply(cmd: string): string {
  switch (cmd) {
    case "NEXT":
      return "Next track, boss.";
    case "PREVIOUS":
      return "Previous track, boss.";
    case "VOLUME_UP":
      return "Volume up, boss.";
    case "VOLUME_DOWN":
      return "Volume down, boss.";
    case "MUTE":
      return "Muted, boss.";
    case "STOP":
      return "Stopped, boss.";
    default:
      return "Done, boss.";
  }
}

export function describe(action: DesktopAction): string {
  switch (action.action) {
    case "OPEN_APPLICATION":
      return `Open ${action.target}`;
    case "CLOSE_APPLICATION":
      return `Close ${action.target}`;
    case "QUERY_APPLICATION":
      return `Check ${action.target}`;
    case "OPEN_WEBSITE":
      return `Open ${action.url}`;
    case "SEARCH_WEB":
      return `Search ${action.query}`;
    case "OPEN_FILE":
      return `Open ${path.basename(action.path)}`;
    case "CREATE_FILE":
      return `Create ${action.name}`;
    case "SEARCH_FILE":
      return `Find "${action.query}"`;
    case "DELETE_FILE":
      return `Delete ${path.basename(action.path)}`;
    case "TYPE_TEXT":
      return "Type text";
    case "SYSTEM_INFORMATION":
      return "System report";
    case "CONTROL_MEDIA":
      return `Media ${action.command.replace("_", " ").toLowerCase()}`;
  }
}
