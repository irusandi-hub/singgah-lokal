import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/admin";
import { getAgeVerificationProvider } from "./provider";
import {
  ageVerificationStatusFor,
  requestAgeVerification,
  verifyAgeVerificationCallback,
  type AgeVerificationCallbackResult,
  type AgeVerificationStartResult,
} from "./core";

/**
 * Server-side age-verification wrapper (migration 0055 foundation).
 *
 * This is the production path: it resolves the provider from the registry (null
 * until a vendor is approved and registered), performs the provider calls through
 * the pure core, and is the ONLY code that writes verification rows — through the
 * service-role connection and the service_role-only RPCs. No client can reach
 * these writes, and a test double is never resolvable here (the registry in
 * ./provider.ts is the only source of providers).
 *
 * With no provider configured every entry point returns
 * `provider_not_configured` and writes nothing — never a "verified" row.
 *
 * NOTE (deliberate): nothing in this module, and nothing in migration 0055, is
 * called by `assert_viewer_eligible` / `admit_live_viewer`. The Live gate stays
 * DENY-all until a provider is chosen, implemented, tested, and approved; the
 * one-change integration seam is documented in docs/HANDOFF_LIVE_MVP.md.
 */

export async function startAgeVerification(params: {
  userId: string;
}): Promise<AgeVerificationStartResult> {
  const decision = await requestAgeVerification(getAgeVerificationProvider(), {
    userId: params.userId,
  });

  if (decision.status !== "started") {
    // Fail closed: no provider, no record, no half-started state.
    return decision;
  }

  const admin = createSupabaseServiceClient();
  const { error } = await admin.rpc("apply_age_verification_result", {
    p_event_id: null,
    p_user_id: params.userId,
    p_status: "pending",
    p_provider_ref: decision.providerRef,
    p_minimum_age_confirmed: false,
    p_verified_at: null,
    p_expires_at: null,
  });

  if (error) {
    // The start could not be recorded: report it instead of pretending the
    // verification began (a later callback would then be an unknown reference).
    return { status: "provider_unavailable" };
  }

  return decision;
}

export async function processAgeVerificationCallback(params: {
  rawBody: string;
  headers: Record<string, string>;
}): Promise<AgeVerificationCallbackResult> {
  const provider = getAgeVerificationProvider();
  const decision = await verifyAgeVerificationCallback(provider, {
    rawBody: params.rawBody,
    headers: params.headers,
  });

  if (decision.status !== "authentic") {
    return decision;
  }

  const admin = createSupabaseServiceClient();
  const callback = decision.callback;

  // Anti-replay FIRST: an event id is applied at most once (0055 ledger). A
  // replayed event is acknowledged and nothing changes.
  const claimed = await admin.rpc("record_age_verification_event", {
    p_event_id: callback.eventId,
    p_provider: provider?.id ?? "unknown",
    p_event_type: callback.eventType,
  });

  if (claimed.error) {
    return { status: "store_unavailable" };
  }
  if (claimed.data !== true) {
    return { status: "event_replay" };
  }

  // Resolve the account through the opaque reference only. An unknown reference
  // is never created implicitly.
  const { data: rows, error: lookupError } = await admin
    .from("age_verifications")
    .select("user_id")
    .eq("provider_ref", callback.providerRef)
    .limit(1);

  if (lookupError) {
    return { status: "store_unavailable" };
  }
  const userId = (rows as Array<{ user_id: string }> | null)?.[0]?.user_id;
  if (!userId) {
    return { status: "unknown_reference" };
  }

  const verificationStatus = ageVerificationStatusFor(callback);
  const applied = await admin.rpc("apply_age_verification_result", {
    p_event_id: callback.eventId,
    p_user_id: userId,
    p_status: verificationStatus,
    p_provider_ref: callback.providerRef,
    p_minimum_age_confirmed: verificationStatus === "verified",
    p_verified_at: verificationStatus === "verified" ? callback.verifiedAt : null,
    p_expires_at: callback.expiresAt,
  });

  if (applied.error) {
    return { status: "store_unavailable" };
  }

  return { status: "applied", verificationStatus };
}
