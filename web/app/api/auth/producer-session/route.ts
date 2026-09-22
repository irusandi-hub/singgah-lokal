import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Server-derived Producer membership probe for navigation visibility.
// Authorization itself always remains in the Producer routes/APIs — this
// endpoint only decides whether the Producer entry should be rendered, and
// exposes no membership details beyond owned Place id/name.
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData.user) {
      return NextResponse.json({ authorized: false, places: [] });
    }

    const { data: memberships, error: membershipError } = await supabase
      .from("producer_memberships")
      .select("place_id, role")
      .eq("user_id", userData.user.id)
      .in("role", ["owner", "manager"]);

    if (membershipError || !memberships?.length) {
      return NextResponse.json({ authorized: false, places: [] });
    }

    const placeIds = [...new Set(memberships.map(({ place_id }) => String(place_id)))];
    const { data: places } = await supabase
      .from("places")
      .select("id, name")
      .in("id", placeIds);

    return NextResponse.json({
      authorized: true,
      places: (places ?? []).map((place: { id: string; name: string }) => ({ id: place.id, name: place.name })),
    });
  } catch {
    // Unconfigured environment or transient failure: no Producer entry.
    return NextResponse.json({ authorized: false, places: [] });
  }
}
