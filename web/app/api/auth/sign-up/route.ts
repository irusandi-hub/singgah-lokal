import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { validateSignUpInput } from "@/lib/auth/sign-up";
import { LEGAL_DOCUMENT_IDS } from "@/lib/legal/documents";

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
        // A-01: the confirmation link must land on the ONLY handler that
        // exchanges the code for a session (/auth/callback — the same handler
        // OAuth uses), not on /auth, which never reads `code`. `next` is
        // re-sanitized inside the callback, so this cannot become an open
        // redirect: a tampered value collapses to an internal path.
        emailRedirectTo: `${new URL(request.url).origin}/auth/callback?next=/auth`,
      },
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    // Dokumen hukum berversi (migration 0059): pendaftaran mensyaratkan
    // persetujuan Ketentuan Penggunaan, dan persetujuannya dicatat atas akun
    // yang BARU dibuat Supabase (id dari respons signUp, bukan dari klien).
    // Versinya ditentukan server, bukan klien. Kegagalan mencatat persetujuan
    // TIDAK membatalkan akun yang sudah dibuat: kartu persetujuan di /account
    // akan meminta ulang, sehingga tidak pernah ada akun tanpa jalur persetujuan.
    if (body.acceptedTerms === true && data.user?.id) {
      try {
        // Lazy import: the acceptance module is server-only and is only needed
        // on this sign-up path (keeps the route module loadable in the test
        // harness, the same reason lib/place-experience-repository.ts lazily
        // imports the service client).
        const { acceptCurrentLegalDocument } = await import("@/lib/legal/acceptance");
        await acceptCurrentLegalDocument({
          userId: data.user.id,
          documentId: LEGAL_DOCUMENT_IDS.ketentuanPenggunaan,
        });
      } catch (acceptError) {
        console.error("[api/auth/sign-up] legal acceptance not recorded:", acceptError);
      }
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
