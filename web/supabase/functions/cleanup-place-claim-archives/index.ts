// Supabase Edge Function — cleanup-place-claim-archives (v2)
//
// Implements the LOCKED cleanup order of MASTER_DATA_RETENTION_ARCHIVE_POLICY
// v1.0 §7 / §16.5 against the `place_claim_archives` table of migration 0034:
//
//   1. Storage deletion FIRST — every expired archive row's evidence object
//      is deleted through the proper Storage object API (no internal metadata
//      manipulation).
//   2. Storage deletion FAILED -> the DB archive row MUST NOT be finalized as
//      deleted; the row stays re-processable by the next run (retry).
//   3. Storage deletion SUCCEEDED -> the DB archive row is finalized
//      (`finalized_at = now()`).
//
// Authentication/authorization (MASTER §16.5):
// - The scheduler (pg_cron "place-claim-archive-cleanup", daily 00:00 UTC) and
//   any manual operator invoke MUST present the service-role key
//   (`SERVICE_ROLE_KEY` secret). Anonymous calls are rejected with 401 and
//   carry no information about the archive.
// - The service role stays server-side only: this function never returns
//   evidence bytes, paths, or archive contents — only per-row cleanup
//   outcomes and aggregate counts.
//
// Idempotency (MASTER §16.5): every run re-reads the ACTUAL state. A finalized
// row is skipped, a row whose storage object is already gone is finalized, a
// failed storage deletion keeps the row for the next scheduled attempt. A run
// can therefore be submitted any number of times safely.
//
// Outcomes per row: removed / retry_scheduled (storage deletion failed) /
// noop_no_object (finalize; nothing was deletable). Already-finalized rows
// are never selected. The aggregate response:
// { ranAt, expired, removed, retryScheduled }.

const ARCHIVE_RETENTION_DAYS = 30; // MASTER §2 — LOCKED, exactly 30 days.

interface ArchiveRow {
  id: string;
  evidence_path: string;
}

interface CleanupResult {
  removed: number;
  retryScheduled: number;
}

function jsonHeaders(): Record<string, string> {
  return { "Content-Type": "application/json" };
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized" }),
    { status: 401, headers: jsonHeaders() },
  );
}

function serverError(message: string): Response {
  return new Response(
    JSON.stringify({ error: "cleanup_failed", detail: message }),
    { status: 503, headers: jsonHeaders() },
  );
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Fail closed on authorization BEFORE touching anything (MASTER §5 posture):
  // the caller must present the service-role key in the Authorization header
  // (Bearer) or the x-service-role-key header — the scheduler's secret, never
  // a client credential.
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SERVICE_ROLE_KEY) return serverError("service key unavailable");

  const presented =
    (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim() ||
    (req.headers.get("x-service-role-key") ?? "").trim();
  if (!presented || presented !== SERVICE_ROLE_KEY) return unauthorized();

  const createClient = (await import("npm:@supabase/supabase-js@2")).createClient;
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );

  // 1. Collect EXPIRED, not-yet-finalized archive rows (§2: exactly 30 days).
  const horizon = new Date(Date.now() - ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: expiredRows, error: expiredError } = await supabase
    .from("place_claim_archives")
    .select("id, evidence_path")
    .is("finalized_at", null)
    .lte("archived_at", horizon)
    .limit(1000);
  if (expiredError) return serverError("archive_read_failed");
  const rows = (expiredRows ?? []) as ArchiveRow[];

  const result: CleanupResult = { removed: 0, retryScheduled: 0 };

  for (const row of rows) {
    if (!row.evidence_path) {
      // noop_no_object: nothing was ever deletable; finalize directly (§7.3).
      const { error } = await supabase
        .from("place_claim_archives")
        .update({ finalized_at: new Date().toISOString() })
        .eq("id", row.id)
        .is("finalized_at", null); // idempotent guard: only the first writer wins
      if (error) {
        result.retryScheduled += 1; // DB finalization failed: leave for retry
        continue;
      }
      result.removed += 1;
      continue;
    }

    // 2. STORAGE FIRST (§7.1) — through the proper Storage object API.
    let storageDeleted = false;
    try {
      const { error } = await supabase.storage
        .from("place-claim-evidence")
        .remove([row.evidence_path]);
      // An object that is already gone counts as deleted (idempotent re-run);
      // anything else is a failure for this attempt.
      storageDeleted = !error;
    } catch {
      storageDeleted = false;
    }

    if (!storageDeleted) {
      // 3. Storage deletion FAILED -> DB row stays, re-processable (§7.2).
      result.retryScheduled += 1;
      continue;
    }

    // 4. Storage deletion SUCCEEDED -> finalize the DB archive row (§7.3).
    const { error } = await supabase
      .from("place_claim_archives")
      .update({ finalized_at: new Date().toISOString() })
      .eq("id", row.id)
      .is("finalized_at", null); // idempotent guard
    if (error) {
      // The object is gone; the row will be finalized by the next run (its
      // evidence_path no longer resolves, so the retry path treats it as
      // noop_no_object via the storage check above).
      result.retryScheduled += 1;
      continue;
    }
    result.removed += 1;
  }

  return new Response(
    JSON.stringify({
      ranAt: new Date().toISOString(),
      expired: rows.length,
      removed: result.removed,
      retryScheduled: result.retryScheduled,
    }),
    { status: 200, headers: jsonHeaders() },
  );
});
