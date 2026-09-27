import {
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { listAdminExperiences, type AdminExperienceRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";

export const dynamic = "force-dynamic";

/**
 * Admin Experiences (read-only operational oversight). Canonical Supabase
 * experiences data; price/currency stay with the Place and are not shown here.
 */
export default async function AdminExperiencesPage() {
  let experiences: AdminExperienceRow[];
  try {
    experiences = await listAdminExperiences();
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Kegiatan" description="Kegiatan per Tempat." />
        <AdminErrorState message="Data Kegiatan tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Kegiatan"
        description="Kegiatan per Tempat beserta status publikasi. Read-only untuk MVP."
      />
      <AdminDataTable
        rows={experiences}
        emptyMessage="Belum ada Kegiatan."
        columns={[
          { key: "id", header: "Kegiatan ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
          { key: "title", header: "Judul", render: (row) => <span className="font-bold">{row.title}</span> },
          { key: "place", header: "Tempat", render: (row) => <span className="font-mono text-xs">{formatShortId(row.placeId)}</span> },
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
            key: "status",
            header: "Status",
            render: (row) => <AdminStatusBadge value={row.status} tone={row.status === "published" ? "positive" : "neutral"} />,
          },
          { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
        ]}
      />
    </div>
  );
}
