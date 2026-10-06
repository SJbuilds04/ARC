import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { launch, powershell } from "./process";

/**
 * File operations, sandboxed to the configured roots (ARC_FILE_ROOTS, default:
 * Desktop / Documents / Downloads, plus ~/Documents/ARC for new files).
 */

/** Opening these would execute code — ARC refuses regardless of risk confirmation. */
const BLOCKED_EXT = new Set([
  ".exe", ".bat", ".cmd", ".com", ".ps1", ".psm1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".msi", ".msp",
  ".scr", ".lnk", ".url", ".reg", ".jar", ".hta", ".cpl", ".pif", ".appref-ms", ".application", ".gadget", ".inf", ".sh",
]);

const SKIP_DIRS = new Set(["node_modules", ".git", "$recycle.bin", "appdata", ".cache", "__pycache__", ".venv", "venv"]);

export function roots(): string[] {
  return [...new Set([...config.fileRoots, config.createDir])];
}

const caseFold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

function within(p: string, root: string): boolean {
  const rel = path.relative(caseFold(root), caseFold(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Resolve a user path to a real path inside the sandbox, or null. Follows symlinks/junctions before checking. */
export function resolveInside(input: string): string | null {
  const candidates = path.isAbsolute(input) ? [input] : roots().map((r) => path.join(r, input));
  for (const c of candidates) {
    try {
      const real = fs.realpathSync(path.normalize(c));
      const realRoots = roots().filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r));
      if (realRoots.some((r) => within(real, r))) return real;
    } catch {
      // doesn't exist under this root
    }
  }
  return null;
}

export interface FileHit {
  name: string;
  path: string;
}

/** Breadth-first name search across the sandbox roots. */
export async function searchFiles(query: string, limit = 8): Promise<FileHit[]> {
  const q = query.toLowerCase().replace(/["']/g, "").trim();
  const terms = q.split(/\s+/).filter(Boolean);
  const hits: (FileHit & { score: number })[] = [];
  const queue: { dir: string; depth: number }[] = roots().filter((r) => fs.existsSync(r)).map((dir) => ({ dir, depth: 0 }));
  let visited = 0;

  while (queue.length && visited < 4000) {
    const { dir, depth } = queue.shift()!;
    visited++;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const lower = e.name.toLowerCase();
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(lower) && !lower.startsWith(".") && depth < 6) queue.push({ dir: full, depth: depth + 1 });
      }
      if (terms.every((t) => lower.includes(t))) {
        const stem = lower.replace(/\.[^.]+$/, "");
        const score = (stem === q ? 100 : lower === q ? 95 : lower.startsWith(q) ? 60 : 30) - depth * 2 + (e.isFile() ? 5 : 0);
        hits.push({ name: e.name, path: full, score });
      }
    }
  }
  return hits
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ name, path }) => ({ name, path }));
}

export function isBlocked(p: string): boolean {
  return BLOCKED_EXT.has(path.extname(p).toLowerCase());
}

export async function openPath(p: string): Promise<void> {
  if (isBlocked(p)) throw new Error("Opening executable or script files is blocked for safety");
  if (process.platform === "win32") return launch("explorer.exe", [p]);
  return launch(process.platform === "darwin" ? "open" : "xdg-open", [p]);
}

export function sanitizeFileName(name: string): string {
  let base = (name.split(/[\\/]/).pop() ?? "").replace(/[<>:"|?*\x00-\x1f]/g, "").trim();
  base = base.replace(/^\.+/, "").slice(0, 100);
  if (!base) base = "untitled";
  if (!path.extname(base)) base += ".txt";
  if (isBlocked(base)) base += ".txt";
  return base;
}

export async function createFile(name: string, content: string): Promise<string> {
  await fs.promises.mkdir(config.createDir, { recursive: true });
  const safe = sanitizeFileName(name);
  const ext = path.extname(safe);
  const stem = safe.slice(0, -ext.length);
  let target = path.join(config.createDir, safe);
  for (let i = 1; fs.existsSync(target); i++) target = path.join(config.createDir, `${stem} (${i})${ext}`);
  await fs.promises.writeFile(target, content, { flag: "wx" });
  return target;
}

/** Move a file or folder to the Recycle Bin (never a permanent delete). */
export async function recycle(p: string): Promise<void> {
  if (roots().some((r) => caseFold(path.resolve(r)) === caseFold(path.resolve(p)))) {
    throw new Error("Refusing to delete a sandbox root folder");
  }
  if (process.platform !== "win32") throw new Error("Recycle Bin delete is only implemented on Windows");
  const script = `
    Add-Type -AssemblyName Microsoft.VisualBasic
    $p = $env:ARC_TARGET
    if (Test-Path -LiteralPath $p -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } elseif (Test-Path -LiteralPath $p -PathType Leaf) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else { exit 2 }`;
  const { code, stderr } = await powershell(script, { ARC_TARGET: p });
  if (code !== 0) throw new Error(stderr.trim() || `Delete failed (exit ${code})`);
}
