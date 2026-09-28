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
 * longest matching section, so `/admin/places/[placeId]` lights up "Tempat".
 *
 * The list is the same nine sections the layout already had — unchanged
 * wording, unchanged order, unchanged destinations. Only the active cue is
 * new: filled accent pill for the active tab, the same quiet pill for the
 * rest, so the position in the Admin area is always readable at a glance.
 */
const SECTIONS = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/users", label: "Users", exact: false },
  { href: "/admin/producers", label: "Pengelola", exact: false },
  { href: "/admin/producer-membership", label: "Pengelola Membership", exact: false },
  { href: "/admin/places", label: "Tempat", exact: false },
  { href: "/admin/experiences", label: "Kegiatan", exact: false },
  { href: "/admin/visit-intents", label: "Kunjungan", exact: false },
  { href: "/admin/live", label: "Live", exact: false },
  { href: "/admin/moderation", label: "Moderation", exact: false },
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
