import {
  AdminDataTable,
  AdminErrorState,
  AdminPageHeader,
  AdminStatusBadge,
  formatAdminTimestamp,
  formatShortId,
} from "@/components/admin/ui";
import { listAdminDirectoryUsers, type AdminDirectoryUserRow } from "@/lib/admin/user-directory";

export const dynamic = "force-dynamic";

/**
 * Admin Users — user management (Authority Master §5).
 *
 * Email is PRIVATE DATA. It is shown here, and only here, because this is the
 * Admin user-management context that genuinely needs it to identify an
 * account. A Producer, another User, and the public never see it: `public.users`
 * stores no email, the public Place/Experience API never selects one, and the
 * read is re-verified server-side (`requirePlatformModerator`) inside the data
 * layer. No credential, token, or infrastructure secret is ever returned.
 */
export default async function AdminUsersPage() {
  let users: AdminDirectoryUserRow[];
  try {
    users = await listAdminDirectoryUsers();
  } catch {
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
        description="Akun terdaftar di platform. Email hanya ditampilkan pada halaman ini (manajemen user Admin) dan tidak pernah tampil untuk Producer, user lain, atau publik."
      />
      <AdminDataTable
        rows={users}
        emptyMessage="Belum ada user terdaftar."
        columns={[
          { key: "id", header: "User ID", render: (row) => <span className="font-mono text-xs">{formatShortId(row.id)}</span> },
          { key: "email", header: "Email", render: (row) => (row.email ? <span className="text-sm">{row.email}</span> : <span className="text-black/40">—</span>) },
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
