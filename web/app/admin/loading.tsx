/**
 * Admin loading state (PO, 2026-09-28).
 *
 * Shown while any /admin route's server component is streaming. Every Admin
 * read is `force-dynamic` against Supabase, so a tab switch always has a
 * network round trip; without this file the previous page just sat there
 * frozen and a slow read read as a hang. The skeleton mirrors the two shapes
 * every Admin page is built from — a header line, a row of cards, and a data
 * block — using the same neutral surfaces, no animation beyond the platform's
 * default pulse and no new dependency.
 */
export default function AdminLoading() {
  return (
    <div className="space-y-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Memuat…</span>

      <header className="border-b border-black/10 pb-5">
        <div className="h-7 w-44 animate-pulse rounded-lg bg-black/[0.07]" />
        <div className="mt-3 h-4 w-full max-w-md animate-pulse rounded-lg bg-black/[0.05]" />
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-hidden>
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="rounded-2xl border border-black/10 bg-white p-4">
            <div className="h-8 w-14 animate-pulse rounded-lg bg-black/[0.07]" />
            <div className="mt-2 h-3 w-20 animate-pulse rounded bg-black/[0.05]" />
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-black/10 bg-white" aria-hidden>
        <div className="border-b border-black/5 px-4 py-3">
          <div className="h-3 w-40 animate-pulse rounded bg-black/[0.05]" />
        </div>
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="border-b border-black/5 px-4 py-4 last:border-b-0">
            <div className="h-4 w-2/3 animate-pulse rounded bg-black/[0.06]" />
            <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-black/[0.04]" />
          </div>
        ))}
      </div>
    </div>
  );
}
