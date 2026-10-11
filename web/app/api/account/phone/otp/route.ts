import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { maskPhoneE164, normalizePhoneE164 } from "@/lib/account/phone";
import { requestPhoneOtp } from "@/lib/account/phone-otp-service";
import { phoneOtpHttpStatus } from "@/lib/account/phone-otp-result";
import { profileErrorMessage, phoneOtpMessage } from "@/lib/account/profile-messages";

/**
 * POST /api/account/phone/otp — request a phone verification code.
 *
 * The number is normalized to E.164 SERVER-SIDE first. BOTH rate limits are
 * enforced in the service (per account and per number). The response shape is
 * identical whether or not the number is already verified on another account, so
 * the endpoint can never be used to enumerate accounts (see the privacy note in
 * lib/account/phone-otp-service.ts). The number is returned MASKED only.
 *
 * With no OTP provider configured the flow fails closed
 * (`phone_otp_provider_not_configured`, 503) and no challenge is created — this
 * is the documented manual blocker, not a code path that invents a provider.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json(
        {
          error: "authentication_required",
          message: phoneOtpMessage("authentication_required"),
        },
        { status: 401 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { phone?: unknown };
    const normalized = normalizePhoneE164(body.phone);
    if (!normalized.ok) {
      return NextResponse.json(
        { error: normalized.error, message: profileErrorMessage(normalized.error) },
        { status: 400 },
      );
    }

    const outcome = await requestPhoneOtp({
      userId: userData.user.id,
      phoneE164: normalized.value,
    });

    return NextResponse.json(
      {
        status: outcome.status,
        message: phoneOtpMessage(outcome.status),
        // Only the MASK is echoed — never the full number.
        phoneMasked: maskPhoneE164(normalized.value),
        challengeId: outcome.challengeId,
      },
      { status: phoneOtpHttpStatus(outcome.status) },
    );
  } catch {
    return NextResponse.json(
      { error: "phone_otp_unavailable", message: phoneOtpMessage("phone_otp_unavailable") },
      { status: 503 },
    );
  }
}
