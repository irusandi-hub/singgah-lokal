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

/** Akun & Akses — the account destination (key glyph). */
export function AccountIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3.5 20v-1.2a4 4 0 0 1 4-4h3a4 4 0 0 1 4 4V20" />
      <path d="M15.5 9.2h5" />
      <path d="M18 6.7v5" />
    </svg>
  );
}

/** Keluar — leaving the session (logout glyph). */
export function SignOutIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13A1.5 1.5 0 0 1 18.5 20H15" />
      <path d="M11 16l4-4-4-4" />
      <path d="M15 12H4" />
    </svg>
  );
}

/** Pengaturan Notifikasi (bell glyph). */
export function NotificationGlyphIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

/** Navigasi (compass glyph) — inert preference item. */
export function NavigationIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.4 8.6l-2 4.8-4.8 2 2-4.8z" />
    </svg>
  );
}

/** Bahasa Aplikasi (globe glyph) — inert preference item. */
export function LanguageIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 12h17" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
    </svg>
  );
}

/** Pengaturan Video (play glyph) — inert preference item. */
export function VideoIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <rect x="3" y="6" width="12" height="12" rx="2.5" />
      <path d="M15 11l6-3.2v8.4L15 13z" />
    </svg>
  );
}

/** Bantuan (life-ring glyph). */
export function HelpIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.4" />
      <path d="M5.6 5.6l3.5 3.5" />
      <path d="M14.9 14.9l3.5 3.5" />
      <path d="M18.4 5.6l-3.5 3.5" />
      <path d="M9.1 14.9l-3.5 3.5" />
    </svg>
  );
}

/** Tentang (info glyph). */
export function AboutIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5" />
      <path d="M12 7.6h.01" />
    </svg>
  );
}

/** The shared right-facing chevron used by every navigating account row. */
export function ChevronIcon({ className = "h-4 w-4 shrink-0 text-black/30" }: IconProps) {
  return (
    <svg {...svgProps(className)} strokeWidth={2}>
      <path d="M9.5 6l6 6-6 6" />
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
