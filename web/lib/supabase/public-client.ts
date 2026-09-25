import { createServerClient } from "@supabase/ssr";

/**
 * Shared, sessionless public (anon) Supabase client for server code.
 *
 * Server-only by convention (matching lib/supabase/server.ts — no
 * "server-only" import guard, which would break plain-Node unit tests).
 *
 * Unlike `createSupabaseServerClient()` this never reads or writes request
 * cookies (`next/headers`), so using it does NOT make a route handler dynamic
 * and Next.js ISR route caching (`export const revalidate`) genuinely applies.
 *
 * Purpose: public discovery reads whose results are identical for every
 * visitor — published Places, published Production Stages, live sessions of
 * published Places. RLS stays the single authorization boundary: the anon key
 * only sees what the `*_public_read` policies expose, so nothing private or
 * auth-scoped can ever flow through this client.
 */
let publicClient: ReturnType<typeof createServerClient> | undefined;

export function getPublicSupabaseClient(): ReturnType<typeof createServerClient> {
  if (!publicClient) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !anonKey) {
      throw new Error("Supabase configuration is missing");
    }

    publicClient = createServerClient(url, anonKey, {
      cookies: {
        getAll() {
          return [];
        },
        setAll() {
          // Sessionless by design: no cookies are stored or refreshed here.
        },
      },
    });
  }

  return publicClient;
}

export type PublicSupabaseClient = ReturnType<typeof getPublicSupabaseClient>;
