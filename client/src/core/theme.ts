import { useSyncExternalStore } from "react";

/**
 * Light / dark theme for every screen except the visor (which stays dark). Each device remembers its
 * own choice. The page itself switches by `data-theme` on <html>; the 3D scenes listen with onTheme().
 */
export type Theme = "dark" | "light";

const KEY = "arc.theme";
const listeners = new Set<(t: Theme) => void>();
let current: Theme = read();

function read(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function apply(): void {
  document.documentElement.dataset.theme = current;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", current === "light" ? "#eef3f8" : "#020812");
}
apply();

export function theme(): Theme {
  return current;
}

export function isLight(): boolean {
  return current === "light";
}

export function setTheme(t: Theme): void {
  if (t === current) return;
  current = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // private mode: the choice lasts for this visit
  }
  apply();
  for (const f of listeners) f(t);
}

export function toggleTheme(): void {
  setTheme(current === "light" ? "dark" : "light");
}

/** Call `f` whenever the theme changes. Returns an unsubscribe function. */
export function onTheme(f: (t: Theme) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** React: the current theme, re-rendering on change. */
export function useTheme(): Theme {
  return useSyncExternalStore(onTheme, theme, theme);
}
