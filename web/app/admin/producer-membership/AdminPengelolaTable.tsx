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
import type { AdminProducerPlaceRow } from "@/lib/admin/queries";

/**
 * The Data Pengelola list (PO, 2026-09-29): ONE search box above the ONE
 * table, matching on NAMA PENGELOLA, EMAIL, or NAMA PLACE. Filtering happens
 * in memory over the canonical dataset the server already loaded and ordered
 * (country → region → place name); the table itself is the single shared
 * AdminDataTable (one table, 75vh, internal scroll — also on a phone).
 *
 * The client re-applies the same canonical triple AFTER filtering so a
 * narrowed list stays in the required default order; the tie-break mirrors
 * the server's owner-first, then Pengelola-name.
 */
export default function AdminPengelolaTable({ relations }: { relations: AdminProducerPlaceRow[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const matches = relations.filter((row) =>
      rowMatches(query, [row.producerName, row.email, row.placeName]),
    );
    return [...matches].sort((a, b) => {
      const rank = (value: string | null) => (value === null || value === "" ? 1 : 0);
      return (
        rank(a.countryCode) - rank(b.countryCode) ||
        (a.countryCode ?? "").localeCompare(b.countryCode ?? "", "en") ||
        rank(a.regionName) - rank(b.regionName) ||
        (a.regionName ?? "").localeCompare(b.regionName ?? "", "en") ||
        rank(a.placeName) - rank(b.placeName) ||
        (a.placeName ?? "").localeCompare(b.placeName ?? "", "en") ||
        (a.role === "owner" ? 0 : 1) - (b.role === "owner" ? 0 : 1) ||
        a.producerName.localeCompare(b.producerName, "en")
      );
    });
  }, [relations, query]);

  const columns: AdminColumn<AdminProducerPlaceRow>[] = [
    {
      key: "producer",
      header: "Nama Pengelola",
      render: (row) => <span className="font-bold">{row.producerName}</span>,
    },
    {
      key: "email",
      header: "Email",
      render: (row) =>
        row.email ? <span className="text-sm">{row.email}</span> : <span className="text-black/40">—</span>,
    },
    {
      key: "place",
      header: "Nama Place",
      render: (row) =>
        row.placeName ? (
          <span className="text-sm font-semibold">{row.placeName}</span>
        ) : (
          <span className="font-mono text-xs">{formatShortId(row.producerId)}</span>
        ),
    },
    {
      key: "country",
      header: "Negara",
      render: (row) => (row.countryCode ? <span className="text-sm">{row.countryCode}</span> : <span className="text-black/40">—</span>),
    },
    {
      key: "region",
      header: "Provinsi / Wilayah",
      render: (row) => (row.regionName ? <span className="text-sm">{row.regionName}</span> : <span className="text-black/40">—</span>),
    },
    {
      key: "category",
      header: "Kategori",
      render: (row) => (row.category ? <span className="text-sm">{row.category}</span> : <span className="text-black/40">—</span>),
    },
    {
      key: "role",
      header: "Status Akses",
      render: (row) => (
        <AdminStatusBadge
          value={row.role}
          tone={row.role === "owner" ? "positive" : row.role === "manager" ? "warning" : "neutral"}
        />
      ),
    },
    {
      key: "created",
      header: "Tanggal Dibuat",
      render: (row) => (row.placeCreatedAt ? formatAdminTimestamp(row.placeCreatedAt) : <span className="text-black/40">—</span>),
    },
  ];

  return (
    <div className="grid gap-4">
      <AdminSearchBox label="Cari berdasarkan nama Pengelola, email, atau nama Place…" onSearch={setQuery} />
      <AdminDataTable rows={filtered} emptyMessage="Tidak ada relasi Pengelola yang cocok." columns={columns} />
    </div>
  );
}
