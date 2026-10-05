import { Suspense } from "react";
import AuthForm from "./auth-form";

/**
 * Masuk route — SERVER page wrapper.
 *
 * The interactive form lives in ./auth-form (client component). This wrapper
 * only owns the route-level rendering policy: `force-dynamic` guarantees Next
 * renders this route on every request instead of serving a stale static/ISR
 * document, which is what left production /auth showing an earlier UI after a
 * deploy. No cache-busting params, service worker, or CDN hacks are involved.
 */
export const dynamic = "force-dynamic";

export default function AuthPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-screen items-center justify-center bg-brand-cream text-brand-ink">
          <p className="text-sm font-semibold text-black/60">Memuat…</p>
        </main>
      }
    >
      <AuthForm />
    </Suspense>
  );
}
