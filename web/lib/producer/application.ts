import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * PRODUCER APPLICATION — identity locked to the authenticated account.
 *
 * One SINGGAH LOKAL account = one Producer identity (Authority Master).
 * Applications are always filed by the signed-in session: the server takes
 * user.id and the user's own email from Supabase Auth — never from client
 * input. Email is a display/audit snapshot only; user_id is the single
 * source of identity and the sole key used for approval. No Producer
 * password/email/credential is ever created anywhere in this flow.
 */

export type ProducerApplicationStatus = {
  status: "pending" | "approved" | "rejected" | "none";
  createdAt?: string;
  reviewedAt?: string;
};

export class ProducerApplicationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function mapDbError(error: { message?: string } | null): never {
  const message = error?.message ?? "";
  if (message.includes("application_already_active")) {
    throw new ProducerApplicationError("application_already_active");
  }
  throw new ProducerApplicationError("service_unavailable");
}

/** File an application for this exact account (session-derived identity). */
export async function fileProducerApplication(
  userId: string,
  contactEmail: string,
  note: string | null,
): Promise<void> {
  const supabase = createSupabaseServiceClient();
  const { error } = await supabase.rpc("submit_producer_application", {
    p_user_id: userId,
    p_contact_email: contactEmail,
    p_note: note,
  });
  if (error) mapDbError(error);
}

/** Read this account's own application status (never another account's). */
export async function getProducerApplicationStatus(
  userId: string,
): Promise<ProducerApplicationStatus> {
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("producer_applications")
    .select("status, created_at, reviewed_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{
      status: "pending" | "approved" | "rejected";
      created_at: string;
      reviewed_at: string | null;
    }>();
  if (error) mapDbError(error);
  if (!data) return { status: "none" };
  return {
    status: data.status,
    createdAt: data.created_at,
    reviewedAt: data.reviewed_at ?? undefined,
  };
}

/**
 * Approve an application: activates producer_memberships for the APPLICANT's
 * user_id. No auth user, email, or password is created — the same account
 * simply gains Producer access server-side. Admin surface only (guarded by
 * requirePlatformModerator in the API layer).
 */
export async function approveProducerApplication(
  applicationId: string,
  producerId: string,
  placeId: string,
  role: "owner" | "manager",
): Promise<void> {
  const supabase = createSupabaseServiceClient();
  const { error } = await supabase.rpc("approve_producer_application", {
    p_application_id: applicationId,
    p_producer_id: producerId,
    p_place_id: placeId,
    p_role: role,
  });
  if (error) mapDbError(error);
}

export type PendingApplication = {
  id: string;
  userId: string;
  status: string;
  contactEmail: string | null;
  createdAt: string;
};

/** Pending applications for the Admin Center moderation view. */
export async function listPendingProducerApplications(): Promise<PendingApplication[]> {
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("producer_applications")
    .select("id, user_id, status, contact_email, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) mapDbError(error);
  return (data ?? []).map((row) => ({
    id: row.id,
    userId: row.user_id,
    status: row.status,
    contactEmail: row.contact_email,
    createdAt: row.created_at,
  }));
}
