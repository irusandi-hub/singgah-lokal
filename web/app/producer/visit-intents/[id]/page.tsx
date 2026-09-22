import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import ProducerSubNav from "@/components/producer-sub-nav";
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
  return (
    <>
      <div className="bg-[#20231f] px-4 pt-5 sm:px-6">
        <div className="mx-auto max-w-4xl">
          <ProducerSubNav active="/producer/visit-intents" dark />
        </div>
      </div>
      <VisitIntentDetail id={id} />
    </>
  );
}
