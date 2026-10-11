/**
 * AVATAR — pure validation and per-user object-path rules.
 *
 * The profile photo is stored in the PRIVATE `account-avatars` bucket created by
 * migration 0050, with NO `storage.objects` policy and no public URL: anon and
 * authenticated have no direct bucket access at all, so there is no listing and
 * no public read. The server writes with the service role after verifying the
 * session, and reads through a short-lived signed URL (see avatar-storage.ts).
 *
 * Every object lives under the OWNER's own user id, so a stored path can never
 * address another account's directory. Type and size are validated here (pure,
 * testable) and again by the bucket's own limits.
 */

export const AVATAR_BUCKET = "account-avatars";
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024; // matches the bucket limit (0050)
export const AVATAR_SIGNED_URL_TTL_SECONDS = 3600;

export const AVATAR_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type AvatarMimeType = (typeof AVATAR_ALLOWED_MIME_TYPES)[number];

export type AvatarError =
  | "avatar_user_invalid"
  | "avatar_empty"
  | "avatar_type_invalid"
  | "avatar_too_large";

export function isAvatarMimeType(value: unknown): value is AvatarMimeType {
  return (
    typeof value === "string" &&
    (AVATAR_ALLOWED_MIME_TYPES as readonly string[]).includes(value)
  );
}

const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateAvatarUpload(input: {
  type?: unknown;
  size?: unknown;
}): AvatarError | null {
  if (typeof input.size !== "number" || !Number.isFinite(input.size) || input.size <= 0) {
    return "avatar_empty";
  }
  if (!isAvatarMimeType(input.type)) return "avatar_type_invalid";
  if (input.size > AVATAR_MAX_BYTES) return "avatar_too_large";
  return null;
}

export function avatarExtensionFor(mimeType: AvatarMimeType): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

/**
 * `avatars/<user id>/<random>.<ext>` — the exact shape the `avatar_path_format`
 * CHECK in migration 0050 accepts, so a stored reference can never diverge from
 * the object layout or escape the owner's directory.
 */
export function avatarObjectPath(
  userId: string,
  mimeType: AvatarMimeType,
  suffix: string,
): string {
  if (!USER_ID_PATTERN.test(userId)) throw new Error("avatar_user_invalid");
  if (!/^[0-9a-f]{24}$/.test(suffix)) throw new Error("avatar_user_invalid");
  return `avatars/${userId.toLowerCase()}/${suffix}.${avatarExtensionFor(mimeType)}`;
}

export const AVATAR_OBJECT_PATH_PATTERN =
  /^avatars\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{24}\.(jpg|png|webp)$/;
