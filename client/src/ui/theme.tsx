import { setTheme, toggleTheme, useTheme } from "../core/theme";
import { Icon } from "./Icons";

/** Sun / moon: switches every screen between dark and light (the visor stays dark). */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const light = useTheme() === "light";
  return (
    <button className={`theme-toggle ${className}`} onClick={toggleTheme} aria-label={light ? "Switch to dark theme" : "Switch to light theme"} title={light ? "Dark theme" : "Light theme"}>
      {light ? <Icon.Moon width={19} height={19} /> : <Icon.Sun width={19} height={19} />}
    </button>
  );
}

/** Dark | Light, for Settings. */
export function ThemeChoice() {
  const t = useTheme();
  return (
    <div className="dd-seg theme-choice" role="group" aria-label="Theme">
      {(["dark", "light"] as const).map((x) => (
        <button key={x} className={t === x ? "is-on" : ""} onClick={() => setTheme(x)}>
          {x === "dark" ? <Icon.Moon width={15} height={15} /> : <Icon.Sun width={15} height={15} />} {x.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
