import os from "node:os";
import { powershell } from "./process";

/** Real machine telemetry — nothing here is simulated. */

let lastCpu = cpuTimes();

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

/** CPU utilisation since the previous call, 0–100. */
export function sampleCpu(): number | null {
  const now = cpuTimes();
  const dTotal = now.total - lastCpu.total;
  const dIdle = now.idle - lastCpu.idle;
  lastCpu = now;
  if (dTotal <= 0) return null;
  return Math.round((1 - dIdle / dTotal) * 100);
}

export function memoryUsage(): number {
  return Math.round((1 - os.freemem() / os.totalmem()) * 100);
}

export async function battery(): Promise<{ percent: number; charging: boolean } | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await powershell(
      "Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress",
      {},
      8000,
    );
    if (!stdout.trim()) return null;
    const b = JSON.parse(stdout);
    const one = Array.isArray(b) ? b[0] : b;
    // BatteryStatus 2 = on AC power
    return { percent: Number(one.EstimatedChargeRemaining), charging: Number(one.BatteryStatus) === 2 };
  } catch {
    return null;
  }
}

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} hours ${m} minutes` : `${m} minutes`;
}

export async function systemReport(topic: string) {
  const cpu = sampleCpu() ?? 0;
  const mem = memoryUsage();
  const totalGb = (os.totalmem() / 1024 ** 3).toFixed(1);
  const bat = topic === "battery" || topic === "overview" ? await battery() : null;
  const items = [
    { label: "CPU", value: `${cpu}%` },
    { label: "Memory", value: `${mem}% of ${totalGb} GB` },
    { label: "Uptime", value: formatUptime(os.uptime()) },
    { label: "Host", value: os.hostname() },
    ...(bat ? [{ label: "Battery", value: `${bat.percent}%${bat.charging ? " · charging" : ""}` }] : []),
  ];

  let message: string;
  switch (topic) {
    case "cpu":
      message = `CPU is at ${cpu} percent, boss.`;
      break;
    case "memory":
      message = `Memory is ${mem} percent used, boss.`;
      break;
    case "battery":
      message = bat ? `Battery at ${bat.percent} percent${bat.charging ? ", charging" : ""}, boss.` : "No battery detected, boss.";
      break;
    case "uptime":
      message = `The system has been up for ${formatUptime(os.uptime())}, boss.`;
      break;
    default:
      message = `CPU ${cpu} percent, memory ${mem} percent${bat ? `, battery ${bat.percent} percent` : ""}. All systems nominal, boss.`;
  }
  return { message, items };
}

const MEDIA_KEYS: Record<string, number> = {
  PLAY_PAUSE: 0xb3,
  NEXT: 0xb0,
  PREVIOUS: 0xb1,
  STOP: 0xb2,
  MUTE: 0xad,
  VOLUME_DOWN: 0xae,
  VOLUME_UP: 0xaf,
};

/** Press a media virtual key. The key code comes from the fixed table above. */
export async function pressMediaKey(command: keyof typeof MEDIA_KEYS | string): Promise<void> {
  const vk = MEDIA_KEYS[command];
  if (vk === undefined) throw new Error(`Unknown media command ${command}`);
  if (process.platform !== "win32") throw new Error("Media control is only implemented on Windows");
  const repeat = command === "VOLUME_UP" || command === "VOLUME_DOWN" ? 5 : 1;
  const script = `
    Add-Type -Namespace ArcNative -Name Keys -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, System.UIntPtr extra);'
    $vk = [byte][int]$env:ARC_VK
    for ($i = 0; $i -lt [int]$env:ARC_REPEAT; $i++) {
      [ArcNative.Keys]::keybd_event($vk, 0, 1, [System.UIntPtr]::Zero)
      [ArcNative.Keys]::keybd_event($vk, 0, 3, [System.UIntPtr]::Zero)
    }`;
  const { code, stderr } = await powershell(script, { ARC_VK: String(vk), ARC_REPEAT: String(repeat) });
  if (code !== 0) throw new Error(stderr.trim() || "Media key failed");
}

/** Type text into the focused window. Text travels via env var and is escaped for SendKeys inside the script. */
export async function typeText(text: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("Typing is only implemented on Windows");
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    Start-Sleep -Milliseconds 400
    $t = $env:ARC_TEXT -replace '([+^%~(){}\\[\\]])', '{$1}'
    $t = $t -replace "\\r?\\n", '{ENTER}'
    [System.Windows.Forms.SendKeys]::SendWait($t)`;
  const { code, stderr } = await powershell(script, { ARC_TEXT: text });
  if (code !== 0) throw new Error(stderr.trim() || "Typing failed");
}
