import {
  AdminDataTable,
  AdminStatusBadge,
  type AdminColumn,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import type { PlaceClaimArchiveRow } from "@/lib/admin/place-claim-archive";
import { ARCHIVE_SEARCH_LABELS, type ArchiveSearchKey } from "@/lib/admin/archive-search";

/**
 * The archive RESULT table: claim metadata only. Evidence file CONTENTS are
 * never displayed, minted, or linked — the file name is shown as the reference
 * that the private bucket holds (MASTER §6), nothing more. Every cell reuses
 * the shared AdminDataTable (75vh, internal scroll, wrap-in-cell — no mobile
 * overflow).
 */
export default function ClaimArchiveResults({
  results,
  searchKey,
  query,
}: {
  results: PlaceClaimArchiveRow[];
  searchKey: ArchiveSearchKey;
  query: string;
}) {
  if (results.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-black/15 bg-white p-6 text-sm text-black/55">
        Tidak ada arsip klaim yang cocok untuk {ARCHIVE_SEARCH_LABELS[searchKey]}{" "}
        <span className="font-mono">{query}</span>. Arsip hanya berlaku 30 hari sejak pengarsipan.
      </p>
    );
  }

  const columns: AdminColumn<PlaceClaimArchiveRow>[] = [
    { key: "claim", header: "Claim ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
    { key: "place", header: "Place ID", render: (row) => <span className="font-mono text-xs">{row.placeId}</span> },
    {
      key: "claimant",
      header: "Pengelola ID",
      render: (row) => <span className="font-mono text-xs">{formatShortId(row.userId)}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <AdminStatusBadge
          value={row.status}
          tone={row.status === "approved" ? "positive" : row.status === "rejected" ? "negative" : "warning"}
        />
      ),
    },
    {
      key: "evidence",
      header: "Bukti (nama file)",
      render: (row) =>
        row.evidenceFileName ? (
          <span className="text-sm">{row.evidenceFileName}</span>
        ) : (
          <span className="text-black/40">—</span>
        ),
    },
    {
      key: "note",
      header: "Catatan pengaju",
      render: (row) => (row.note ? <span className="text-sm">{row.note}</span> : <span className="text-black/40">—</span>),
    },
    {
      key: "reviewNote",
      header: "Catatan review",
      render: (row) =>
        row.reviewNote ? <span className="text-sm">{row.reviewNote}</span> : <span className="text-black/40">—</span>,
    },
    {
      key: "reviewed",
      header: "Direview",
      render: (row) => (row.reviewedAt ? formatAdminTimestamp(row.reviewedAt) : <span className="text-black/40">—</span>),
    },
    { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
    { key: "archived", header: "Diarsipkan", render: (row) => formatAdminTimestamp(row.archivedAt) },
  ];

  return (
    <section aria-label="Hasil arsip klaim" className="space-y-3">
      <p className="text-sm text-black/55">
        {results.length} baris ditemukan untuk {ARCHIVE_SEARCH_LABELS[searchKey]}{" "}
        <span className="font-mono">{query}</span>. Hanya metadata — isi file bukti tidak ditampilkan.
      </p>
      <AdminDataTable rows={results} emptyMessage="Tidak ada arsip yang cocok." columns={columns} />
    </section>
  );
}
