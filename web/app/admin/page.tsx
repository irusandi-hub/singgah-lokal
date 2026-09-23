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
          { label: "Producers", value: totals.producers },
          { label: "Memberships", value: totals.producerMemberships },
          { label: "Places", value: totals.places },
          { label: "Experiences", value: totals.experiences },
          { label: "Visit Intents", value: totals.visitIntents },
          { label: "Live Sessions", value: totals.liveSessions },
          { label: "Live Reports", value: totals.liveReports },
        ]}
      />

      <section aria-label="Visit Intent terbaru" className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Visit Intent terbaru</h3>
        <AdminDataTable
          rows={overview.recentVisitIntents}
          emptyMessage="Belum ada Visit Intent."
          columns={[
            { key: "id", header: "ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
            { key: "place", header: "Place", render: (row) => <span className="font-mono text-xs">{formatShortId(row.placeId)}</span> },
            { key: "slot", header: "Jadwal", render: (row) => `${row.requestedDate} ${row.requestedStartTime}–${row.requestedEndTime}` },
            { key: "status", header: "Status", render: (row) => <AdminStatusBadge value={row.status} tone={row.status === "accepted" ? "positive" : row.status === "declined" ? "negative" : "neutral"} /> },
            { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
          ]}
        />
      </section>

      <section aria-label="Live Session terbaru" className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Live Session terbaru</h3>
        <AdminDataTable
          rows={overview.recentLiveSessions}
          emptyMessage="Belum ada Live Session."
          columns={[
            { key: "id", header: "ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
            { key: "place", header: "Place", render: (row) => <span className="font-mono text-xs">{formatShortId(row.placeId)}</span> },
            { key: "status", header: "Status", render: (row) => <AdminStatusBadge value={row.status} tone={row.status === "live" ? "live" : "neutral"} /> },
            { key: "peak", header: "Puncak penonton", render: (row) => row.viewerPeak },
            { key: "started", header: "Mulai", render: (row) => formatAdminTimestamp(row.startedAt) },
          ]}
        />
      </section>

      <section aria-label="Live Report terbaru" className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Live Report terbaru</h3>
        <AdminDataTable
          rows={overview.recentLiveReports}
          emptyMessage="Belum ada Live Report."
          columns={[
            { key: "id", header: "ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
            { key: "session", header: "Live Session", render: (row) => <span className="font-mono text-xs">{formatShortId(row.liveSessionId)}</span> },
            { key: "category", header: "Kategori", render: (row) => <AdminStatusBadge value={row.category} tone={row.category === "other" ? "neutral" : "warning"} /> },
            { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
          ]}
        />
      </section>
    </div>
  );
}
