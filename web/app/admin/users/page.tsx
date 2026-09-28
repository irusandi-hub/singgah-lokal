import {
  AdminBackToAdminCenter,
  AdminErrorState,
  AdminPageHeader,
} from "@/components/admin/ui";
import { listAdminDirectoryUsers } from "@/lib/admin/user-directory";
import AdminUsersTable from "./AdminUsersTable";

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
  let users: Awaited<ReturnType<typeof listAdminDirectoryUsers>>;
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
      <AdminBackToAdminCenter />
      <AdminPageHeader
        title="Users"
        description="Akun terdaftar di platform. Email hanya ditampilkan pada halaman ini (manajemen user Admin) dan tidak pernah tampil untuk Producer, user lain, atau publik."
      />
      <AdminUsersTable users={users} />
    </div>
  );
}
