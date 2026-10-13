import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import Inbox from "./Inbox";

export const dynamic = "force-dynamic";

// Direct URL access by unauthenticated visitors is rejected server-side
// before any inbox data is fetched. The Inbox shares the Producer cream/light
// window theme (PO, 2026-09-26) — no dark wrapper.
//
// DENY-BY-DEFAULT (task Tahap 2C/3): the Producing inbox is a Pengelola
// surface, so it requires an owner/manager `producer_memberships` row for the
// SIGNED-IN account. A delegated Operator Live account — and any account
// without owner/manager authority — is redirected to the Account & Access
// Center instead of being shown a Pengelola page. This mirrors the API
// (`/api/producer/visit-intents` already answers producer_authorization_required
// and returns no data), so nothing usable is denied by the page gate; only the
// exposed Pengelola shell is removed.
export default async function ProducerVisitIntentsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect("/auth?returnTo=%2Fproducer%2Fvisit-intents");
  }

  const { data: memberships } = await supabase
    .from("producer_memberships")
    .select("place_id")
    .eq("user_id", userData.user.id)
    .in("role", ["owner", "manager"])
    .limit(1);

  if (!memberships?.length) {
    redirect("/account");
  }

  return <Inbox />;
}
