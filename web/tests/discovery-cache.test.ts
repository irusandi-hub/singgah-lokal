import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * PUBLIC DISCOVERY CACHING (PO, 2026-09-25)
 *
 * Root cause of slow Home refresh: /api/places and /api/live/discovery both
 * called createSupabaseServerClient(), which reads next/headers cookies().
 * A route handler that touches cookies() is DYNAMIC in Next.js — the
 * previously added `export const revalidate` was a silent no-op.
 *
 * The locked architecture:
 * - Both public discovery routes use the shared sessionless public (anon)
 *   client (lib/supabase/public-client.ts) — no cookies(), no user identity.
 * - RLS remains the only authorization boundary (published-only policies);
 *   the response is identical for every visitor, so ISR route caching
 *   (revalidate 30 s / 10 s) genuinely applies.
 * - Home keeps force-dynamic for auth/account correctness, and the 15 s Live
 *   poll only runs while the LIVE tab is active.
 * - Leaflet stacking fix 511835a and the removed in-map Place bottom sheet
 *   stay locked (map-stacking.test.ts covers the ladder; this file locks the
 *   bottom-sheet removal).
 */

const placesRoute = readFileSync(new URL("../app/api/places/route.ts", import.meta.url), "utf8");
const liveDiscoveryRoute = readFileSync(new URL("../app/api/live/discovery/route.ts", import.meta.url), "utf8");
const publicClient = readFileSync(new URL("../lib/supabase/public-client.ts", import.meta.url), "utf8");
const placeRepository = readFileSync(new URL("../lib/place-experience-repository.ts", import.meta.url), "utf8");
const storyRepository = readFileSync(new URL("../lib/production-story-repository.ts", import.meta.url), "utf8");
const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    // Multi-line block comments first (JSDoc/docstrings), then line comments.
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

// --- Sessionless public client -------------------------------------------------

test("The public Supabase client is sessionless and never touches cookies()", () => {
  const code = stripComments(publicClient);
  // No "server-only" import guard (it would break plain-Node unit tests, same
  // convention as lib/supabase/server.ts) and no next/headers import — the
  // whole point of the split.
  assert.equal(code.includes('import "server-only"'), false, "must stay unit-testable like lib/supabase/server.ts");
  assert.equal(code.includes("next/headers"), false, "public client must not import next/headers");
  assert.match(code, /getAll\(\)\s*\{\s*return \[\];\s*\}/, "cookie reads always return empty");
  assert.match(code, /setAll\(\)\s*\{\s*\}/, "cookie writes are ignored");
  // Single shared instance — one anon client per server process.
  assert.match(code, /let publicClient/);
});

// --- /api/places ---------------------------------------------------------------

test("/api/places uses the sessionless public client and real ISR caching", () => {
  const code = stripComments(placesRoute);
  assert.match(code, /export const revalidate = 30;/);
  assert.match(code, /getPublicPlaceExperienceRepository/);
  // Regression: the cookie-reading server client must never come back here.
  assert.equal(code.includes("createSupabaseServerClient"), false, "/api/places must not read cookies()");
  assert.equal(code.includes("getServerPlaceExperienceRepository"), false, "session-backed repository must not be used for public discovery");
});

test("The public Place repository is backed by the public client and stays published-only", () => {
  const code = stripComments(placeRepository);
  assert.match(code, /export async function getPublicPlaceExperienceRepository/);
  assert.match(code, /getPublicSupabaseClient\(\)/);
  // Canonical publication filter unchanged.
  assert.match(code, /\.eq\("publication_status", "published"\)/);
});

// --- /api/live/discovery -------------------------------------------------------

test("/api/live/discovery is sessionless and cached without privileged writes", () => {
  const code = stripComments(liveDiscoveryRoute);
  assert.match(code, /export const revalidate = 10;/);
  assert.match(code, /getPublicSupabaseClient\(\)/);
  assert.equal(code.includes("createSupabaseServerClient"), false, "/api/live/discovery must not read cookies()");
  // No privileged heal RPC from a cached public route; the cap is applied by
  // filtering past-cap sessions in the handler.
  assert.equal(code.includes("applyLiveDurationCap"), false, "cached public route must not perform privileged DB writes");
  assert.match(code, /isPastLiveDurationCap/);
  // Fail-closed visibility: only sessions whose Place is published are listed.
  assert.match(code, /getPublicPlaceExperienceRepository/);
  assert.match(code, /getPublicProductionStoryRepository/);
  assert.match(code, /getPublishedPlaceById\(row\.place_id\)/);
  // Fail-closed visibility, in its parallel form (PERF pass 2026-10-08): the
  // sequential `continue` skip became an explicit null entry that is filtered
  // out, so a session whose Place is unpublished is still never listed, while
  // the two reads per session now resolve concurrently instead of one row at a
  // time. Amended here because the requested change is exactly that switch; the
  // guarantee it locked is unchanged and still asserted.
  assert.match(code, /if \(!place\) return null;/);
  assert.match(code, /filter\(\(entry\): entry is LiveDiscoveryEntry => entry !== null\)/);
});

