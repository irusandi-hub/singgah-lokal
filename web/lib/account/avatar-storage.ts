import "server-only";

import { createSupabaseServiceClient } from "@/lib/supabase/admin";
import {
  AVATAR_BUCKET,
  AVATAR_SIGNED_URL_TTL_SECONDS,
  avatarObjectPath,
  isAvatarMimeType,
  validateAvatarUpload,
  type AvatarError,
} from "@/lib/account/avatar";

/**
 * ACCOUNT AVATAR STORAGE — Supabase Storage access for the private
 * `account-avatars` bucket (migration 0050).
 *
 * Only server code reaches this bucket, with the service-role client, AFTER the
 * API layer verified the session. The client never receives bucket credentials,
 * direct write access, a public URL, or a listing: reads go through a short-lived
 * signed URL created here. Type and size are validated before any upload, and
 * the object always lives under the owner's own user id.
 *
 * If the bucket is missing the upload fails closed with `avatar_storage_missing`
 * (the API answers 503) — it is never silently skipped or written elsewhere.
 */

function randomSuffix(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type AvatarUploadResult =
  | { ok: true; storagePath: string }
  | { ok: false; error: AvatarError | "avatar_storage_missing" | "avatar_upload_failed" };

export async function uploadAccountAvatar(params: {
  userId: string;
  file: File;
}): Promise<AvatarUploadResult> {
  const validationError = validateAvatarUpload({
    type: params.file.type,
    size: params.file.size,
  });
  if (validationError) return { ok: false, error: validationError };
  if (!isAvatarMimeType(params.file.type)) return { ok: false, error: "avatar_type_invalid" };

  let storagePath: string;
  try {
    storagePath = avatarObjectPath(params.userId, params.file.type, randomSuffix());
  } catch {
    return { ok: false, error: "avatar_user_invalid" };
  }

  const { error } = await createSupabaseServiceClient()
    .storage.from(AVATAR_BUCKET)
    .upload(storagePath, params.file, {
      contentType: params.file.type,
      cacheControl: "31536000",
      upsert: false,
    });

  if (error) {
    if (error.message === "Bucket not found") {
      return { ok: false, error: "avatar_storage_missing" };
    }
    return { ok: false, error: "avatar_upload_failed" };
  }

  return { ok: true, storagePath };
}

/** Short-lived signed URL for the OWNER's own avatar (never a public URL). */
export async function createAvatarSignedUrl(storagePath: string): Promise<string | null> {
  const { data, error } = await createSupabaseServiceClient()
    .storage.from(AVATAR_BUCKET)
    .createSignedUrl(storagePath, AVATAR_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** Best-effort removal of a replaced avatar object (server-side only). */
export async function removeAccountAvatar(storagePath: string): Promise<void> {
  await createSupabaseServiceClient().storage.from(AVATAR_BUCKET).remove([storagePath]);
}
