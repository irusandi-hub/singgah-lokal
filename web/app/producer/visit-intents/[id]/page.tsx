import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import VisitIntentDetail from "./VisitIntentDetail";

export const dynamic = "force-dynamic";

// Direct URL access by unauthenticated visitors is rejected server-side;
// per-record authorization stays in the API/service layer.
export default async function ProducerVisitIntentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect("/auth?returnTo=%2Fproducer%2Fvisit-intents");
  }

  const { id } = await params;
  return <VisitIntentDetail id={id} />;
}
