"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getActiveNavSection } from "@/lib/navigation";

type ProducerPlace = { id: string; name: string };

// Producer navigation entry. Visibility is gated by the server-derived
// membership probe (/api/auth/producer-session) — a regular user never sees
// it, and every Producer route still guards itself server-side. Active state
// is URL-derived so it stays correct on refresh and direct URLs.
export default function ProducerNav() {
  const pathname = usePathname();
  const [places, setPlaces] = useState<ProducerPlace[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/producer-session")
      .then((response) => (response.ok ? response.json() : { authorized: false }))
      .then((payload: { authorized?: boolean; places?: ProducerPlace[] }) => {
        if (cancelled) return;
        setPlaces(payload.authorized && payload.places?.length ? payload.places : []);
      })
      .catch(() => {
        if (!cancelled) setPlaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (places === null || places.length === 0) return null;

  const isProducerArea = getActiveNavSection(pathname) === "producer";
  const producerLinks = [
    { href: "/producer", label: "Dashboard" },
    { href: "/producer/places", label: "Places" },
    { href: "/producer/visit-intents", label: "Visit Intent Inbox" },
    { href: "/producer/live", label: "Live" },
  ];

  return (
    <div className="border-b border-black/5 bg-[#fffaf0]">
      <nav aria-label="Navigasi Producer" className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-5 py-2">
        <span className="text-[10px] font-black uppercase tracking-[0.18em] text-[#7b5b38]">Producer</span>
        {producerLinks.map(({ href, label }) => {
          const isActive = href === "/producer" ? isProducerArea : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              aria-current={isActive ? "page" : undefined}
              className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
                isActive ? "bg-[#7b5b38] text-white" : "text-[#7b5b38] hover:bg-[#7b5b38]/10"
              }`}
            >
              {label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
