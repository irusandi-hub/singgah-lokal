"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AdminDataTable,
  AdminStatusBadge,
  type AdminColumn,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import AdminSearchBox, { rowMatches } from "@/components/admin/admin-search-box";
import { producerRoleLabel } from "@/lib/producer";
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
 * ADMIN-REVOKE (0057): every relation row now carries ONE action,
 * "Cabut Hak Akses", which removes that Pengelola's management access to THAT
 * Place. The action:
 * - is a mirror only — the authorization, the last-owner safeguard, the audit
 *   trail, and the notifications all happen server-side in one transaction
 *   (POST /api/admin/producer-memberships/:membershipId/revoke);
 * - sends ONLY the membership id; the Pengelola and Tempat are resolved from
 *   the database row, never from the client;
 * - never fires before an explicit confirmation in a dialog that names the
 *   Pengelola (name + email), the Tempat, and what the person will lose;
 * - locks its own button while working and always shows the SERVER's own
 *   message — success is only reported when the server confirms it;
 * - refreshes the table from the server afterwards, keeping search, columns,
 *   ordering, and the responsive layout untouched.
 */

type Feedback = { kind: "ok" | "warn" | "error"; message: string } | null;

export default function AdminPengelolaTable({ relations }: { relations: AdminProducerPlaceRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<AdminProducerPlaceRow | null>(null);
  const [working, setWorking] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

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

  async function confirmRevoke() {
    const target = revokeTarget;
    if (!target || working) return;
    setWorking(true);
    try {
      const response = await fetch(
        `/api/admin/producer-memberships/${encodeURIComponent(target.membershipId)}/revoke`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        status?: string;
        message?: string;
        error?: string;
        notified?: boolean;
      };

      if (response.ok) {
        setRevokeTarget(null);
        // The server already told us whether the notification went out; a
        // failed notification must be surfaced, never hidden behind "sukses".
        setFeedback(
          payload.notified === false
            ? { kind: "warn", message: "Hak akses dicabut, tetapi notifikasi gagal dikirim." }
            : { kind: "ok", message: "Hak akses dicabut. Notifikasi sudah dikirim." },
        );
        router.refresh();
        return;
      }

      // Refusals (owner terakhir, id tidak ditemukan, sudah dicabut): the
      // server's own Indonesian message is what the operator sees.
      setRevokeTarget(null);
      setFeedback({
        kind: "error",
        message: payload.message ?? payload.error ?? "Hak akses gagal dicabut.",
      });
      // A state that changed outside this click (already revoked) needs a fresh
      // read so the table never shows a stale relation.
      if (payload.status === "already_revoked") router.refresh();
    } catch {
      setRevokeTarget(null);
      setFeedback({ kind: "error", message: "Hak akses gagal dicabut. Coba lagi." });
    } finally {
      setWorking(false);
    }
  }

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
      {revokeTarget ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="revoke-producer-access-title"
          aria-describedby="revoke-producer-access-warning"
          className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/40 p-4"
        >
          <div className="w-full max-w-sm rounded-2xl border border-black/10 bg-white p-4">
            <h4 id="revoke-producer-access-title" className="text-sm font-bold">
              Cabut Hak Akses?
            </h4>
            <dl className="mt-2 grid gap-1.5 text-xs leading-5">
              <div>
                <dt className="font-bold uppercase tracking-[0.1em] text-black/45">Pengelola</dt>
                <dd className="font-semibold" data-testid="revoke-dialog-producer">
                  {revokeTarget.producerName}
                </dd>
              </div>
              <div>
                <dt className="font-bold uppercase tracking-[0.1em] text-black/45">Email</dt>
                <dd data-testid="revoke-dialog-email">{revokeTarget.email ?? "—"}</dd>
              </div>
              <div>
                <dt className="font-bold uppercase tracking-[0.1em] text-black/45">Tempat</dt>
                <dd className="font-semibold" data-testid="revoke-dialog-place">
                  {revokeTarget.placeName ?? revokeTarget.producerId}
                </dd>
              </div>
              <div>
                <dt className="font-bold uppercase tracking-[0.1em] text-black/45">Status akses</dt>
                <dd>{producerRoleLabel(revokeTarget.role)}</dd>
              </div>
            </dl>
            <p id="revoke-producer-access-warning" className="mt-2.5 text-xs leading-5 text-black/60">
              Pengelola ini akan kehilangan akses mengelola Tempat tersebut. Pengelola itu dan
              pengelola lain Tempat itu akan diberi tahu lewat notifikasi.
            </p>
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => setRevokeTarget(null)}
                disabled={working}
                className="rounded-full border border-black/15 bg-white px-3 py-1.5 text-xs font-bold text-black/70 disabled:opacity-60"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => void confirmRevoke()}
                disabled={working}
                className="rounded-full bg-red-700 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-60"
              >
                {working ? "Mencabut…" : "Cabut Hak Akses"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
