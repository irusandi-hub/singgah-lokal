import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import Inbox from "./Inbox";

export const dynamic = "force-dynamic";

// Direct URL access by unauthenticated visitors is rejected server-side
// before any inbox data is fetched. The Inbox shares the Producer cream/light
// window theme (PO, 2026-09-26) — no dark wrapper.
export default async function ProducerVisitIntentsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect("/auth?returnTo=%2Fproducer%2Fvisit-intents");
  }

  return <Inbox />;
}
