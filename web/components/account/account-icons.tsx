/**
 * ACCESS ROW ICONS — small presentational glyphs for the Account & Access
 * destination rows (Android-inspired grouped list: every row carries one
 * recognizable icon). Presentation only: no state, no data, `aria-hidden`
 * because the row label already names the destination.
 */

type IconProps = { className?: string };

const BASE = "h-5 w-5 shrink-0";

function svgProps(className = `${BASE} text-brand-accent`) {
  return {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

/** Pengelola — owner/manager of one's own Places (people glyph). */
export function PengelolaIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20" />
      <circle cx="10" cy="8" r="3.2" />
      <path d="M20 20v-1.5a3.5 3.5 0 0 0-2.6-3.4" />
      <path d="M15.4 5.2a3.2 3.2 0 0 1 0 5.6" />
    </svg>
  );
}

/** Operator Live — delegated Live operation for one Place (broadcast glyph). */
export function OperatorLiveIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <circle cx="12" cy="12" r="2.2" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4" />
      <path d="M16.2 7.8a6 6 0 0 1 0 8.4" />
      <path d="M5.2 5.2a9.6 9.6 0 0 0 0 13.6" />
      <path d="M18.8 5.2a9.6 9.6 0 0 1 0 13.6" />
    </svg>
  );
}

/** Platform Admin — operational authority inside the app (shield glyph). */
export function AdminIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M12 3l7 2.6v5.1c0 4.3-2.9 7.6-7 9.3-4.1-1.7-7-5-7-9.3V5.6L12 3z" />
      <path d="M9 11.8l2.2 2.2 4-4.4" />
    </svg>
  );
}

/** Developer — Creator authority (code glyph). */
export function DeveloperIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M9 7l-4.5 5L9 17" />
      <path d="M15 7l4.5 5L15 17" />
      <path d="M13 5.5l-2 13" />
    </svg>
  );
}
