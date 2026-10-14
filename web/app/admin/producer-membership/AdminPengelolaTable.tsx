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
import ProducerAccessRevokeDialog, {
  type ProducerAccessRevokeFeedback,
} from "@/components/admin/producer-access-revoke-dialog";
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
 *
 * ADMIN-REVOKE (0057): every relation row carries ONE action, "Cabut Hak
 * Akses", which removes that Pengelola's management access to THAT Place. The
 * confirmation dialog + request are the SHARED component
 * (components/admin/producer-access-revoke-dialog.tsx) — the same one the
 * Place-detail "Pengelola" section uses, so there is exactly one revocation
 * implementation. The label here stays "Cabut Hak Akses"; the Place-detail
 * surface uses "Cabut Hak Pengelolaan".
 */

export default function AdminPengelolaTable({ relations }: { relations: AdminProducerPlaceRow[] }) {
  const [query, setQuery] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<AdminProducerPlaceRow | null>(null);
  const [feedback, setFeedback] = useState<ProducerAccessRevokeFeedback>(null);

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
    {
      key: "action",
      header: "Aksi",
      render: (row) => (
        <button
          type="button"
          // The action names the exact Pengelola and Tempat of this row, so a
          // screen reader (and a mis-tap) can never confuse two relations.
          aria-label={`Cabut hak akses ${row.producerName} atas ${row.placeName ?? row.producerId}`}
          onClick={() => {
            setFeedback(null);
            setRevokeTarget(row);
          }}
          className="inline-block max-w-full whitespace-normal rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-[11px] font-bold leading-tight text-red-800 transition hover:bg-red-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-red-400"
        >
          Cabut Hak Akses
        </button>
      ),
    },
  ];

  return (
    <div className="grid gap-4">
      <AdminSearchBox label="Cari berdasarkan nama Pengelola, email, atau nama Place…" onSearch={setQuery} />

      {feedback ? (
        <p
          role={feedback.kind === "error" ? "alert" : "status"}
          className={`rounded-xl border px-3.5 py-2.5 text-sm font-semibold ${
            feedback.kind === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : feedback.kind === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {feedback.message}
        </p>
      ) : null}

      <AdminDataTable rows={filtered} emptyMessage="Tidak ada relasi Pengelola yang cocok." columns={columns} />

      {/* Removing a Pengelola's management access cannot be undone from this
          screen, so the action never fires before an explicit confirmation. */}
      <ProducerAccessRevokeDialog
        revokeTarget={revokeTarget}
        actionLabel="Cabut Hak Akses"
        dialogTitle="Cabut Hak Akses?"
        warning="Pengelola ini akan kehilangan akses mengelola Tempat tersebut. Pengelola itu dan pengelola lain Tempat itu akan diberi tahu lewat notifikasi."
        onClose={() => setRevokeTarget(null)}
        onFeedback={setFeedback}
      />
    </div>
  );
}
