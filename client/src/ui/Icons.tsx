import type { SVGProps } from "react";

/** Thin-line icon set matching the ARC HUD (24px grid, 1.5 stroke). */
const base = (props: SVGProps<SVGSVGElement>) => ({
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  ...props,
});

type P = SVGProps<SVGSVGElement>;

export const Icon = {
  Command: (p: P) => (
    <svg {...base(p)}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1" />
    </svg>
  ),
  Cube: (p: P) => (
    <svg {...base(p)}>
      <path d="M12 2.8 20.5 7.5v9L12 21.2 3.5 16.5v-9z" />
      <path d="M3.8 7.6 12 12l8.2-4.4M12 12v9" />
    </svg>
  ),
  Camera: (p: P) => (
    <svg {...base(p)}>
      <path d="M4 7.5h3l1.6-2.5h6.8L17 7.5h3a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1z" />
      <circle cx="12" cy="13" r="3.6" />
    </svg>
  ),
  Settings: (p: P) => (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
      <circle cx="12" cy="12" r="6.6" />
    </svg>
  ),
  Cpu: (p: P) => (
    <svg {...base(p)}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
      <rect x="9.5" y="9.5" width="5" height="5" />
      <path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5" />
    </svg>
  ),
  Eye: (p: P) => (
    <svg {...base(p)}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v1.5M12 20v1.5" />
    </svg>
  ),
  Phone: (p: P) => (
    <svg {...base(p)}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.2" />
      <path d="M10.5 18.5h3" />
    </svg>
  ),
  History: (p: P) => (
    <svg {...base(p)}>
      <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4v4h4" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  ),
  Mic: (p: P) => (
    <svg {...base(p)}>
      <rect x="9" y="2.8" width="6" height="11.4" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5v3.7M8.5 21.2h7" />
    </svg>
  ),
  Keyboard: (p: P) => (
    <svg {...base(p)}>
      <rect x="2.5" y="6" width="19" height="12" rx="1.5" />
      <path d="M6 9.5h1M9.5 9.5h1M13 9.5h1M16.5 9.5h1M6 12.5h1M9.5 12.5h1M13 12.5h1M16.5 12.5h1M8 15.2h8" />
    </svg>
  ),
  Ear: (p: P) => (
    <svg {...base(p)}>
      <path d="M7 9a5 5 0 0 1 10 0c0 3-3 4-3 7a3 3 0 0 1-5.5 1.6" />
      <path d="M10 9.5a2 2 0 0 1 4 0c0 1.2-1 1.6-1.5 2.3" />
    </svg>
  ),
  Rotate: (p: P) => (
    <svg {...base(p)}>
      <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4.3h-4.3" />
    </svg>
  ),
  Scale: (p: P) => (
    <svg {...base(p)}>
      <path d="M14 3.5h6.5V10M20.5 3.5 13 11M10 20.5H3.5V14M3.5 20.5 11 13" />
    </svg>
  ),
  Move: (p: P) => (
    <svg {...base(p)}>
      <path d="M12 2.5v19M2.5 12h19M12 2.5 9.5 5M12 2.5 14.5 5M12 21.5 9.5 19M12 21.5l2.5-2.5M2.5 12 5 9.5M2.5 12 5 14.5M21.5 12 19 9.5M21.5 12 19 14.5" />
    </svg>
  ),
  Explode: (p: P) => (
    <svg {...base(p)}>
      <rect x="9" y="9" width="6" height="6" />
      <path d="M4 4l3 3M20 4l-3 3M4 20l3-3M20 20l-3-3M3 10V3h7M21 14v7h-7" />
    </svg>
  ),
  Trash: (p: P) => (
    <svg {...base(p)}>
      <path d="M4 6.5h16M9.5 6.5V4h5v2.5M6.5 6.5l.9 13.5h9.2l.9-13.5M10 10.5v6M14 10.5v6" />
    </svg>
  ),
  Close: (p: P) => (
    <svg {...base(p)}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  ),
  Check: (p: P) => (
    <svg {...base(p)}>
      <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />
    </svg>
  ),
  Warning: (p: P) => (
    <svg {...base(p)}>
      <path d="M12 3.5 21.5 20h-19z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </svg>
  ),
  Link: (p: P) => (
    <svg {...base(p)}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3.5-3.5a4 4 0 0 0-5.7-5.7L12 6.3M14 10a4 4 0 0 0-5.7 0l-3.5 3.5a4 4 0 0 0 5.7 5.7l1.5-1.5" />
    </svg>
  ),
  Chevron: (p: P) => (
    <svg {...base(p)}>
      <path d="M9 5l7 7-7 7" />
    </svg>
  ),
  File: (p: P) => (
    <svg {...base(p)}>
      <path d="M6 2.5h8l4.5 4.5v14.5H6z" />
      <path d="M14 2.5V7h4.5" />
    </svg>
  ),
  Send: (p: P) => (
    <svg {...base(p)}>
      <path d="M3.5 11.5 20.5 4l-6.5 16.5-3-6.8z" />
    </svg>
  ),
  Reset: (p: P) => (
    <svg {...base(p)}>
      <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4.3h4.3" />
      <circle cx="12" cy="12" r="1.5" />
    </svg>
  ),
};

/** Glyphs for the playground model shelf. */
export function ObjectGlyph({ kind, size = 34 }: { kind: string; size?: number }) {
  const s = { width: size, height: size, viewBox: "0 0 40 40", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" as const };
  switch (kind) {
    case "earth":
      return (
        <svg {...s}>
          <circle cx="20" cy="20" r="13" />
          <ellipse cx="20" cy="20" rx="6" ry="13" />
          <path d="M7 20h26M9 13h22M9 27h22" />
        </svg>
      );
    case "moon":
      return (
        <svg {...s}>
          <circle cx="20" cy="20" r="12" />
          <circle cx="15" cy="16" r="2.5" />
          <circle cx="24" cy="24" r="3.2" />
          <circle cx="24" cy="14" r="1.3" />
        </svg>
      );
    case "mars":
      return (
        <svg {...s}>
          <circle cx="20" cy="20" r="12" />
          <path d="M10 17c5 2 9-2 14 0s6 2 7 1M10 24c4-1 7 2 12 1" />
        </svg>
      );
    case "saturn":
      return (
        <svg {...s}>
          <circle cx="20" cy="20" r="8" />
          <ellipse cx="20" cy="20" rx="17" ry="5" transform="rotate(-18 20 20)" />
        </svg>
      );
    case "sun":
      return (
        <svg {...s}>
          <circle cx="20" cy="20" r="7.5" />
          <path d="M20 4v5M20 31v5M4 20h5M31 20h5M8.7 8.7l3.5 3.5M27.8 27.8l3.5 3.5M8.7 31.3l3.5-3.5M27.8 12.2l3.5-3.5" />
        </svg>
      );
    case "solar_system":
      return (
        <svg {...s}>
          <circle cx="20" cy="20" r="3.5" />
          <circle cx="20" cy="20" r="9" />
          <circle cx="20" cy="20" r="15" />
          <circle cx="29" cy="20" r="1.8" fill="currentColor" />
          <circle cx="9.5" cy="12" r="1.5" fill="currentColor" />
        </svg>
      );
    case "atom":
      return (
        <svg {...s}>
          <circle cx="20" cy="20" r="2.5" fill="currentColor" />
          <ellipse cx="20" cy="20" rx="15" ry="5.5" />
          <ellipse cx="20" cy="20" rx="15" ry="5.5" transform="rotate(60 20 20)" />
          <ellipse cx="20" cy="20" rx="15" ry="5.5" transform="rotate(-60 20 20)" />
        </svg>
      );
    case "dna":
      return (
        <svg {...s}>
          <path d="M13 5c0 8 14 8 14 15s-14 7-14 15M27 5c0 8-14 8-14 15s14 7 14 15" />
          <path d="M15 9h10M15.5 31h9M14 20h12" />
        </svg>
      );
    case "car":
      return (
        <svg {...s}>
          <path d="M4 25v-4l4-1 5-5h11l6 5 5 1v4h-3" />
          <path d="M14 25h12M8 25H4" />
          <circle cx="11" cy="25.5" r="3" />
          <circle cx="29" cy="25.5" r="3" />
        </svg>
      );
    case "engine":
      return (
        <svg {...s}>
          <rect x="8" y="16" width="24" height="12" />
          <path d="M11 16l-4-7h8l2 7M29 16l4-7h-8l-2 7M5 22h3M32 22h3M14 28v4M26 28v4" />
        </svg>
      );
    case "heart":
      return (
        <svg {...s}>
          <path d="M20 33S6 24.5 6 15.5A7 7 0 0 1 20 12a7 7 0 0 1 14 3.5C34 24.5 20 33 20 33z" />
          <path d="M20 12v-5M24 9l3-3" />
        </svg>
      );
    case "brain":
      return (
        <svg {...s}>
          <path d="M20 8c-2-3-8-3-9 1-4 0-6 5-3 8-3 3-1 8 3 8 1 4 7 5 9 2V8zM20 8c2-3 8-3 9 1 4 0 6 5 3 8 3 3 1 8-3 8-1 4-7 5-9 2" />
          <path d="M14 14c2 0 3 2 3 4M26 14c-2 0-3 2-3 4M13 21c2 1 4 0 5 2M27 21c-2 1-4 0-5 2" />
        </svg>
      );
    case "cube":
      return (
        <svg {...s}>
          <path d="M20 5l13 7.5v15L20 35 7 27.5v-15z" />
          <path d="M7 12.5 20 20l13-7.5M20 20v15" />
        </svg>
      );
    case "sphere":
      return (
        <svg {...s}>
          <circle cx="20" cy="20" r="13" />
          <ellipse cx="20" cy="20" rx="13" ry="4.5" />
        </svg>
      );
    case "torus":
      return (
        <svg {...s}>
          <ellipse cx="20" cy="20" rx="14" ry="9" />
          <ellipse cx="20" cy="19" rx="6" ry="3" />
        </svg>
      );
    case "pyramid":
      return (
        <svg {...s}>
          <path d="M20 5 34 31H6z" />
          <path d="M20 5l4 26" />
        </svg>
      );
    default:
      return (
        <svg {...s}>
          <rect x="8" y="8" width="24" height="24" />
        </svg>
      );
  }
}
