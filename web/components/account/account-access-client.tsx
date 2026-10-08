"use client";

import { useMemo } from "react";
import type { AccountPlaceMembership } from "@/lib/account-memberships";

type Props = {
  memberships: AccountPlaceMembership[];
};

const ACCESS_ITEM: Record<AccountPlaceMembership["role"], { label: string; description: string }> = {
  owner: {
    label: "Pengelola",
    description: "Kelola Tempat, Kegiatan, Kunjungan, dan Live milikmu.",
  },
  manager: {
    label: "Pengelola",
    description: "Kelola Tempat, Kegiatan, Kunjungan, dan Live milikmu.",
  },
};

export default function AccountAccessClient({ memberships }: Props) {
  const items = useMemo(() => {
    const seen = new Set<string>();
    return [...memberships]
      .map((membership) => ACCESS_ITEM[membership.role])
      .filter((item) => {
        if (seen.has(item.label)) return false;
        seen.add(item.label);
        return true;
      });
  }, [memberships]);

  if (items.length === 0) return null;

  return (
    <div className="grid gap-2">
      {items.map(({ label, description }) => (
        <a
          key={label}
          href="/producer"
          className="flex w-full items-center gap-3 rounded-xl border border-black/10 bg-white px-3 py-2.5 text-left transition hover:bg-black/[0.02]"
        >
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-semibold">{label}</span>
            <span className="mt-0.5 block text-xs text-black/55">{description}</span>
          </span>
        </a>
      ))}
    </div>
  );
}
