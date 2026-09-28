"use client";

import { useMemo, useState } from "react";
import {
  AdminDataTable,
  AdminStatusBadge,
  type AdminColumn,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import AdminSearchBox, { rowMatches } from "@/components/admin/admin-search-box";
import type { AdminMembershipRow } from "@/lib/admin/queries";

/**
 * The Admin Pengelola Membership list (PO, 2026-09-28): ONE search box above
 * the ONE table, matching on EMAIL or PLACE NAME — the identifying fields of
 * this list. Filtering happens in memory over the canonical dataset the
 * server already loaded and ordered; the table itself is the single shared
 * AdminDataTable (one table, 75vh, internal scroll — also on a phone).
 */
export default function AdminMembershipTable({ memberships }: { memberships: AdminMembershipRow[] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => memberships.filter((row) => rowMatches(query, [row.userEmail, row.placeName])),
    [memberships, query],
  );

  const columns: AdminColumn<AdminMembershipRow>[] = [
    { key: "user", header: "User", render: (row) => (row.userEmail ? <span className="text-sm">{row.userEmail}</span> : <span className="font-mono text-xs">{formatShortId(row.userId)}</span>) },
    { key: "producer", header: "Pengelola", render: (row) => <span className="font-mono text-xs">{formatShortId(row.producerId)}</span> },
    { key: "place", header: "Tempat", render: (row) => (row.placeName ? <span className="text-sm font-semibold">{row.placeName}</span> : <span className="font-mono text-xs">{formatShortId(row.placeId)}</span>) },
    {
      key: "role",
      header: "Role",
      render: (row) => (
        <AdminStatusBadge value={row.role} tone={row.role === "owner" ? "positive" : row.role === "manager" ? "warning" : "neutral"} />
      ),
    },
    { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
  ];

  return (
    <div className="grid gap-4">
      <AdminSearchBox label="Cari berdasarkan email atau nama Tempat…" onSearch={setQuery} />
      <AdminDataTable rows={filtered} emptyMessage="Tidak ada Pengelola Membership yang cocok." columns={columns} />
    </div>
  );
}
