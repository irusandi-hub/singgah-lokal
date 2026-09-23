import {
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { listAdminUsers, type AdminUserRow } from "@/lib/admin/queries";
import { PlatformModeratorRequiredError } from "@/lib/live/platform";

export const dynamic = "force-dynamic";

/**
 * Admin Users (MVP, read-only). Only canonical public.users fields are shown:
 * id, created_at, platform_role. No email (public.users holds none by design
 * and auth.users is never read here), no credentials of any kind.
 */
export default async function AdminUsersPage() {
  let users: AdminUserRow[];
  try {
    users = await listAdminUsers();
  } catch (error) {
    if (error instanceof PlatformModeratorRequiredError) throw error;
    return (
      <div className="space-y-8">
        <AdminPageHeader title="Users" description="Akun terdaftar di platform." />
        <AdminErrorState message="Data Users tidak dapat dimuat." />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <AdminPageHeader
        title="Users"
        description="Akun terdaftar di platform. Read-only untuk MVP: id, waktu dibuat, dan platform_role bila ada. Email dan kredensial tidak ditampilkan."
      />
      <AdminDataTable
        rows={users}
        emptyMessage="Belum ada user terdaftar."
        columns={[
          { key: "id", header: "User ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
          { key: "created", header: "Dibuat", render: (row) => formatAdminTimestamp(row.createdAt) },
          {
            key: "role",
            header: "Platform Role",
            render: (row) =>
              row.platformRole ? <AdminStatusBadge value={row.platformRole} tone="live" /> : <span className="text-black/40">—</span>,
          },
        ]}
      />
    </div>
  );
}
