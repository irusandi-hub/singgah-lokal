import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { verifyPhoneOtp } from "@/lib/account/phone-otp-service";
import { phoneOtpHttpStatus } from "@/lib/account/phone-otp-result";
import { phoneOtpMessage } from "@/lib/account/profile-messages";
import { OTP_CODE_LENGTH } from "@/lib/account/phone-otp";

/**
 * POST /api/account/phone/otp/verify — confirm a phone verification code.
 *
 * The code is hashed SERVER-SIDE and handed to
 * `public.record_phone_otp_verification`, which is the ONLY path that may set
 * `phone_verified_at`: it re-derives the actor from auth.uid(), locks the
 * caller's OWN challenge, and enforces expiry, the attempt bound, and single
 * use. The client can neither set `phone_verified_at` directly nor verify a
 * challenge that is not its own; a foreign/unknown challenge id answers exactly
 * like a wrong code (no enumeration).
 */

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

    const body = (await request.json().catch(() => ({}))) as {
      challengeId?: unknown;
      code?: unknown;
    };

    const challengeId =
      typeof body.challengeId === "string" && UUID_PATTERN.test(body.challengeId.trim())
        ? body.challengeId.trim()
        : "";
    const code = typeof body.code === "string" ? body.code.trim() : "";

    if (!challengeId || code.length !== OTP_CODE_LENGTH || !/^[0-9]+$/.test(code)) {
      return NextResponse.json(
        { error: "phone_otp_invalid", message: phoneOtpMessage("phone_otp_invalid") },
        { status: 400 },
      );
    }

    const status = await verifyPhoneOtp({ challengeId, code });

    return NextResponse.json(
      {
        status,
        message: phoneOtpMessage(status),
        phoneVerified: status === "phone_otp_verified",
      },
      { status: phoneOtpHttpStatus(status) },
    );
  } catch {
    return NextResponse.json(
      { error: "phone_otp_unavailable", message: phoneOtpMessage("phone_otp_unavailable") },
      { status: 503 },
    );
  }
}
