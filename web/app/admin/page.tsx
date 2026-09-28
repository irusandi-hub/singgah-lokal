import {
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatCards,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { getAdminOverview, type AdminOverview } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";

export const dynamic = "force-dynamic";

/**
 * Admin Overview (Authority Master §5: operational monitoring). Totals and
 * recent operational data come straight from canonical Supabase — no cache,
 * no search index. Failures render an explicit error state, never fabricated
 * data. Data is fetched inside try/catch; JSX renders outside of it.
 *
 * Live is deliberately NOT summarised here (PO, 2026-09-28): a Live session
 * only means something in the Place it happens in, so the Place workspace
 * shows that Place's sessions and reports, and /admin/live keeps the
 * read-only report queue. The Overview carries platform counts and the
 * newest Kunjungan, nothing more.
 */
export default async function AdminOverviewPage() {
  let overview: AdminOverview;
  try {
    overview = await getAdminOverview();
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) {
      throw error; // layout guard handles auth state (redirect/403)
    }
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Overview" description="Ringkasan operasional platform." />
        <AdminErrorState message="Data overview tidak dapat dimuat. Tidak ada data yang ditampilkan agar tidak menyesatkan." />
      </div>
    );
  }

  const { totals } = overview;

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Overview"
        description="Ringkasan operasional platform dari data canonical Supabase. Angka dihitung langsung dari database saat halaman dimuat."
      />

      <AdminStatCards
        stats={[
          { label: "Users", value: totals.users },
          { label: "Pengelola", value: totals.producers },
          { label: "Memberships", value: totals.producerMemberships },
          { label: "Tempat", value: totals.places },
          { label: "Kegiatan", value: totals.experiences },
          { label: "Kunjungan", value: totals.visitIntents },
        ]}
      />

      <section aria-label="Kunjungan terbaru" className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Kunjungan terbaru</h3>
        <AdminDataTable
          rows={overview.recentVisitIntents}
          emptyMessage="Belum ada Kunjungan."
          columns={[
            { key: "id", header: "ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
            { key: "place", header: "Tempat", render: (row) => <span className="font-mono text-xs">{formatShortId(row.placeId)}</span> },
            { key: "slot", header: "Jadwal", render: (row) => `${row.requestedDate} ${row.requestedStartTime}–${row.requestedEndTime}` },
            { key: "status", header: "Status", render: (row) => <AdminStatusBadge value={row.status} tone={row.status === "accepted" ? "positive" : row.status === "declined" ? "negative" : "neutral"} /> },
            { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
          ]}
        />
      </section>

    </div>
  );
}
