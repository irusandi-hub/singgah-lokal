import { NextResponse } from "next/server";
import { CreatorRequiredError } from "@/lib/auth/creator";
import { DeveloperActionError, grantPlatformAdmin, listPlatformAdmins, revokePlatformAdmin } from "@/lib/developer/platform-admins";

export const dynamic = "force-dynamic";

/**
 * Developer Center API — Platform Admin management.
 *
 * Authorization: every handler re-verifies Creator status server-side (fail
 * closed). Errors are mapped to stable codes; the service-role key and any
 * infrastructure credential never appear in requests, responses, or logs.
 */

const errorStatuses: Record<string, number> = {
  email_invalid: 400,
  creator_account: 409,
  account_not_found: 404,
  service_not_configured: 503,
  lookup_failed: 502,
  list_failed: 502,
  grant_failed: 502,
  revoke_failed: 502,
};

function errorResponse(code: string, fallbackStatus = 500) {
  return NextResponse.json({ error: code }, { status: errorStatuses[code] ?? fallbackStatus });
}

export async function GET() {
  try {
    const admins = await listPlatformAdmins();
    return NextResponse.json({ admins });
  } catch (error) {
    if (error instanceof CreatorRequiredError) {
      return NextResponse.json({ error: "creator_required" }, { status: 403 });
    }
    if (error instanceof DeveloperActionError) return errorResponse(error.code);
    console.error("[developer/platform-admins] unexpected list error", error);
    return errorResponse("list_failed");
  }
}

export async function POST(request: Request) {
  let email: unknown;
  try {
    const body = (await request.json()) as { email?: unknown };
    email = body.email;
  } catch {
    return errorResponse("email_invalid", 400);
  }

  if (typeof email !== "string" || !email.trim()) {
    return errorResponse("email_invalid", 400);
  }

  try {
    const admin = await grantPlatformAdmin(email);
    return NextResponse.json({ admin });
  } catch (error) {
    if (error instanceof CreatorRequiredError) {
      return NextResponse.json({ error: "creator_required" }, { status: 403 });
    }
    if (error instanceof DeveloperActionError) return errorResponse(error.code);
    console.error("[developer/platform-admins] unexpected grant error", error);
    return errorResponse("grant_failed");
  }
}

export async function DELETE(request: Request) {
  let email: unknown;
  try {
    const body = (await request.json()) as { email?: unknown };
    email = body.email;
  } catch {
    return errorResponse("email_invalid", 400);
  }

  if (typeof email !== "string" || !email.trim()) {
    return errorResponse("email_invalid", 400);
  }

  try {
    await revokePlatformAdmin(email);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof CreatorRequiredError) {
      return NextResponse.json({ error: "creator_required" }, { status: 403 });
    }
    if (error instanceof DeveloperActionError) return errorResponse(error.code);
    console.error("[developer/platform-admins] unexpected revoke error", error);
    return errorResponse("revoke_failed");
  }
}
