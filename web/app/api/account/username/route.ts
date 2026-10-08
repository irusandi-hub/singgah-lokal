import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { canonicalUsername, validateUsername } from "@/lib/username";

export async function POST(request: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: authError } = await supabase.auth.getUser();
    if (authError || !userData?.user) {
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const value = canonicalUsername(
      typeof body.username === "string" ? body.username : "",
    );
    const validationError = validateUsername(value);
    if (validationError) {
      return NextResponse.json({ error: validationError }, { status: 400 });
    }

    const { data, error } = await supabase
      .from("users")
      .update({ username: value })
      .eq("id", userData.user.id)
      .select("username")
      .single();

    if (error) {
      if (String(error.code) === "23505" || String(error.message).includes("duplicate")) {
        return NextResponse.json({ error: "username_taken" }, { status: 409 });
      }
      return NextResponse.json({ error: "username_update_unavailable" }, { status: 503 });
    }

    return NextResponse.json({ username: data?.username ?? value });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "username_update_unavailable" }, { status: 500 });
  }
}
