import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  createAvatarSignedUrl,
  removeAccountAvatar,
  uploadAccountAvatar,
} from "@/lib/account/avatar-storage";
import { validateAvatarUpload } from "@/lib/account/avatar";
import { avatarMessage } from "@/lib/account/profile-messages";

/**
 * POST /api/account/profile/avatar — set the caller's OWN profile photo.
 *
 * The avatar lives in the PRIVATE `account-avatars` bucket (migration 0050):
 * there is no public URL and no listing, and clients get no direct bucket
 * access. This route verifies the session, validates the MIME type and size,
 * uploads with the service role under the CALLER's own user id, and stores the
 * resulting object path in the caller's own `avatar_path` column (the only
 * column GRANT the client-owned update path has for this field). The returned
 * URL is a short-lived signed URL, never a public one.
 */

export const dynamic = "force-dynamic";

function isUploadedFile(value: unknown): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "size" in value &&
    "type" in value
  );
}

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json(
        { error: "authentication_required", message: "Silakan masuk terlebih dahulu." },
        { status: 401 },
      );
    }

    const formData = await request.formData().catch(() => null);
    const file = formData?.get("file");
    if (!isUploadedFile(file)) {
      return NextResponse.json(
        { error: "avatar_empty", message: avatarMessage("avatar_empty") },
        { status: 400 },
      );
    }

    const validationError = validateAvatarUpload({ type: file.type, size: file.size });
    if (validationError) {
      return NextResponse.json(
        { error: validationError, message: avatarMessage(validationError) },
        { status: 400 },
      );
    }

    const upload = await uploadAccountAvatar({ userId: userData.user.id, file });
    if (!upload.ok) {
      const storageFailure =
        upload.error === "avatar_storage_missing" || upload.error === "avatar_upload_failed";
      return NextResponse.json(
        { error: upload.error, message: avatarMessage(upload.error) },
        { status: storageFailure ? 503 : 400 },
      );
    }

    const { data: previous } = await supabase
      .from("users")
      .select("avatar_path")
      .eq("id", userData.user.id)
      .maybeSingle<{ avatar_path: string | null }>();

    const { error } = await supabase
      .from("users")
      .update({ avatar_path: upload.storagePath })
      .eq("id", userData.user.id);

    if (error) {
      // The reference could not be stored: remove the just-uploaded object so no
      // unreachable object is left behind, and fail closed.
      await removeAccountAvatar(upload.storagePath);
      return NextResponse.json(
        { error: "avatar_upload_failed", message: avatarMessage("avatar_upload_failed") },
        { status: 503 },
      );
    }

    const previousPath = previous?.avatar_path ?? null;
    if (previousPath && previousPath !== upload.storagePath) {
      await removeAccountAvatar(previousPath);
    }

    return NextResponse.json({
      avatarPath: upload.storagePath,
      avatarUrl: await createAvatarSignedUrl(upload.storagePath),
    });
  } catch {
    return NextResponse.json(
      { error: "avatar_upload_failed", message: avatarMessage("avatar_upload_failed") },
      { status: 503 },
    );
  }
}
