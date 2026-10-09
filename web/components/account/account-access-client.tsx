"use client";

import { useMemo } from "react";
import type { AccountPlaceMembership } from "@/lib/account-memberships";
import { ListRow } from "@/components/ui/kit";
import { PengelolaIcon } from "./account-icons";

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

/**
 * PENGELOLA — the ONE row for producer authority, however many owner/manager
 * memberships the account holds. The row is a destination to /producer; the
 * count of managed Places is not a second label, so several memberships never
 * produce duplicate rows.
 */
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
        <ListRow
          key={label}
          href="/producer"
          leading={<PengelolaIcon />}
          title={label}
          meta={description}
        />
      ))}
    </div>
  );
}
