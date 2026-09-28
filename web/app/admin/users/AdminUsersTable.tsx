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
import type { AdminDirectoryUserRow } from "@/lib/admin/user-directory";

/**
 * The Admin Users list (PO, 2026-09-28): ONE search box above the ONE table,
 * searching by EMAIL — the identifying field of this list. Filtering happens
 * in memory over the canonical dataset the server already loaded and ordered;
 * the table itself is the single shared AdminDataTable (one table, 75vh,
 * internal scroll — also on a phone).
 */
export default function AdminUsersTable({ users }: { users: AdminDirectoryUserRow[] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => users.filter((user) => rowMatches(query, [user.email])),
    [users, query],
  );

  const columns: AdminColumn<AdminDirectoryUserRow>[] = [
    { key: "id", header: "User ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
    { key: "email", header: "Email", render: (row) => (row.email ? <span className="text-sm">{row.email}</span> : <span className="text-black/40">—</span>) },
    { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
    {
      key: "role",
      header: "Platform Role",
      render: (row) =>
        row.platformRole ? <AdminStatusBadge value={row.platformRole} tone="live" /> : <span className="text-black/40">—</span>,
    },
  ];

  return (
    <div className="grid gap-4">
      <AdminSearchBox label="Cari berdasarkan email…" onSearch={setQuery} />
      <AdminDataTable rows={filtered} emptyMessage="Tidak ada user yang cocok." columns={columns} />
    </div>
  );
}
