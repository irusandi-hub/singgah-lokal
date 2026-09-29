"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Admin tab navigation, client-rendered so the ACTIVE tab is real (PO,
 * 2026-09-28).
 *
 * The layout is a server component and cannot know the current path, so before
 * this component every tab rendered identical and a nested route — the Place
 * workspace, a Producer detail — showed no tab at all. `usePathname` fixes
 * both: the exact match is active, and a nested path falls back to the
 * longest matching section, so `/admin/places/[placeId]` lights up "Data Place".
 *
 * The list is the MVP tab set (PO, 2026-09-29): Overview, Data Pengguna, Data
 * Pengelola, Data Place, Data Live, Live Moderation. The former standalone
 * "Pengelola" tab is GONE — its data lives in Data Pengelola, which shows the
 * Pengelola ↔ Place relations. "Kegiatan" and "Kunjungan" are NOT MVP Admin
 * tabs and stay out of the navigation; their pages remain reachable by direct
 * URL (unchanged data layer, unchanged guards) — no dead links, because
 * nothing links to them anymore.
 */
const SECTIONS = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/users", label: "Data Pengguna", exact: false },
  { href: "/admin/producer-membership", label: "Data Pengelola", exact: false },
  { href: "/admin/places", label: "Data Place", exact: false },
  { href: "/admin/live", label: "Data Live", exact: false },
  { href: "/admin/moderation", label: "Live Moderation", exact: false },
] as const;

const IDLE = "border border-black/10 bg-white text-black/60 hover:bg-brand-accent/10 hover:text-brand-accent";
const ACTIVE = "border-brand-primary bg-brand-primary text-white";

export default function AdminNav() {
  const pathname = usePathname();

  let activeHref = "";
  for (const { href, exact } of SECTIONS) {
    const matches = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
    if (matches) {
      activeHref = href;
      break;
    }
  }
  // An unknown /admin/* child still belongs to the Admin area; leave every
  // tab idle rather than guessing a wrong parent.

  return (
    <nav aria-label="Navigasi Admin" className="mt-3 flex flex-wrap gap-2">
      {SECTIONS.map(({ href, label }) => {
        const active = href === activeHref;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`rounded-full border px-3.5 py-1.5 text-xs font-bold transition ${active ? ACTIVE : IDLE}`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
