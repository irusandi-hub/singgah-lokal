import { createSupabaseServiceClient } from "@/lib/supabase/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  generateOtpCode,
  hashOtpCode,
  isOtpRequestRateLimited,
  otpExpiresAt,
  resolveOtpHashSecret,
  OTP_MAX_REQUESTS_PER_PHONE,
  OTP_MAX_REQUESTS_PER_USER,
  OTP_REQUEST_WINDOW_SECONDS,
  OTP_TTL_SECONDS,
} from "@/lib/account/phone-otp";
import { getPhoneOtpProvider } from "@/lib/account/phone-otp-provider";
import { mapOtpRpcResult, type PhoneOtpResultCode } from "@/lib/account/phone-otp-result";

/**
 * PHONE OTP SERVICE — the server-side flow behind the two OTP endpoints.
 *
 * Order of operations (all fail closed):
 *  1. the hash secret must exist and a provider must be configured — otherwise
 *     NOTHING is created and no code is generated (503 / provider blocker);
 *  2. BOTH rate limits are checked (per account AND per number) inside the
 *     window; exceeding either answers `phone_otp_rate_limited` uniformly;
 *  3. the previous outstanding challenge of that account is consumed, then ONE
 *     new challenge is stored — hash only (`code_hash`), short expiry, bounded
 *     attempts, single use (the partial unique index allows one active row);
 *  4. delivery goes through the neutral provider seam.
 *
 * PRIVACY TRADE-OFF (deliberate, task rule: "Respons tidak membocorkan apakah
 * nomor dipakai akun lain"): when the submitted number is already VERIFIED on
 * another active account, this function still creates the caller's OWN challenge
 * and answers EXACTLY like a normal send, but it does NOT deliver an SMS — a
 * number that belongs to another verified account is never texted on this
 * account's behalf. The response is therefore shape-identical, and the lock
 * wording stays `phone_otp_sent` because a differing message (or a differing
 * response shape) would itself be the enumeration oracle. Any attempt to verify
 * that number then answers exactly like a wrong code.
 */

export type PhoneOtpRequestOutcome = {
  status: PhoneOtpResultCode;
  /** The caller's own challenge id, present whenever a challenge was created. */
  challengeId: string | null;
};

type ChallengeRow = { id: string };

async function countRecentBy(
  column: "user_id" | "phone_e164",
  value: string,
  windowSeconds: number,
): Promise<number> {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { count } = await createSupabaseServiceClient()
    .from("phone_otp_challenges")
    .select("id", { count: "exact", head: true })
    .eq(column, value)
    .gte("created_at", since);
  return count ?? 0;
}

export async function requestPhoneOtp(input: {
  userId: string;
  phoneE164: string;
}): Promise<PhoneOtpRequestOutcome> {
  const secret = resolveOtpHashSecret();
  if (!secret) return { status: "phone_otp_unavailable", challengeId: null };

  let provider;
  try {
    provider = getPhoneOtpProvider();
  } catch {
    return { status: "phone_otp_provider_not_configured", challengeId: null };
  }

  const admin = createSupabaseServiceClient();

  const [perUser, perPhone] = await Promise.all([
    countRecentBy("user_id", input.userId, OTP_REQUEST_WINDOW_SECONDS),
    countRecentBy("phone_e164", input.phoneE164, OTP_REQUEST_WINDOW_SECONDS),
  ]);
  if (
    isOtpRequestRateLimited(perUser, OTP_MAX_REQUESTS_PER_USER) ||
    isOtpRequestRateLimited(perPhone, OTP_MAX_REQUESTS_PER_PHONE)
  ) {
    return { status: "phone_otp_rate_limited", challengeId: null };
  }

  // Is the number already VERIFIED on another active account? Never disclosed.
  const { data: takenBy } = await admin
    .from("users")
    .select("id")
    .eq("phone_e164", input.phoneE164)
    .not("phone_verified_at", "is", null)
    .neq("id", input.userId)
    .limit(1);
  const takenByAnotherAccount = (takenBy ?? []).length > 0;

  const now = new Date();
  const code = generateOtpCode();
  const expiresAt = otpExpiresAt(now, OTP_TTL_SECONDS);

  // Supersede any outstanding challenge first so the one-active-challenge
  // partial unique index can never be hit by a legitimate second request.
  await admin
    .from("phone_otp_challenges")
    .update({ consumed_at: now.toISOString() })
    .eq("user_id", input.userId)
    .is("consumed_at", null);

  const { data, error } = await admin
    .from("phone_otp_challenges")
    .insert({
      user_id: input.userId,
      phone_e164: input.phoneE164,
      code_hash: hashOtpCode(code, secret),
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single<ChallengeRow>();

  if (error || !data?.id) {
    return { status: "phone_otp_unavailable", challengeId: null };
  }

  if (takenByAnotherAccount) {
    // A number that belongs to another verified account is never texted from
    // here; the caller's own challenge still exists (uniform response shape),
    // and verification will answer exactly like a wrong code.
    return { status: "phone_otp_sent", challengeId: data.id };
  }

  try {
    await provider.sendOtp({ phoneE164: input.phoneE164, code, expiresAt });
  } catch {
    // Delivery failed: invalidate the challenge (never leave a usable code
    // behind for an undelivered message) and report unavailability.
    await admin
      .from("phone_otp_challenges")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", data.id);
    return { status: "phone_otp_unavailable", challengeId: null };
  }

  return { status: "phone_otp_sent", challengeId: data.id };
}

export async function verifyPhoneOtp(input: {
  challengeId: string;
  code: string;
}): Promise<PhoneOtpResultCode> {
  const secret = resolveOtpHashSecret();
  if (!secret) return "phone_otp_unavailable";

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("record_phone_otp_verification", {
    p_challenge_id: input.challengeId,
    p_code_hash: hashOtpCode(input.code, secret),
  });

  if (error) {
    // The partial unique index is the race backstop for "one verified number
    // per account": a lost race is answered like a wrong code (no leak).
    if (String(error.code) === "23505") return "phone_otp_invalid";
    return "phone_otp_unavailable";
  }

  return mapOtpRpcResult(data);
}
