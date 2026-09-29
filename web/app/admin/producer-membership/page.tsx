import {
  AdminBackToAdminCenter,
  AdminErrorState,
  AdminPageHeader,
} from "@/components/admin/ui";
import { listAdminProducerPlaces, listAdminPlaces, type AdminProducerPlaceRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";
import ProducerApplicationsManager from "./applications-manager";
import AdminPengelolaTable from "./AdminPengelolaTable";

export const dynamic = "force-dynamic";

/**
 * Data Pengelola (PO, 2026-09-29) — the Pengelola ↔ Place relation list.
 *
 * The standalone /admin/producers page is retired: the Pengelola entity, its
 * data, and the Producer flow are untouched — every relation between a
 * Pengelola and the Places they own or manage is read here through
 * producer_memberships joined to producers and places, so this page alone is
 * the single home for Pengelola information.
 *
 * Columns: Nama Pengelola, Email, Nama Place, Negara, Provinsi/Wilayah,
 * Kategori, Status akses (membership role), Tanggal dibuat. Default order:
 * country → region → place name.
 */
export default async function AdminProducerMembershipPage() {
  let relations: AdminProducerPlaceRow[];
  let places: { id: string; name: string; producerId: string | null }[];
  try {
    [relations, places] = await Promise.all([listAdminProducerPlaces(), listAdminPlaces()]);
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminBackToAdminCenter />
        <AdminPageHeader title="Data Pengelola" description="Relasi Pengelola ↔ Place." />
        <AdminErrorState message="Data Pengelola tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AdminBackToAdminCenter />
      <AdminPageHeader
        title="Data Pengelola"
        description="Relasi Pengelola ↔ Place: siapa mengelola Place apa, beserta negara, provinsi/wilayah, kategori, status akses, dan tanggal dibuat. Pengelola tanpa Place tetap tampil sebagai pengajuan di panel di bawah."
      />

      {/* Approval flow: pengajuan terikat user_id pengaju; approval mengaktifkan
          membership untuk akun yang sama (tanpa auth user/credential baru). */}
      <ProducerApplicationsManager places={places} />
      <AdminPengelolaTable relations={relations} />
    </div>
  );
}
