// Pure validation for the sign-up form (no framework imports) so it can be
// unit-tested and reused by both the client form and the API route.
export type SignUpValidationErrorCode =
  | "fields_required"
  | "email_invalid"
  | "password_mismatch"
  | "password_too_short";

// Stricter than the Supabase default minimum (6) — safe against any project
// configuration between 6 and 8.
export const MIN_SIGN_UP_PASSWORD_LENGTH = 8;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SignUpInput = {
  name: string;
  email: string;
  password: string;
  passwordConfirmation: string;
};

export function validateSignUpInput(input: SignUpInput): SignUpValidationErrorCode | null {
  if (!input.name.trim() || !input.email.trim() || !input.password || !input.passwordConfirmation) {
    return "fields_required";
  }
  if (!emailPattern.test(input.email.trim())) {
    return "email_invalid";
  }
  if (input.password !== input.passwordConfirmation) {
    return "password_mismatch";
  }
  if (input.password.length < MIN_SIGN_UP_PASSWORD_LENGTH) {
    return "password_too_short";
  }
  return null;
}
