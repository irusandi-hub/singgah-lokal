import { requireCreator } from "@/lib/auth/creator";
import DeveloperPlatformAdmins from "./platform-admins-manager";

export const dynamic = "force-dynamic";

/**
 * Developer Center overview (Authority Master §2): the Creator's in-app
 * surface. Today it exposes exactly one Creator power that is safe to operate
 * in-app — Platform Admin lifecycle. Everything infrastructural (GitHub,
 * Vercel, Supabase project settings, DNS, secrets, deployment) stays in
 * Creator-controlled consoles by design.
 */
export default async function DeveloperPage() {
  const creator = await requireCreator();

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#d8ad6f]">Creator / Owner / Developer</p>
        <h2 className="mt-2 text-2xl font-black text-white">Kewenangan tertinggi program</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-white/60">
          Developer Center adalah lapisan Creator — terpisah dari Admin Center (operasional), Producer Dashboard,
          dan area user. Verifikasi kewenangan berjalan server-side di setiap permintaan.
        </p>
      </section>

      <DeveloperPlatformAdmins creatorEmail={creator.email} />
    </div>
  );
}
