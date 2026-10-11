"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import SignOutButton from "./sign-out-button";
import {
  AboutIcon,
  AccountIcon,
  ChevronIcon,
  HelpIcon,
  LanguageIcon,
  NavigationIcon,
  NotificationGlyphIcon,
  SignOutIcon,
  VideoIcon,
} from "./account/account-icons";

/**
 * Account/application menu — the single ☰ entry point in the header after
 * sign in (replaces the standalone email label, Kelola Akun button, and
 * Keluar button).
 *
 * Structure (Tahap 3 mobile pass): ONE grouped list rendered from ONE data array
 * — the previous version declared its first group as data and then repeated it
 * as hand-written JSX, which is exactly the duplicated label/markup this pass
 * removes. Group headings stay ("Kelola Akun", "Pengaturan"), every item carries
 * its icon, and every item that NAVIGATES carries the same right-facing chevron;
 * items with no existing surface yet stay visibly inert ("Segera tersedia") and
 * deliberately have no chevron, because they do not navigate anywhere.
 *
 * Simple accessible dropdown: Escape and outside-pointer close it, groups toggle
 * open/closed, the whole state resets on route change so no menu state can stack
 * between pages. Navigation is unchanged — Akun & Akses opens the destination
 * page whose title matches the label (docs/UI_TERMINOLOGY_STANDARD.md), and the
 * inbox stays behind the header bell (this menu only links the preferences page).
 */

type MenuItem = { label: string; href?: string };

type MenuGroup = {
  id: "account" | "setting";
  label: string;
  items: MenuItem[];
};

const MENU_GROUPS: MenuGroup[] = [
  {
    id: "account",
    label: "Kelola Akun",
    items: [
      // Label matches the destination page title (Akun & Akses).
      { label: "Akun & Akses", href: "/account" },
      { label: "Keluar" }, // rendered with the existing SignOutButton
    ],
  },
  {
    id: "setting",
    label: "Pengaturan",
    items: [
      { label: "Navigasi" },
      { label: "Bahasa Aplikasi" },
      { label: "Pengaturan Video" },
      // Pengaturan Notifikasi — the preferences surface. This is NOT a second
      // inbox entry point: the inbox lives behind the header bell only.
      { label: "Pengaturan Notifikasi", href: "/account/notifications" },
    ],
  },
];

/**
 * Icon per label. Keyed by the locked label so the groups above stay a plain
 * data array; presentation only — a missing entry simply renders no glyph.
 */
const MENU_ICONS: Readonly<Record<string, ReactNode>> = {
  "Akun & Akses": <AccountIcon />,
  Keluar: <SignOutIcon />,
  Navigasi: <NavigationIcon />,
  "Bahasa Aplikasi": <LanguageIcon />,
  "Pengaturan Video": <VideoIcon />,
  "Pengaturan Notifikasi": <NotificationGlyphIcon />,
  Bantuan: <HelpIcon />,
  Tentang: <AboutIcon />,
};

/** The two standalone destinations that do not belong to a settings group. */
const MENU_DESTINATIONS: MenuItem[] = [
  { label: "Bantuan", href: "/help" },
  { label: "Tentang", href: "/about" },
];

const ITEM_BASE =
  "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium";
const ITEM_LINK = `${ITEM_BASE} justify-between text-brand-ink hover:bg-brand-cream`;
const ITEM_INERT = `${ITEM_BASE} cursor-default text-black/45`;

function ItemContent({ label }: { label: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {MENU_ICONS[label] ?? null}
      <span className="min-w-0 break-words">{label}</span>
    </span>
  );
}

export default function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  // Route navigation (item click, back/forward, programmatic) closes the
  // menu and resets transient group state before the new page paints.
  // Render-time adjustment (React's recommended pattern) — no effect
  // setState, so no cascading render and no stacked menu between routes.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (lastPathname !== pathname) {
    setLastPathname(pathname);
    setOpen(false);
    setExpanded({});
  }

  // Outside pointer + Escape close the whole menu.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Closing resets transient group state: reopening the menu always shows
  // the same collapsed groups — no stacked/resurrected UI state.
  const closeMenu = useCallback(() => {
    setOpen(false);
    setExpanded({});
  }, []);

  const toggleGroup = useCallback((id: string) => {
    setExpanded((current) => ({ ...current, [id]: !current[id] }));
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Buka menu akun dan aplikasi"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-white text-brand-ink transition hover:bg-brand-primary hover:text-white"
      >
        <svg aria-hidden fill="none" height="18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" viewBox="0 0 24 24" width="18">
          <line x1="4" x2="20" y1="6" y2="6" />
          <line x1="4" x2="20" y1="12" y2="12" />
          <line x1="4" x2="20" y1="18" y2="18" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Menu akun dan aplikasi"
          className="absolute right-0 top-12 z-40 w-64 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-black/10 bg-white p-2 shadow-lg"
        >
          {MENU_GROUPS.map((group) => (
            <MenuGroupBlock
              key={group.id}
              label={group.label}
              expanded={expanded[group.id] === true}
              onToggle={() => toggleGroup(group.id)}
            >
              {group.items.map((item) => {
                if (item.href) {
                  return (
                    <Link
                      key={item.label}
                      role="menuitem"
                      href={item.href}
                      className={ITEM_LINK}
                      onClick={closeMenu}
                    >
                      <ItemContent label={item.label} />
                      <ChevronIcon />
                    </Link>
                  );
                }
                // Keluar is the ONE action that is not a destination: it reuses
                // the existing SignOutButton implementation.
                if (item.label === "Keluar") {
                  return (
                    <div key={item.label} className="rounded-xl px-1 hover:bg-brand-cream" onClick={closeMenu}>
                      <SignOutButton variant="menu-item" />
                    </div>
                  );
                }
                return (
                  <span
                    key={item.label}
                    role="menuitem"
                    aria-disabled="true"
                    className={ITEM_INERT}
                    title="Segera tersedia"
                  >
                    <ItemContent label={item.label} />
                  </span>
                );
              })}
            </MenuGroupBlock>
          ))}

          {/* Help and Tentang are real surfaces, so they are ordinary
              destinations in the same list — not a second group, not a
              duplicate entry, and each carries the shared chevron. */}
          <div className="mt-1 grid gap-0.5 border-t border-black/5 pt-1">
            {MENU_DESTINATIONS.map((item) => (
              <Link
                key={item.label}
                role="menuitem"
                href={item.href ?? "/"}
                className={ITEM_LINK}
                onClick={closeMenu}
              >
                <ItemContent label={item.label} />
                <ChevronIcon />
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MenuGroupBlock({
  label,
  expanded,
  onToggle,
  children,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="border-b border-black/5 pb-1 last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-sm font-bold text-brand-ink hover:bg-brand-cream"
      >
        {label}
        <svg aria-hidden fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="14" className={`transition-transform ${expanded ? "rotate-180" : ""}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded ? <div className="mt-1 space-y-0.5 pb-1 pl-2">{children}</div> : null}
    </div>
  );
}
