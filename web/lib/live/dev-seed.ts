import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * B2 dev-seed eligibility (policy §12.2 #5): seeding grants via service-role
 * tooling is allowed in DEVELOPMENT/TEST environments only — NEVER production.
 *
 * Production safety: the seed refuses to run whenever the environment
 * identifies as production (NODE_ENV=production or VERCEL_ENV=production).
 * There is no bypass flag by design — production grants occur only through
 * the Platform Admin/Moderator route (`/api/admin/live/eligibility`).
 */

export class DevSeedProhibitedError extends Error {
  constructor() {
    super("live_dev_seed_prohibited_in_production");
  }
}

export function isProductionEnvironment(env: {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
} = process.env as { NODE_ENV?: string; VERCEL_ENV?: string }): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

export async function devSeedLiveEligibility(params: {
  producerId: string;
  path: "RATING" | "CURATED" | "EXCLUSIVE" | "HISTORY" | "ADMIN_APPROVED";
}): Promise<void> {
  if (isProductionEnvironment()) {
    throw new DevSeedProhibitedError();
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("grant_live_eligibility", {
    p_producer_id: params.producerId,
    p_path: params.path,
    p_rating_threshold: null,
    p_min_rating_count: null,
  });

  if (error) {
    throw new Error("live_dev_seed_failed");
  }
}
