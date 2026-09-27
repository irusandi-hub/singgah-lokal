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
 * Admin Places (read-only operational oversight, Authority Master §5).
 * Canonical Supabase places data — no cache/search index.
 *
 * The Place Claim review panel is mounted HERE rather than in a new Admin
 * section: this page already carries the Place/claim view, and Admin approval
 * is the only path that grants ownership through a claim.
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
      <AdminPageHeader
        title="Tempat"
        description="Seluruh Tempat di platform beserta status publikasi dan klaim. Read-only untuk MVP."
      />
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
        ]}
      />
    </div>
  );
}
