import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client — DEVELOPER/Creator surface only.
 *
 * Authority Master §3: infrastructure credentials never reach the client or
 * any non-Creator tier. This module is imported exclusively by server code
 * behind the Creator authorization guard (lib/auth/creator.ts); the service
 * key stays in the server runtime environment and is never serialized to the
 * client bundle or API responses.
 */
export function createSupabaseServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("Supabase service configuration is missing");
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
