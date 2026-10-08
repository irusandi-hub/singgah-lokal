export type UsernameValidationError =
  | "username_required"
  | "username_invalid"
  | "username_taken";

export const MIN_USERNAME_LENGTH = 3;
export const MAX_USERNAME_LENGTH = 30;

const usernamePattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;

export function validateUsername(value: string | null | undefined): UsernameValidationError | null {
  if (!value || !value.trim()) return "username_required";
  const trimmed = value.trim();
  if (trimmed.length < MIN_USERNAME_LENGTH || trimmed.length > MAX_USERNAME_LENGTH) {
    return "username_invalid";
  }
  if (!usernamePattern.test(trimmed)) return "username_invalid";
  return null;
}

export function canonicalUsername(value: string): string {
  return value.trim();
}
