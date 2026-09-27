import {
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { listAdminMemberships, listAdminPlaces, type AdminMembershipRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";
import ProducerApplicationsManager from "./applications-manager";

export const dynamic = "force-dynamic";

/**
 * Admin Producer Membership (read-only MVP). Membership is the Producer
 * authorization source (user_id, place_id, role) — shown as canonical data.
 */
export default async function AdminProducerMembershipPage() {
  let memberships: AdminMembershipRow[];
  let places: { id: string; name: string; producerId: string | null }[];
  try {
    [memberships, places] = await Promise.all([listAdminMemberships(), listAdminPlaces()]);
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Pengelola Membership" description="Kewenangan Pengelola per Tempat." />
        <AdminErrorState message="Data Pengelola Membership tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Pengelola Membership"
        description="Kewenangan Pengelola per Tempat (user, producer, place, role)."
      />

      {/* Approval flow: pengajuan terikat user_id pengaju; approval mengaktifkan
          membership untuk akun yang sama (tanpa auth user/credential baru). */}
      <ProducerApplicationsManager places={places} />
      <AdminDataTable
        rows={memberships}
        emptyMessage="Belum ada Pengelola Membership."
        columns={[
          { key: "user", header: "User ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.userId)}</span> },
          { key: "producer", header: "Pengelola", render: (row) => <span className="font-mono text-xs">{formatShortId(row.producerId)}</span> },
          { key: "place", header: "Tempat", render: (row) => <span className="font-mono text-xs">{formatShortId(row.placeId)}</span> },
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
