import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import ProducerSubNav from "@/components/producer-sub-nav";
import Inbox from "./Inbox";

export const dynamic = "force-dynamic";

// Direct URL access by unauthenticated visitors is rejected server-side
// before any inbox data is fetched.
export default async function ProducerVisitIntentsPage() {
  const supabase = await createSupabaseServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    redirect("/auth?returnTo=%2Fproducer%2Fvisit-intents");
  }

  return (
    <>
      <div className="bg-brand-ink px-4 pt-5 sm:px-6">
        <div className="mx-auto max-w-4xl">
          <ProducerSubNav active="/producer/visit-intents" dark />
        </div>
      </div>
      <Inbox />
    </>
  );
}
