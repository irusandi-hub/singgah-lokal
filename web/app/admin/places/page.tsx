import Link from "next/link";
import {
  AdminBackToAdminCenter,
  AdminErrorState,
  AdminPageHeader,
} from "@/components/admin/ui";
import { listAdminPlaces, type AdminPlaceRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";
import PlaceClaimsManager from "./PlaceClaimsManager";
import PlaceGeoFilter from "./PlaceGeoFilter";
import AdminPlacesTable from "./AdminPlacesTable";

export const dynamic = "force-dynamic";

/**
 * ADMIN PLACE WORKSPACE — the list (Authority Master §5: Platform Admin has
 * operational authority over Place).
 *
 * This page stays the index: every Place, its publication state, its claim
 * state, and its owner (or the absence of one). "+ Tambah Tempat" opens the
 * create form, and each row opens the Place workspace where Admin can edit the
 * Place and moderate its publication.
 *
 * The Place Claim review panel is mounted HERE rather than in a new Admin
 * section: this page already carries the Place/claim view, and Admin approval
 * is the only path that grants ownership through a claim. Claim review never
 * creates a Place — it only grants ownership on an existing one.
 *
 * PO, 2026-09-28: the Place rows carry the owner's account email (resolved
 * server-side in lib/admin/queries, Admin context only), and the list is
 * ordered country → region → place name — so the one search box can narrow by
 * owner email or Place name without a reload.
 */
export default async function AdminPlacesPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; region?: string }>;
}) {
  const { country, region } = await searchParams;
  let places: AdminPlaceRow[];
  try {
    places = await listAdminPlaces({ countryCode: country ?? null, regionName: region ?? null });
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminBackToAdminCenter />
        <AdminPageHeader title="Data Place" description="Seluruh Place di platform." />
        <AdminErrorState message="Data Place tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AdminBackToAdminCenter />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <AdminPageHeader
          title="Data Place"
          description="Seluruh Place di platform beserta status publikasi, klaim, dan pemiliknya. Admin dapat membuat Place tanpa Pengelola; kepemilikan kemudian lewat klaim."
        />
        <Link
          href="/admin/places/new"
          className="rounded-full bg-brand-primary px-4 py-2.5 text-xs font-bold text-white transition hover:bg-brand-primary-deep"
        >
          + Tambah Tempat
        </Link>
      </div>

      <PlaceClaimsManager />

      <PlaceGeoFilter />

      <AdminPlacesTable places={places} />
    </div>
  );
}
