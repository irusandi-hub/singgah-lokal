import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { calculateAge } from "@/lib/account/age";
import { buildVerificationSummary } from "@/lib/account/profile";
import { createAvatarSignedUrl } from "@/lib/account/avatar-storage";
import { isPhoneVerificationAvailable } from "@/lib/account/phone-otp-provider";
import type { AccountProfileView } from "@/lib/account/profile-view";

/**
 * OWN ACCOUNT PROFILE — the ONE server read behind the profile surfaces.
 *
 * The Account & Access Center's "Profil Saya" panel and the "Edit Profil" screen
 * both render the caller's OWN profile, so they must read it the same way:
 * the self-read RLS policy (`users_self_access`, id = auth.uid()) decides which
 * row is visible, and the client never names a subject.
 *
 * What is derived here and nowhere else:
 *  - the AGE, computed on the server from the stored date (`calculateAge`);
 *  - the VERIFICATION SUMMARY, built from the two stored facts only;
 *  - the avatar's SHORT-LIVED SIGNED URL (the bucket is private; there is no
 *    public URL). A missing storage configuration yields `avatarUrl = null`, so
 *    the UI falls back to initials instead of failing the page;
 *  - `phoneVerificationAvailable`, the server capability probe of the OTP
 *    provider + hash secret, so the UI never offers a certain-to-fail action.
 *
 * Returns null when there is no session. A read failure yields nulls rather
 * than throwing: a profile page with no data must render honestly, and it never
 * falls back to a cached or client-supplied value.
 */

const PROFILE_COLUMNS =
  "full_name, username, date_of_birth, phone_e164, phone_verified_at, avatar_path" as const;

type ProfileRow = {
  full_name: string | null;
  username: string | null;
  date_of_birth: string | null;
  phone_e164: string | null;
  phone_verified_at: string | null;
  avatar_path: string | null;
};

async function signedAvatarUrl(avatarPath: string | null): Promise<string | null> {
  if (!avatarPath) return null;
  try {
    return await createAvatarSignedUrl(avatarPath);
  } catch {
    // Missing storage configuration (or a bucket error) must not take the page
    // down: the avatar falls back to initials.
    return null;
  }
}

export async function readOwnProfile(): Promise<AccountProfileView | null> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData } = await supabase.auth.getUser();
    const user = userData?.user;
    if (!user) return null;

    const { data: row } = await supabase
      .from("users")
      .select(PROFILE_COLUMNS)
      .eq("id", user.id)
      .maybeSingle<ProfileRow>();

    return {
      fullName: row?.full_name ?? null,
      username: row?.username ?? null,
      email: user.email ?? null,
      dateOfBirth: row?.date_of_birth ?? null,
      age: row?.date_of_birth ? calculateAge(row.date_of_birth) : null,
      phoneE164: row?.phone_e164 ?? null,
      avatarUrl: await signedAvatarUrl(row?.avatar_path ?? null),
      verification: buildVerificationSummary({
        email: user.email ?? null,
        emailConfirmedAt: user.email_confirmed_at ?? null,
        phoneE164: row?.phone_e164 ?? null,
        phoneVerifiedAt: row?.phone_verified_at ?? null,
      }),
      phoneVerificationAvailable: isPhoneVerificationAvailable(),
    };
  } catch {
    return null;
  }
}
