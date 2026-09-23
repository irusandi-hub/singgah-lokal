import {
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { listAdminMemberships, type AdminMembershipRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";

export const dynamic = "force-dynamic";

/**
 * Admin Producer Membership (read-only MVP). Membership is the Producer
 * authorization source (user_id, place_id, role) — shown as canonical data.
 */
export default async function AdminProducerMembershipPage() {
  let memberships: AdminMembershipRow[];
  try {
    memberships = await listAdminMemberships();
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Producer Membership" description="Kewenangan Producer per Place." />
        <AdminErrorState message="Data Producer Membership tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Producer Membership"
        description="Kewenangan Producer per Place (user, producer, place, role). Read-only untuk MVP."
      />
      <AdminDataTable
        rows={memberships}
        emptyMessage="Belum ada Producer Membership."
        columns={[
          { key: "user", header: "User ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.userId)}</span> },
          { key: "producer", header: "Producer", render: (row) => <span className="font-mono text-xs">{formatShortId(row.producerId)}</span> },
          { key: "place", header: "Place", render: (row) => <span className="font-mono text-xs">{formatShortId(row.placeId)}</span> },
          {
            key: "role",
            header: "Role",
            render: (row) => (
              <AdminStatusBadge value={row.role} tone={row.role === "owner" ? "positive" : row.role === "manager" ? "warning" : "neutral"} />
            ),
          },
          { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
        ]}
      />
    </div>
  );
}
