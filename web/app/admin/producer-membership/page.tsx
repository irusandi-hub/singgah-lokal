import {
  AdminBackToAdminCenter,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
} from "@/components/admin/ui";
import {
  listAdminManagerlessPlaces,
  listAdminProducerPlaces,
  listAdminPlaces,
  type AdminManagerlessPlaceRow,
  type AdminProducerPlaceRow,
} from "@/lib/admin/queries";
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
 *
 * KEBIJAKAN PENGELOLAAN DIGITAL (migration 0058) — Location A of the
 * revocation workflow: every relation row carries the "Cabut Hak Akses" action,
 * the revocation requires a reason, and it never requires a replacement
 * manager. Because a revoked relation simply disappears from this table, the
 * managerless Places it can produce are listed explicitly below it, so the
 * resulting state is visible instead of silent.
 */
export default async function AdminProducerMembershipPage() {
  let relations: AdminProducerPlaceRow[];
  let places: { id: string; name: string; producerId: string | null }[];
  let managerless: AdminManagerlessPlaceRow[] = [];
  try {
    [relations, places, managerless] = await Promise.all([
      listAdminProducerPlaces(),
      listAdminPlaces(),
      listAdminManagerlessPlaces(),
    ]);
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

      <p className="rounded-2xl border border-black/10 bg-white p-4 text-xs leading-5 text-black/60">
        Peran Pengelola di Singgah Lokal adalah <strong>kewenangan pengelolaan digital</strong>, bukan
        pengakuan kepemilikan hukum atas Tempat. Admin dapat mencabut kewenangan itu kapan pun sesuai
        kebijakan platform dan Ketentuan Penggunaan, tanpa wajib menunjuk pengelola pengganti. Tempat
        yang tidak lagi punya Pengelola aktif tetap tersimpan bersama data dan riwayatnya.
      </p>

      {/* Approval flow: pengajuan terikat user_id pengaju; approval mengaktifkan
          membership untuk akun yang sama (tanpa auth user/credential baru). */}
      <ProducerApplicationsManager places={places} />
      <AdminPengelolaTable relations={relations} />

      <section aria-label="Tempat tanpa Pengelola digital aktif" className="rounded-2xl border border-black/10 bg-white p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-black/50">
          Tempat tanpa Pengelola digital aktif
        </h3>
        <p className="mt-1 mb-3 text-xs leading-5 text-black/55">
          Tempat berikut tidak memiliki membership pengelola (keadaan sah). Tidak ada pengelola
          pengganti yang wajib ditunjuk; kewenangan berikutnya hanya lewat proses resmi persetujuan
          klaim Tempat.
        </p>
        {managerless.length === 0 ? (
          <p className="text-sm text-black/60">Semua Tempat memiliki Pengelola digital aktif.</p>
        ) : (
          <ul className="divide-y divide-black/5" data-testid="managerless-place-list">
            {managerless.map((place) => (
              <li key={place.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-xs text-black/70">
                <span className="font-semibold text-black/80">{place.name}</span>
                <span className="font-mono text-black/45">{place.id}</span>
                <span className="text-black/50">
                  {[place.countryCode, place.regionName].filter(Boolean).join(" · ") || "—"}
                </span>
                <AdminStatusBadge
                  value={place.publicationStatus}
                  tone={place.publicationStatus === "archived" ? "negative" : place.publicationStatus === "published" ? "positive" : "warning"}
                />
                {place.producerId ? (
                  <span className="text-black/50">penanda Produser lama: {place.producerId}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
