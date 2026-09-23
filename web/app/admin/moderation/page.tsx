import {
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { listAdminAudit, listAdminLiveReports, type AdminAuditRow, type AdminLiveReportRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";

export const dynamic = "force-dynamic";

/**
 * Admin Moderation (Policy §5: moderation/enforcement authority = Platform
 * Admin). Reports and audit are shown as canonical data. Enforcement actions
 * (warn/end/suspend) remain in the existing RPC-gated moderation API — this
 * MVP page observes and never mutates.
 */
export default async function AdminModerationPage() {
  let reports: AdminLiveReportRow[];
  let audit: AdminAuditRow[];
  try {
    [reports, audit] = await Promise.all([listAdminLiveReports(), listAdminAudit()]);
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Moderation" description="Live Report masuk dan jejak audit Live." />
        <AdminErrorState message="Data Moderation tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Moderation"
        description="Live Report masuk dan jejak audit Live terbaru. Tindakan enforcement tetap melalui jalur RPC yang sudah diaudit."
      />

      <section aria-label="Live Reports" className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Live Reports</h3>
        <AdminDataTable<AdminLiveReportRow>
          rows={reports}
          emptyMessage="Belum ada Live Report. Semua Live aman sejauh ini."
          columns={[
            { key: "id", header: "ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
            { key: "session", header: "Live Session", render: (row) => <span className="font-mono text-xs">{formatShortId(row.liveSessionId)}</span> },
            { key: "category", header: "Kategori", render: (row) => <AdminStatusBadge value={row.category} tone={row.category === "other" ? "neutral" : "warning"} /> },
            { key: "note", header: "Catatan", render: (row) => (row.note ? <span className="max-w-xs break-words">{row.note}</span> : <span className="text-black/40">—</span>) },
            { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
          ]}
        />
      </section>

      <section aria-label="Audit Live terbaru" className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Audit Live terbaru</h3>
        <AdminDataTable<AdminAuditRow>
          rows={audit}
          emptyMessage="Belum ada entri audit yang dapat dibaca."
          columns={[
            { key: "action", header: "Aksi", render: (row) => <AdminStatusBadge value={row.action} tone={row.action.startsWith("moderation") ? "warning" : "neutral"} /> },
            { key: "actor", header: "Aktor", render: (row) => (row.actorId ? <span className="font-mono text-xs">{formatShortId(row.actorId)}</span> : <span className="text-black/40">sistem</span>) },
            {
              key: "detail",
              header: "Detail",
              render: (row) => {
                const entries = Object.entries(row.detail);
                if (entries.length === 0) return <span className="text-black/40">—</span>;
                return (
                  <span className="font-mono text-[11px] text-black/60">
                    {entries.map(([key, value]) => `${key}=${String(value)}`).join(" · ")}
                  </span>
                );
              },
            },
            { key: "created", header: "Waktu", render: (row) => formatAdminTimestamp(row.createdAt) },
          ]}
        />
      </section>
    </div>
  );
}
