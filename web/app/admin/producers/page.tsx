import {
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { listAdminProducers, type AdminProducerRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";

export const dynamic = "force-dynamic";

/**
 * Admin Producers (read-only MVP). No new Producer workflow is invented —
 * claim_status is displayed as canonical data only.
 */
export default async function AdminProducersPage() {
  let producers: AdminProducerRow[];
  try {
    producers = await listAdminProducers();
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Producers" description="Producer terdaftar beserta status klaim." />
        <AdminErrorState message="Data Producers tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Producers"
        description="Producer terdaftar beserta status klaim. Read-only: belum ada workflow mutasi yang ditetapkan Master."
      />
      <AdminDataTable
        rows={producers}
        emptyMessage="Belum ada Producer terdaftar."
        columns={[
          { key: "id", header: "Producer ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
          { key: "name", header: "Nama", render: (row) => <span className="font-bold">{row.displayName}</span> },
          {
            key: "claim",
            header: "Claim Status",
            render: (row) => (
              <AdminStatusBadge
                value={row.claimStatus}
                tone={row.claimStatus === "verified" ? "positive" : row.claimStatus === "claimed" ? "warning" : "neutral"}
              />
            ),
          },
          { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
        ]}
      />
    </div>
  );
}
