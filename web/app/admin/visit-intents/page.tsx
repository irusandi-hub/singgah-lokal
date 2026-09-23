import {
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { listAdminVisitIntents, type AdminVisitIntentRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";

export const dynamic = "force-dynamic";

/**
 * Admin Visit Intents (read-only operational oversight, Authority Master §5).
 * SINGGAH remains visit intent — this page observes, never mutates, and no
 * payment/checkout concept exists anywhere here.
 */
export default async function AdminVisitIntentsPage() {
  let intents: AdminVisitIntentRow[];
  try {
    intents = await listAdminVisitIntents();
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Visit Intents" description="Niat berkunjung di seluruh platform." />
        <AdminErrorState message="Data Visit Intents tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Visit Intents"
        description="Niat berkunjung (SINGGAH) di seluruh platform. Waktu mengikuti Place timezone. Read-only untuk MVP."
      />
      <AdminDataTable
        rows={intents}
        emptyMessage="Belum ada Visit Intent."
        columns={[
          { key: "id", header: "ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
          { key: "place", header: "Place", render: (row) => <span className="font-mono text-xs">{formatShortId(row.placeId)}</span> },
          { key: "experience", header: "Experience", render: (row) => <span className="font-mono text-xs">{formatShortId(row.experienceId)}</span> },
          { key: "slot", header: "Jadwal", render: (row) => `${row.requestedDate} ${row.requestedStartTime}–${row.requestedEndTime}` },
          {
            key: "status",
            header: "Status",
            render: (row) => (
              <AdminStatusBadge
                value={row.status}
                tone={row.status === "accepted" ? "positive" : row.status === "declined" ? "negative" : "neutral"}
              />
            ),
          },
          { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
        ]}
      />
    </div>
  );
}
