import { spawn } from "node:child_process";

/**
 * Put text on the PC clipboard. The text is written to the process's stdin — it is never
 * part of the command line, so nothing in it can be interpreted as a command.
 */
export function setClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("Clipboard sync needs Windows"));
      return;
    }
    const ps = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "[Console]::InputEncoding = [Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"],
      { windowsHide: true },
    );
    let err = "";
    ps.stderr.on("data", (d) => (err += String(d)));
    ps.on("error", reject);
    ps.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(err.trim().slice(0, 200) || `exit ${code}`))));
    ps.stdin.end(text, "utf8");
  });
}
