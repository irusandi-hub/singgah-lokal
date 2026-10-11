import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { calculateAge } from "@/lib/account/age";
import {
  buildProfileUpdate,
  buildVerificationSummary,
  type AccountVerificationSummary,
  type ProfileUpdate,
} from "@/lib/account/profile";
import { profileErrorMessage } from "@/lib/account/profile-messages";

/**
 * /api/account/profile — the account's OWN profile.
 *
 * GET  reads the caller's own row (RLS `users_self_access`, id = auth.uid()) and
 *      returns the profile plus a verification summary built ONLY from stored
 *      facts: the email fact from Supabase Auth and the phone fact from
 *      `phone_verified_at`.
 * PATCH updates only the caller's own row, and only the self-owned columns the
 *      column GRANT allows (name, username, date of birth, phone). It has NO
 *      user-id parameter — the subject is always the session — and NO email
 *      write: the registered email is read-only here.
 *
 * `phone_verified_at` is not writable by this route at all (no column GRANT, and
 * `guard_profile_write` rejects it): a filled phone field is never a
 * verification. Changing the number clears the verification until a NEW OTP
 * confirmation succeeds.
 */

export const dynamic = "force-dynamic";

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

type ProfilePayload = {
  userId: string;
  fullName: string | null;
  username: string | null;
  email: string | null;
  emailReadOnly: true;
  dateOfBirth: string | null;
  age: number | null;
  phoneE164: string | null;
  avatarPath: string | null;
  verification: AccountVerificationSummary;
};

function profilePayload(
  userId: string,
  row: ProfileRow | null,
  email: string | null,
  emailConfirmedAt: string | null,
): ProfilePayload {
  return {
    userId,
    fullName: row?.full_name ?? null,
    username: row?.username ?? null,
    email,
    emailReadOnly: true,
    dateOfBirth: row?.date_of_birth ?? null,
    // Always derived on the server from the stored date — never stored, never
    // computed on the client.
    age: row?.date_of_birth ? calculateAge(row.date_of_birth) : null,
    phoneE164: row?.phone_e164 ?? null,
    avatarPath: row?.avatar_path ?? null,
    verification: buildVerificationSummary({
      email,
      emailConfirmedAt,
      phoneE164: row?.phone_e164 ?? null,
      phoneVerifiedAt: row?.phone_verified_at ?? null,
    }),
  };
}

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json(
        { error: "authentication_required", message: "Silakan masuk terlebih dahulu." },
        { status: 401 },
      );
    }

    const user = userData.user;
    const { data: row } = await supabase
      .from("users")
      .select(PROFILE_COLUMNS)
      .eq("id", user.id)
      .maybeSingle<ProfileRow>();

    return NextResponse.json({
      profile: profilePayload(
        user.id,
        row ?? null,
        user.email ?? null,
        user.email_confirmed_at ?? null,
      ),
    });
  } catch {
    return NextResponse.json(
      {
        error: "profile_update_unavailable",
        message: profileErrorMessage("profile_update_unavailable"),
      },
      { status: 503 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json(
        { error: "authentication_required", message: "Silakan masuk terlebih dahulu." },
        { status: 401 },
      );
    }

    const body = await request.json().catch(() => null);
    const validated = buildProfileUpdate(body);
    if (!validated.ok) {
      return NextResponse.json(
        { error: validated.error, message: profileErrorMessage(validated.error) },
        { status: validated.error === "username_taken" ? 409 : 400 },
      );
    }

    const update: ProfileUpdate = validated.update;
    const { data: row, error } = await supabase
      .from("users")
      .update(update)
      .eq("id", userData.user.id)
      .select(PROFILE_COLUMNS)
      .maybeSingle<ProfileRow>();

    if (error) {
      const message = String(error.message ?? "");
      const code = String(error.code ?? "");
      if (code === "23505" || message.includes("duplicate key")) {
        return NextResponse.json(
          { error: "username_taken", message: profileErrorMessage("username_taken") },
          { status: 409 },
        );
      }
      if (message.includes("phone_verification_not_allowed")) {
        return NextResponse.json(
          {
            error: "profile_field_read_only",
            message: profileErrorMessage("profile_field_read_only"),
          },
          { status: 400 },
        );
      }
      if (message.includes("date_of_birth_invalid")) {
        return NextResponse.json(
          {
            error: "date_of_birth_invalid",
            message: profileErrorMessage("date_of_birth_invalid"),
          },
          { status: 400 },
        );
      }
      if (message.includes("phone_e164_format")) {
        return NextResponse.json(
          { error: "phone_invalid", message: profileErrorMessage("phone_invalid") },
          { status: 400 },
        );
      }
      if (message.includes("full_name_length")) {
        return NextResponse.json(
          { error: "full_name_invalid", message: profileErrorMessage("full_name_invalid") },
          { status: 400 },
        );
      }
      return NextResponse.json(
        {
          error: "profile_update_unavailable",
          message: profileErrorMessage("profile_update_unavailable"),
        },
        { status: 503 },
      );
    }

    return NextResponse.json({
      profile: profilePayload(
        userData.user.id,
        row ?? null,
        userData.user.email ?? null,
        userData.user.email_confirmed_at ?? null,
      ),
    });
  } catch {
    return NextResponse.json(
      {
        error: "profile_update_unavailable",
        message: profileErrorMessage("profile_update_unavailable"),
      },
      { status: 503 },
    );
  }
}
