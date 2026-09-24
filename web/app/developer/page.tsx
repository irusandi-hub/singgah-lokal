import { requireCreator } from "@/lib/auth/creator";
import AccountSecurityManager from "./account-security-manager";
import DeveloperPlatformAdmins from "./platform-admins-manager";

export const dynamic = "force-dynamic";

/**
 * Developer Center overview (Authority Master §2): the Creator's in-app
 * surface. It exposes the Creator powers that are safe to operate in-app —
 * Platform Admin lifecycle and the Creator account security settings
 * (email, password, secret question, all re-verified server-side).
 * Everything infrastructural (GitHub, Vercel, Supabase project settings,
 * DNS, secrets, deployment) stays in Creator-controlled consoles by design.
 */
export default async function DeveloperPage() {
  const creator = await requireCreator();

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-brand-ink/10 bg-white p-6 shadow-[0_1px_2px_rgba(32,35,31,0.06)]">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-brand-accent">
          Creator / Owner / Developer
        </p>
        <h2 className="mt-2 font-brand text-2xl font-semibold text-brand-ink">Kewenangan tertinggi program</h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-brand-ink/60">
          Developer Center adalah lapisan Creator — terpisah dari Admin Center (operasional), Producer Dashboard,
          dan area user. Verifikasi kewenangan berjalan server-side di setiap permintaan.
        </p>
      </section>

      <DeveloperPlatformAdmins creatorEmail={creator.email} />

      <AccountSecurityManager />
    </div>
  );
}
