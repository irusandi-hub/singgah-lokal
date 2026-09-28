import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/ui";
import AdminPlaceEditor from "@/components/admin/place-editor";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";
import { listAdminPlaces } from "@/lib/admin/queries";

export const dynamic = "force-dynamic";

/**
 * Create a Place as Platform Admin, WITHOUT a Producer.
 *
 * `producer_id` is written as NULL: an Admin may enter a Place the platform
 * does not yet have a verified owner for, and the rightful owner later claims
 * it through the EXISTING claim flow (no second claim system, and this page
 * never participates in claim review). The Place is created as `draft` —
 * publishing is a separate, explicit moderation action.
 *
 * The listing read runs here so the page fails closed for a non-moderator
 * before any form is rendered; the layout guard and the API guard both apply
 * as well.
 */
export default async function AdminNewPlacePage() {
  try {
    await listAdminPlaces();
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return <AdminPageHeader title="Tambah Tempat" description="Halaman tidak dapat dimuat." />;
  }

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Tambah Tempat"
        description="Buat Tempat tanpa Pengelola. Tempat masuk sebagai Draft dan bisa diterbitkan lewat moderasi. Pemilik sah dapat mengajukan klaim atas Tempat ini nanti."
      />
      <Link href="/admin/places" className="inline-block text-xs font-bold text-black/55 hover:text-brand-accent">
        ← Kembali ke daftar Tempat
      </Link>
      <section className="rounded-2xl border border-black/10 bg-white p-5">
        <h3 className="text-sm font-bold uppercase tracking-wide text-black/50">Informasi Tempat</h3>
        <p className="mt-1 mb-4 text-xs text-black/55">
          Tempat baru selalu tanpa Pengelola. Kelolaan hanya bisa diberikan lewat klaim yang Anda setujui.
        </p>
        <AdminPlaceEditor />
      </section>
    </div>
  );
}
