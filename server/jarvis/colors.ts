/** Spoken colour names → hex. Unknown names return null (never passed through to CSS). */
const NAMED: Record<string, string> = {
  black: "#000000",
  "pitch black": "#000000",
  white: "#f4f8ff",
  grey: "#6b7480",
  gray: "#6b7480",
  "dark grey": "#1c2129",
  "dark gray": "#1c2129",
  silver: "#c0c8d2",
  red: "#ff3b4a",
  "dark red": "#5a0710",
  crimson: "#dc143c",
  maroon: "#4a0612",
  orange: "#ff8a1f",
  amber: "#ffb000",
  gold: "#ffcc4d",
  yellow: "#ffe14d",
  lime: "#9dff3c",
  green: "#2fe07a",
  "dark green": "#062914",
  emerald: "#14c88a",
  teal: "#14b8b0",
  cyan: "#5fd8ff",
  aqua: "#5fffe6",
  "light blue": "#9fd8ff",
  "sky blue": "#7cc8ff",
  blue: "#3b8bff",
  "dark blue": "#020c24",
  navy: "#04102e",
  "midnight blue": "#050b1f",
  indigo: "#4b3bff",
  purple: "#9b4dff",
  violet: "#b066ff",
  "dark purple": "#14062a",
  magenta: "#ff3bd5",
  pink: "#ff6fb5",
  "hot pink": "#ff2f92",
  brown: "#6b4226",
  beige: "#e8dcc2",
  default: "#02070f",
  space: "#02070f",
};

export function resolveColor(input: string): string | null {
  const t = input
    .toLowerCase()
    .replace(/\b(colou?r|the|a|to|please|shade|of)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^#[0-9a-f]{6}$/.test(t)) return t;
  if (/^#[0-9a-f]{3}$/.test(t)) return `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  if (NAMED[t]) return NAMED[t];
  // "something like blue" / "bright blue" → the last known colour word
  const words = t.split(" ");
  for (let n = Math.min(2, words.length); n >= 1; n--) {
    for (let i = words.length - n; i >= 0; i--) {
      const key = words.slice(i, i + n).join(" ");
      if (NAMED[key]) return NAMED[key];
    }
  }
  return null;
}
