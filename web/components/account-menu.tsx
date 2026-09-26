"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import SignOutButton from "./sign-out-button";

/**
 * Account/application menu — the single ☰ entry point in the header after
 * sign in (replaces the standalone email label, Kelola Akun button, and
 * Keluar button). Simple accessible dropdown: Escape and outside-pointer
 * close it, groups toggle open/closed, items that have no existing surface
 * yet stay visible but inert (no broken links, no invented scope).
 */

type MenuGroup = {
  id: "account" | "setting";
  label: string;
  items: { label: string; href?: string }[];
};

const MENU_GROUPS: MenuGroup[] = [
  {
    id: "account",
    label: "Kelola Akun",
    items: [
      { label: "Account Center", href: "/account" },
      { label: "Sign Out" }, // rendered with the existing SignOutButton
    ],
  },
  {
    id: "setting",
    label: "Setting",
    items: [
      { label: "Navigation" },
      { label: "App Language" },
      { label: "Video Setting" },
      // Notification Settings — the preferences surface. This is NOT a second
      // inbox entry point: the inbox lives behind the header bell only.
      { label: "Notification Settings", href: "/account/notifications" },
    ],
  },
];

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
          className="absolute right-0 top-12 z-40 w-60 rounded-2xl border border-black/10 bg-white p-2 shadow-lg"
        >
          {/* Kelola Akun */}
          <MenuGroupBlock
            label="Kelola Akun"
            expanded={expanded.account === true}
            onToggle={() => toggleGroup("account")}
          >
            <Link
              role="menuitem"
              href="/account"
              className="block rounded-xl px-3 py-2 text-sm font-medium text-brand-ink hover:bg-brand-cream"
              onClick={closeMenu}
            >
              Account Center
            </Link>
            <div className="rounded-xl px-1 hover:bg-brand-cream" onClick={closeMenu}>
              <SignOutButton variant="menu-item" />
            </div>
          </MenuGroupBlock>

          {/* Setting */}
          <MenuGroupBlock
            label="Setting"
            expanded={expanded.setting === true}
            onToggle={() => toggleGroup("setting")}
          >
            {MENU_GROUPS[1].items.map((item) =>
              item.href ? (
                <Link
                  key={item.label}
                  role="menuitem"
                  href={item.href}
                  className="block rounded-xl px-3 py-2 text-sm font-medium text-brand-ink hover:bg-brand-cream"
                  onClick={closeMenu}
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  key={item.label}
                  role="menuitem"
                  aria-disabled="true"
                  className="block cursor-default rounded-xl px-3 py-2 text-sm font-medium text-black/45"
                  title="Segera tersedia"
                >
                  {item.label}
                </span>
              ),
            )}
          </MenuGroupBlock>

          {/* Help — no existing help surface yet; keep safe, no dead link */}
          <div className="px-3 py-2 text-sm font-medium text-black/45" role="menuitem" aria-disabled="true" title="Segera tersedia">
            Help
          </div>

          {/* About & Terms — link to home brand footer area (existing content) */}
          <Link
            role="menuitem"
            href="/"
            className="block rounded-xl px-3 py-2 text-sm font-medium text-brand-ink hover:bg-brand-cream"
            onClick={closeMenu}
          >
            About &amp; Terms
          </Link>
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
  children: React.ReactNode;
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
