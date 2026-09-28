import Link from "next/link";
import {
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { listAdminPlaces, type AdminPlaceRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";
import PlaceClaimsManager from "./PlaceClaimsManager";

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
 */
export default async function AdminPlacesPage() {
  let places: AdminPlaceRow[];
  try {
    places = await listAdminPlaces();
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Tempat" description="Seluruh Tempat di platform." />
        <AdminErrorState message="Data Tempat tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <AdminPageHeader
          title="Tempat"
          description="Seluruh Tempat di platform beserta status publikasi, klaim, dan pemiliknya. Admin dapat membuat Tempat tanpa Pengelola; kepemilikan kemudian lewat klaim."
        />
        <Link
          href="/admin/places/new"
          className="rounded-full bg-brand-primary px-4 py-2.5 text-xs font-bold text-white transition hover:bg-brand-primary-deep"
        >
          + Tambah Tempat
        </Link>
      </div>

      <PlaceClaimsManager />

      <AdminDataTable
        rows={places}
        emptyMessage="Belum ada Tempat."
        columns={[
          { key: "id", header: "Tempat ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
          { key: "name", header: "Nama", render: (row) => <span className="font-bold">{row.name}</span> },
          { key: "area", header: "Area", render: (row) => `${row.area} · ${row.category} · ${row.type}` },
          {
            key: "publication",
            header: "Publikasi",
            render: (row) => (
              <AdminStatusBadge
                value={row.publicationStatus}
                tone={row.publicationStatus === "published" ? "positive" : row.publicationStatus === "archived" ? "negative" : "warning"}
              />
            ),
          },
          {
            key: "claim",
            header: "Claim",
            render: (row) => (
              <AdminStatusBadge
                value={row.claimStatus}
                tone={row.claimStatus === "verified" ? "positive" : row.claimStatus === "claimed" ? "warning" : "neutral"}
              />
            ),
          },
          { key: "producer", header: "Pengelola", render: (row) => (row.producerId ? <span className="font-mono text-xs">{formatShortId(row.producerId)}</span> : <span className="text-black/40">—</span>) },
          { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
          {
            key: "manage",
            header: "",
            render: (row) => (
              <Link
                href={`/admin/places/${row.id}`}
                className="rounded-full border border-black/10 px-3 py-1.5 text-xs font-bold text-black/60 transition hover:bg-black/5"
              >
                Kelola
              </Link>
            ),
          },
        ]}
      />
    </div>
  );
}
