import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { validateSignUpInput } from "@/lib/auth/sign-up";

// Sign-up uses the project's existing Supabase Auth — no new auth system.
// Deliberately no producer_id/role/membership input is accepted here:
// Producer authorization stays derived server-side from producer_memberships.
export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await request.json();
    if (parsed && typeof parsed === "object") {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = {};
  }

  const input = {
    name: typeof body.name === "string" ? body.name.trim() : "",
    email: typeof body.email === "string" ? body.email.trim() : "",
    password: typeof body.password === "string" ? body.password : "",
    passwordConfirmation: typeof body.passwordConfirmation === "string" ? body.passwordConfirmation : "",
  };

  const validationError = validateSignUpInput(input);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        data: { display_name: input.name },
        emailRedirectTo: `${new URL(request.url).origin}/auth`,
      },
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // Session may or may not exist depending on the project's email
    // confirmation setting — both outcomes are valid sign-up results.
    return NextResponse.json({
      created: true,
      authenticated: Boolean(data.session),
      needsEmailConfirmation: !data.session,
    }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "signup_unavailable" },
      { status: 503 },
    );
  }
}
