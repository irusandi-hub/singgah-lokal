import {
  AdminBackToAdminCenter,
  AdminErrorState,
  AdminPageHeader,
} from "@/components/admin/ui";
import { listAdminMemberships, listAdminPlaces, type AdminMembershipRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";
import ProducerApplicationsManager from "./applications-manager";
import AdminMembershipTable from "./AdminMembershipTable";

export const dynamic = "force-dynamic";

/**
 * Admin Producer Membership (read-only MVP). Membership is the Producer
 * authorization source (user_id, place_id, role) — shown as canonical data.
 *
 * PO, 2026-09-28: the membership rows carry the account email and the Place
 * name (resolved server-side in lib/admin/queries, Admin context only), so
 * the one search box can narrow by email or Place name without a reload.
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
        <AdminBackToAdminCenter />
        <AdminPageHeader title="Pengelola Membership" description="Kewenangan Pengelola per Tempat." />
        <AdminErrorState message="Data Pengelola Membership tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AdminBackToAdminCenter />
      <AdminPageHeader
        title="Pengelola Membership"
        description="Kewenangan Pengelola per Tempat (email Pengelola, Tempat, role)."
      />

      {/* Approval flow: pengajuan terikat user_id pengaju; approval mengaktifkan
          membership untuk akun yang sama (tanpa auth user/credential baru). */}
      <ProducerApplicationsManager places={places} />
      <AdminMembershipTable memberships={memberships} />
    </div>
  );
}
