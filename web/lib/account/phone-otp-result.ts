/**
 * PHONE OTP RESULT CODES — one closed vocabulary shared by the two OTP routes,
 * the Indonesian message table, and the tests.
 *
 * The SECURITY DEFINER RPC (`public.record_phone_otp_verification`) answers with
 * a small text vocabulary; `mapOtpRpcResult` is the ONLY place that translates it
 * so an unexpected answer can never be mistaken for success (fail closed to
 * `phone_otp_unavailable`).
 */

export type PhoneOtpResultCode =
  | "phone_otp_sent"
  | "phone_otp_verified"
  | "phone_otp_invalid"
  | "phone_otp_expired"
  | "phone_otp_too_many_attempts"
  | "phone_otp_rate_limited"
  | "phone_otp_provider_not_configured"
  | "phone_otp_unavailable"
  | "authentication_required";

const RPC_RESULT_CODES: readonly PhoneOtpResultCode[] = [
  "phone_otp_invalid",
  "phone_otp_expired",
  "phone_otp_too_many_attempts",
  "authentication_required",
];

export function mapOtpRpcResult(raw: unknown): PhoneOtpResultCode {
  if (raw === "ok") return "phone_otp_verified";
  if (typeof raw === "string" && (RPC_RESULT_CODES as readonly string[]).includes(raw)) {
    return raw as PhoneOtpResultCode;
  }
  return "phone_otp_unavailable";
}

export function phoneOtpHttpStatus(code: PhoneOtpResultCode): number {
  switch (code) {
    case "authentication_required":
      return 401;
    case "phone_otp_invalid":
    case "phone_otp_expired":
      return 400;
    case "phone_otp_too_many_attempts":
    case "phone_otp_rate_limited":
      return 429;
    case "phone_otp_provider_not_configured":
    case "phone_otp_unavailable":
      return 503;
    default:
      return 200;
  }
}

export function isPhoneOtpSuccess(code: PhoneOtpResultCode): boolean {
  return code === "phone_otp_sent" || code === "phone_otp_verified";
}
