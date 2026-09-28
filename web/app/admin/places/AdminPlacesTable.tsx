"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  AdminDataTable,
  AdminStatusBadge,
  type AdminColumn,
  formatAdminTimestamp,
} from "@/components/admin/ui";
import AdminSearchBox, { rowMatches } from "@/components/admin/admin-search-box";
import type { AdminPlaceRow } from "@/lib/admin/queries";

/**
 * The Admin Place list table (PO, 2026-09-28): ONE search box above the ONE
 * table, matching on OWNER EMAIL or PLACE NAME — the identifying fields of
 * this list. Filtering happens in memory over the canonical dataset the
 * server already loaded and ordered (country → region → name); the table
 * itself is the single shared AdminDataTable (one table, 75vh, internal
 * scroll — also on a phone).
 */
export default function AdminPlacesTable({ places }: { places: AdminPlaceRow[] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () => places.filter((row) => rowMatches(query, [row.ownerEmail, row.name])),
    [places, query],
  );

  const columns: AdminColumn<AdminPlaceRow>[] = [
    { key: "name", header: "Nama", render: (row) => <span className="font-bold">{row.name}</span> },
    { key: "area", header: "Area", render: (row) => `${row.area} · ${row.category} · ${row.type}` },
    {
      key: "region",
      header: "Negara / Provinsi",
      render: (row) =>
        row.countryCode && row.regionName ? `${row.regionName} · ${row.countryCode}` : <span className="text-black/40">—</span>,
    },
    {
      key: "publication",
      header: "Publikasi",
      render: (row) => (
        <AdminStatusBadge
          value={row.publicationStatus}
          tone={row.publicationStatus === "published" ? "positive" : row.publicationStatus === "archived" ? "negative" : "warning"}
        />
      ),
    },
    {
      key: "claim",
      header: "Claim",
      render: (row) => (
        <AdminStatusBadge
          value={row.claimStatus}
          tone={row.claimStatus === "verified" ? "positive" : row.claimStatus === "claimed" ? "warning" : "neutral"}
        />
      ),
    },
    {
      key: "owner",
      header: "Email Pengelola",
      render: (row) =>
        row.ownerEmail ? <span className="text-sm">{row.ownerEmail}</span> : <span className="text-black/40">—</span>,
    },
    { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
    {
      key: "manage",
      header: "",
      render: (row) => (
        <Link
          href={`/admin/places/${row.id}`}
          className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-brand-primary/40 px-3 py-1.5 text-xs font-bold text-brand-primary transition hover:bg-brand-primary/10"
        >
          Kelola
          <span aria-hidden>→</span>
        </Link>
      ),
    },
  ];

  return (
    <div className="grid gap-4">
      <AdminSearchBox label="Cari berdasarkan email Pengelola atau nama Tempat…" onSearch={setQuery} />
      <AdminDataTable rows={filtered} emptyMessage="Tidak ada Tempat yang cocok." columns={columns} />
    </div>
  );
}