test("The public Production Story repository is backed by the public client", () => {
  const code = stripComments(storyRepository);
  assert.match(code, /export function getPublicProductionStoryRepository/);
  assert.match(code, /getPublicSupabaseClient\(\)/);
});

// --- Home polling + map surface ------------------------------------------------

test("The 15s Live poll only runs while the LIVE tab is active", () => {
  const code = stripComments(homeDiscovery);
  assert.match(code, /useEffect\(\(\) => \{\s*if \(!liveOnly\) return;/);
  assert.match(code, /window\.setInterval\(load, 15000\)/);
  assert.match(code, /\}, \[liveOnly\]\);/);
});

test("A failed Live poll keeps the last good data and never claims the feed is empty", () => {
  // AUDIT FIX (2026-10-17). The old `.catch(() => setLiveItems([]))` turned
  // every transient failure into an EMPTY list: valid LIVE cards, pins, and
  // rows vanished and the UI claimed "belum ada Live" while the network was
  // merely down. The feed now keeps its last successful payload; only the
  // internal status records the failure.
  const code = stripComments(homeDiscovery);
  assert.equal(/catch\(\(\) => setLiveItems\(\[\]\)\)/.test(code), false, "a failure must never empty the list");
  assert.match(code, /setLiveItems\(payload\.live \?\? \[\]\);/);
  assert.match(code, /setLiveFeedStatus\("ready"\);/);
  assert.match(code, /setLiveFeedStatus\("failed"\);/);
  // Only the NEWEST request of the CURRENT tab session may write state, one
  // request runs at a time, and everything is aborted on teardown — a late
  // answer can neither overwrite a newer one nor land after unmount.
  assert.equal((code.match(/if \(cancelled \|\| request !== latestRequest\) return;/g) ?? []).length, 2);
  assert.match(code, /inFlight\?\.abort\(\);/);
  assert.match(code, /new AbortController\(\)/);
  assert.match(code, /window\.setTimeout\(\(\) => controller\.abort\(\), LIVE_REQUEST_TIMEOUT_MS\)/);
  assert.match(code, /fetch\("\/api\/live\/discovery", \{ signal: controller\.signal \}\)/);
  // Polling pauses while the tab is hidden and reloads immediately on return.
  assert.match(code, /document\.visibilityState === "hidden"\) return;/);
  assert.match(code, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
  assert.match(code, /document\.removeEventListener\("visibilitychange", onVisibilityChange\)/);
  // Loading, loaded-empty, and failed stay DISTINCT: the approved no-live
  // empty state renders only after a SUCCESSFUL empty load, a failure with
  // nothing loaded renders the honest failed copy, and neither ever hides
  // loaded data.
  assert.match(code, /liveOnly && liveItems\.length === 0 && liveFeedStatus === "ready" &&/);
  assert.match(code, /liveOnly && liveItems\.length === 0 && liveFeedStatus === "failed" &&/);
  assert.match(code, /Saat ini belum ada Live yang sedang berlangsung\./);
  assert.match(code, /Live belum dapat dimuat\./);
});

test("No Place bottom sheet may cover the map surface", () => {
  const code = stripComments(homeDiscovery);
  assert.equal(/bottom-0 left-0 right-0/.test(code), false, "no absolute bottom strip inside the map frame");
  // 2026-10-21: the ONLY z-[1200] layer is the gesture-help dialog's invisible
  // tap-catcher (a transient modal opened from the "?" tile) — never a Place
  // bottom sheet floating over the map.
  assert.equal((code.match(/z-\[1200\]/g) ?? []).length, 1);
  assert.match(code, /absolute inset-0 z-\[1200\] cursor-default bg-brand-ink\/15/);
  assert.equal(code.includes("Lihat Tempat"), false, "no Place CTA floating over the map");
  assert.equal(/rounded-t-\[28px\]\s+bg-white/.test(code), false, "no bottom-sheet card over the map");
  // Place detail stays served below the map. Stage 3 renamed the default
  // results heading to "Discovery Place" (the canonical engine layer); the
  // proximity label survives only inside the BOUNDED list-gate comment.
  assert.match(code, /aria-labelledby="place-results-heading"/);
  assert.match(code, /Discovery Place/);
});
