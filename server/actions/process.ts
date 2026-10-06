import { spawn } from "node:child_process";

/**
 * Process helpers. Every call passes an executable plus an argument array —
 * `shell` is never enabled, so no text (LLM-produced or otherwise) is ever
 * interpreted by a command shell.
 */

export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string>; input?: string } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: false,
      windowsHide: true,
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 15_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Start a GUI program detached from ARC so it outlives the server. */
export function launch(cmd: string, args: string[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false, detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/**
 * Run a fixed PowerShell script. Dynamic values are passed ONLY through
 * environment variables (read inside the script as $env:ARC_*), never spliced
 * into the script text.
 */
export function powershell(script: string, env: Record<string, string> = {}, timeoutMs = 15_000) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    env,
    timeoutMs,
  });
}

/**
 * Gracefully close an app's windows (WM_CLOSE), including UWP apps whose window
 * is hosted by ApplicationFrameHost. Never force-kills, so apps can still prompt
 * about unsaved work. Process names arrive via env var, not script text.
 */
export async function closeWindows(processNames: string[]): Promise<number> {
  const script = `
    Add-Type -TypeDefinition @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class ArcWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static int Close(int[] pids) {
    var set = new HashSet<uint>(); foreach (var p in pids) set.Add((uint)p);
    int n = 0;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      bool match = set.Contains(pid);
      if (!match) EnumChildWindows(h, (c, l2) => { uint cp; GetWindowThreadProcessId(c, out cp); if (set.Contains(cp)) { match = true; return false; } return true; }, IntPtr.Zero);
      if (match) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); n++; }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
'@
    $names = $env:ARC_PROCS.ToLower() -split ','
    $ids = @(Get-Process | Where-Object { $names -contains ($_.ProcessName + '.exe').ToLower() } | ForEach-Object { $_.Id })
    if ($ids.Count -eq 0) { 0 } else { [ArcWin]::Close([int[]]$ids) }`;
  const { stdout, code } = await powershell(script, { ARC_PROCS: processNames.join(",") }, 20_000);
  if (code !== 0) throw new Error("Window close script failed");
  return Number(stdout.trim()) || 0;
}

export async function runningProcesses(): Promise<Set<string>> {
  if (process.platform !== "win32") {
    const { stdout } = await run("ps", ["-A", "-o", "comm="]);
    return new Set(stdout.split("\n").map((l) => l.trim().split("/").pop()!.toLowerCase()).filter(Boolean));
  }
  const { stdout } = await run("tasklist.exe", ["/FO", "CSV", "/NH"]);
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}
