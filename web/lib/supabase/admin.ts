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
/**
 * Thrown when the server runtime is missing the service-role configuration.
 * Carries only the NAMES of the missing environment variables — never their
 * values — so callers can log and classify the failure precisely.
 */
export class ServiceConfigError extends Error {
  readonly missingVars: string[];

  constructor(missingVars: string[]) {
    super(`Supabase service configuration is missing: ${missingVars.join(", ")}`);
    this.missingVars = missingVars;
  }
}

export function createSupabaseServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new ServiceConfigError([
      ...(url ? [] : ["NEXT_PUBLIC_SUPABASE_URL"]),
      ...(serviceRoleKey ? [] : ["SUPABASE_SERVICE_ROLE_KEY"]),
    ]);
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
