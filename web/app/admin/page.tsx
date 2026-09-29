import { AdminBackToAdminCenter, AdminErrorState, AdminPageHeader, AdminStatCards } from "@/components/admin/ui";
import { getAdminOverview, type AdminOverview } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";

export const dynamic = "force-dynamic";

/**
 * Admin Overview (Authority Master §5: operational monitoring). Totals come
 * straight from canonical Supabase — no cache, no search index — and nothing
 * else: counts only, no row reads. Failures render an explicit error state,
 * never fabricated data. Data is fetched inside try/catch; JSX renders
 * outside of it.
 *
 * Deliberately NOT here (PO, 2026-09-28): Live has no summary cards here — a
 * Live session only means something in the Place it happens in, so the Place
 * workspace shows that Place's sessions and reports and /admin/live keeps the
 * read-only report queue. Kunjungan has no stat or table here either — the
 * data belongs to /admin/visit-intents, and copying it here only made the
 * Overview slower for no operational gain. What remains is the five platform
 * counts the Overview exists for.
 */
export default async function AdminOverviewPage() {
  let overview: AdminOverview;
  try {
    overview = await getAdminOverview();
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) {
      throw error; // layout guard handles auth state (redirect/403)
    }
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Overview" description="Ringkasan operasional platform." />
        <AdminErrorState message="Data overview tidak dapat dimuat. Tidak ada data yang ditampilkan agar tidak menyesatkan." />
      </div>
    );
  }

  const { totals } = overview;

  return (
    <div className="space-y-8">
      <AdminBackToAdminCenter />
      <AdminPageHeader
        title="Overview"
        description="Ringkasan operasional platform dari data canonical Supabase. Angka dihitung langsung dari database saat halaman dimuat."
      />

      <AdminStatCards
        stats={[
          { label: "Data Pengguna", value: totals.users },
          { label: "Pengelola", value: totals.producers },
          { label: "Memberships", value: totals.producerMemberships },
          { label: "Data Place", value: totals.places },
          { label: "Kegiatan", value: totals.experiences },
        ]}
      />

      <p className="text-sm text-black/55">
        Rincian data ada di tab masing-masing: Data Pengguna, Data Pengelola, Data Place, Data Live, dan Live Moderation.
      </p>
    </div>
  );
}
