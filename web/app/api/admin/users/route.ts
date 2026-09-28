import { NextResponse } from "next/server";
import { AdminDirectoryError, listAdminDirectoryUsers } from "@/lib/admin/user-directory";

export const dynamic = "force-dynamic";

/**
 * Admin user directory (Platform Admin user management).
 *
 * This response CONTAINS private data — the account email. It is served only
 * to a Platform Admin, verified server-side on every request, and it is the
 * only user-facing email surface in the app. The public Place API, the
 * Producer API, and the public pages never read an email, and there is no
 * Producer/User equivalent of this route.
 */
export async function GET() {
  try {
    return NextResponse.json({ users: await listAdminDirectoryUsers() });
  } catch (error) {
    if (error instanceof AdminDirectoryError) {
      return NextResponse.json({ error: "Daftaran user tidak dapat dimuat." }, { status: 503 });
    }
    // Authorization failures surface as 403 without revealing whether the
    // account or the role exists.
    return NextResponse.json({ error: "Akses admin diperlukan." }, { status: 403 });
  }
}
