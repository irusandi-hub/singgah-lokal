import {
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { listAdminEligibility, listAdminLiveSessions, type AdminEligibilityRow, type AdminLiveSessionRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";

export const dynamic = "force-dynamic";

/**
 * Admin Live (Authority Master §5 + Policy §5.1: moderation authority =
 * Platform Admin). Sessions and eligibility are canonical Supabase reads.
 * Moderation actions remain in the existing RPC-gated API surface — this page
 * observes and links out; it never mutates Live state.
 */
export default async function AdminLivePage() {
  let sessions: AdminLiveSessionRow[];
  let eligibility: AdminEligibilityRow[];
  try {
    [sessions, eligibility] = await Promise.all([listAdminLiveSessions(), listAdminEligibility()]);
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Live" description="Live Session dan eligibility Producer." />
        <AdminErrorState message="Data Live tidak dapat dimuat." />
      </div>
    );
  }

  const activeCount = sessions.filter((session) => session.status === "live").length;

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Live"
        description="Live Session dan eligibility Producer. Batas terkunci: global 5 aktif, 1 per Place, 100 penonton, 60 menit."
      />

      <section aria-label="Ringkasan Live" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-2xl border border-black/10 bg-white p-4">
          <div className="text-2xl font-semibold tabular-nums">{activeCount}/5</div>
          <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Live aktif</div>
        </div>
        <div className="rounded-2xl border border-black/10 bg-white p-4">
          <div className="text-2xl font-semibold tabular-nums">{sessions.length}</div>
          <div className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-black/45">Total sesi (100 terakhir)</div>
        </div>
      </section>

      <section aria-label="Live Sessions" className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Live Sessions</h3>
        <AdminDataTable
          rows={sessions}
          emptyMessage="Belum ada Live Session."
          columns={[
            { key: "id", header: "ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
            { key: "place", header: "Place", render: (row) => <span className="font-mono text-xs">{formatShortId(row.placeId)}</span> },
            { key: "producer", header: "Producer", render: (row) => <span className="font-mono text-xs">{formatShortId(row.producerId)}</span> },
            { key: "stage", header: "Proses (stage)", render: (row) => <span className="font-mono text-xs">{formatShortId(row.stageId)}</span> },
            {
              key: "status",
              header: "Status",
              render: (row) => (
                <AdminStatusBadge
                  value={row.status}
                  tone={row.status === "live" ? "live" : row.endedReason === "moderation" ? "negative" : "neutral"}
                />
              ),
            },
            { key: "peak", header: "Puncak", render: (row) => row.viewerPeak },
            { key: "started", header: "Mulai", render: (row) => formatAdminTimestamp(row.startedAt) },
            {
              key: "ended",
              header: "Selesai",
              render: (row) =>
                row.endedAt ? (
                  <span>
                    {formatAdminTimestamp(row.endedAt)}
                    {row.endedReason ? <span className="block text-[11px] text-black/45">{row.endedReason}</span> : null}
                  </span>
                ) : (
                  <span className="text-black/40">—</span>
                ),
            },
          ]}
        />
      </section>

      <section aria-label="Live Eligibility" className="space-y-3">
        <h3 className="text-sm font-bold uppercase tracking-[0.14em] text-black/45">Eligibility Producer</h3>
        <p className="text-sm text-black/55">
          Pemberian dan pencabutan eligibility tetap melalui jalur audited yang sudah ada (RPC{' '}
          <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs">grant_live_eligibility</code> /{' '}
          <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs">revoke_live_eligibility</code>).
        </p>
        <AdminDataTable<AdminEligibilityRow>
          rows={eligibility}
          emptyMessage="Belum ada eligibility yang diberikan."
          columns={[
            { key: "producer", header: "Producer", render: (row) => <span className="font-mono text-xs">{formatShortId(row.producerId)}</span> },
            { key: "path", header: "Path", render: (row) => <AdminStatusBadge value={row.path} tone={row.path === "ADMIN_APPROVED" ? "positive" : "neutral"} /> },
            { key: "active", header: "Aktif", render: (row) => (row.active ? <AdminStatusBadge value="aktif" tone="positive" /> : <AdminStatusBadge value="nonaktif" tone="negative" />) },
            { key: "granted", header: "Diberikan", render: (row) => formatAdminTimestamp(row.grantedAt) },
          ]}
        />
      </section>
    </div>
  );
}
