import {
  AdminBackToAdminCenter,
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { listAdminEligibility, listAdminLiveReports, type AdminEligibilityRow, type AdminLiveReportRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";

export const dynamic = "force-dynamic";

/**
 * Admin Live — READ-ONLY report queue and Producer eligibility
 * (PO, 2026-09-28).
 *
 * Live Session and Live summary cards are GONE from this page. A Live session
 * belongs to the Place it happens in, so it is read in the Place workspace
 * (/admin/places/[placeId]) next to the Place's own data instead of being
 * listed platform-wide here. What remains is the read-only report queue and
 * the eligibility table, and the existing RPC-gated eligibility actions.
 *
 * This page observes. It never starts, ends, or moderates a Live session —
 * those flows are unchanged.
 */
export default async function AdminLivePage() {
  let reports: AdminLiveReportRow[];
  let eligibility: AdminEligibilityRow[];
  try {
    [reports, eligibility] = await Promise.all([listAdminLiveReports(), listAdminEligibility()]);
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Data Live" description="Laporan Live dan kelayakan Pengelola." />
        <AdminErrorState message="Data Live tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AdminBackToAdminCenter />
      <AdminPageHeader
        title="Data Live"
        description="Laporan Live dan kelayakan Pengelola, dibaca saja. Data sesi Live milik sebuah Tempat ditampilkan di workspace Tempat tersebut. Batas terkunci: global 5 aktif, 1 per Tempat, 100 penonton, 60 menit."
      />

      <section aria-label="Laporan Live" className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Laporan Live</h3>
        <AdminDataTable
          rows={reports}
          emptyMessage="Belum ada Laporan Live."
          columns={[
            { key: "id", header: "ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
            { key: "session", header: "Sesi Live", render: (row) => <span className="font-mono text-xs">{formatShortId(row.liveSessionId)}</span> },
            { key: "category", header: "Kategori", render: (row) => <AdminStatusBadge value={row.category} tone={row.category === "other" ? "neutral" : "warning"} /> },
            { key: "note", header: "Keterangan", render: (row) => row.note ?? <span className="text-black/40">—</span> },
            { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
          ]}
        />
      </section>

      <section aria-label="Kelayakan Pengelola" className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Kelayakan Pengelola</h3>
        <p className="text-sm text-black/55">
          Pemberian dan pencabutan kelayakan tetap melalui jalur yang sudah diaudit (RPC{' '}
          <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs">grant_live_eligibility</code> /{' '}
          <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs">revoke_live_eligibility</code>).
        </p>
        <AdminDataTable<AdminEligibilityRow>
          rows={eligibility}
          emptyMessage="Belum ada eligibility yang diberikan."
          columns={[
            { key: "producer", header: "Pengelola", render: (row) => <span className="font-mono text-xs">{formatShortId(row.producerId)}</span> },
            { key: "path", header: "Path", render: (row) => <AdminStatusBadge value={row.path} tone={row.path === "ADMIN_APPROVED" ? "positive" : "neutral"} /> },
            { key: "active", header: "Aktif", render: (row) => (row.active ? <AdminStatusBadge value="aktif" tone="positive" /> : <AdminStatusBadge value="nonaktif" tone="negative" />) },
            { key: "granted", header: "Diberikan", render: (row) => formatAdminTimestamp(row.grantedAt) },
          ]}
        />
      </section>
    </div>
  );
}
