import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const homePage = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const placeDetail = readFileSync(new URL("../app/places/[id]/page.tsx", import.meta.url), "utf8");
const placeForm = readFileSync(new URL("../app/producer/places/PlaceForm.tsx", import.meta.url), "utf8");
const placesModel = readFileSync(new URL("../lib/places.ts", import.meta.url), "utf8");
const placeRepo = readFileSync(new URL("../lib/place-experience-repository.ts", import.meta.url), "utf8");
const placeManagement = readFileSync(new URL("../lib/place-management.ts", import.meta.url), "utf8");
const visitIntentRepo = readFileSync(new URL("../lib/visit-intent-repository.ts", import.meta.url), "utf8");
const coverMigration = readFileSync(
  new URL("../supabase/migrations/0018_place_cover_image.sql", import.meta.url),
  "utf8",
);
const siteNav = readFileSync(new URL("../components/site-nav.tsx", import.meta.url), "utf8");
const signOutButton = readFileSync(new URL("../components/sign-out-button.tsx", import.meta.url), "utf8");
const sessionEvents = readFileSync(new URL("../lib/session-events.ts", import.meta.url), "utf8");
const signOutRoute = readFileSync(new URL("../app/api/auth/sign-out/route.ts", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

// --- B: Place list heading ---

test("Tempat Pilihan is the dedicated curated layer with Dapur/Kopi/Teh collections; Tempat di sekitar is radius-gated only", () => {
  assert.match(homePage, /Tempat Pilihan/);
  // "Tempat Pilihan" is a separate tab beside the distance group (PO request
  // 2026-09-25): it toggles the curated state and never reuses the distance
  // filter state. Dapur/Kopi/Teh are the collections INSIDE the layer —
  // mapped to the canonical Place categories (no new category, no "lokal"
  // grouping, no nearby-view category).
  const code = stripComments(homePage);
  assert.match(code, /curatedOnly/);
  assert.match(code, /setCuratedOnly\(true\)/);
  assert.match(code, /CURATED_COLLECTIONS\.map/);
  assert.match(code, /activeCollection\?\.label/);
  // Collection membership is decided by the canonical Place category.
  assert.match(code, /place\.category === activeCollection\.category/);
  // The proximity label exists but ONLY under an active bounded radius —
  // the curated layer and the radius tabs are mutually exclusive states.
  assert.match(code, /Tempat di sekitar/);
  // A Place is never statically labeled "Tempat di sekitar" outside the
  // curated-state-gated expression (heading ternary keyed on curatedOnly);
  // the section heading is the single occurrence that may render it.
  const occurrences = code.split("Tempat di sekitar").length - 1;
  const conditional = (
    code.match(/curatedOnly\s*\?\s*(?:\n?\s*)?activeCollection\?\.label \?\? "Tempat Pilihan"\s*:\s*"Tempat di sekitar"/g) ?? []
  ).length;
  assert.ok(
    occurrences === 1 && conditional === 1,
    `expected the heading to be the single curated-state-gated occurrence (got ${occurrences} occurrences, ${conditional} gated)`,
  );
  // The map stays unbounded in curated mode (no radius refocus) and the
  // Live-now cards are not part of the curated layer.
  assert.match(code, /curatedOnly \? null : DISTANCE_FILTER_RADIUS_M\[distanceFilter\]/);
  assert.match(code, /!curatedOnly && liveCards\.length > 0/);
  // Collections come from the canonical model: the mockup labels map onto
  // the EXISTING Place categories — none is added, renamed, or removed.
  const modelCode = stripComments(placesModel);
  assert.match(modelCode, /\{ key: "kuliner", label: "Dapur", category: "Kuliner" \}/);
  assert.match(modelCode, /\{ key: "kopi", label: "Kopi", category: "Kopi" \}/);
  assert.match(modelCode, /\{ key: "teh", label: "Teh", category: "Teh" \}/);
  assert.match(modelCode, /export type PlaceCategory = "Kopi" \| "Teh" \| "Kuliner";/);
});

// --- C: Place detail hero replaces the info block ---

test("Place detail drops timezone/currency/claim/producer info block", () => {
  const code = stripComments(placeDetail);
  assert.doesNotMatch(code, /Waktu Place/);
  assert.doesNotMatch(code, /Mata uang Place/);
  assert.doesNotMatch(code, /Status klaim/);
  assert.doesNotMatch(code, /place\.producer\?\.displayName/);
  assert.doesNotMatch(code, /place\.timezone|place\.currency/);
});

test("Place detail renders the canonical cover image as the hero", () => {
  const code = stripComments(placeDetail);
  // Hero comes only from saved canonical data...
  assert.match(code, /place\.coverImageUrl \? \(/);
  assert.match(code, /src=\{place\.coverImageUrl\}/);
  // ...and nothing is invented when no cover exists (hero simply absent).
  assert.match(code, /alt=\{`Gambar sampul \$\{place\.name\}`\}/);
});

// --- D: cover_image_url end-to-end ---

test("Migration 0018 adds cover_image_url as an https-only optional column", () => {
  assert.match(coverMigration, /add column if not exists cover_image_url text/);
  assert.match(coverMigration, /places_cover_image_url_https/);
  assert.match(coverMigration, /'?\^https:/);
});

test("Place model carries coverImageUrl and validates it server-side", () => {
  const code = stripComments(placesModel);
  assert.match(code, /coverImageUrl: string \| null/);
  assert.match(code, /Invalid cover image URL for Place/);
  assert.match(code, /\/\^https:\\\/\\\//);
  assert.match(code, /length > 2048/);
});

test("Repositories read and persist cover_image_url end-to-end", () => {
  const repoCode = stripComments(placeRepo);
  // read path (both discovery and visit-intent mappers)...
  assert.match(repoCode, /cover_image_url as string \| null \| undefined/);
  // ...write path for create and update.
  assert.match(repoCode, /cover_image_url: input\.coverImageUrl/);
  assert.match(repoCode, /\"coverImageUrl\"/);
  assert.match(stripComments(visitIntentRepo), /cover_image_url/);
});

test("Server-side parser rejects non-https cover URLs and accepts clearing", () => {
  const code = stripComments(placeManagement);
  assert.match(code, /place_cover_image_invalid/);
  const fn = code.slice(code.indexOf("function parseCoverImageUrl"), code.indexOf("}", code.indexOf("function parseCoverImageUrl")));
  assert.match(fn, /\/\^https:\\\/\\\//i);
  assert.match(fn, /return null/);
});

test("Producer Place form no longer carries a cover-URL input (media moved to Storage slots)", () => {
  const code = stripComments(placeForm);
  // The HTTP-URL cover input was REMOVED as the media mechanism (PO request,
  // 2026-09-25); photos now go through the standard Storage slots.
  assert.doesNotMatch(code, /coverImageUrl/i);
  assert.doesNotMatch(code, /URL Gambar Sampul/);
  assert.match(code, /PLACE_PHOTO_SLOTS\.map/);
});

// --- Home filter bar (PO 2026-09-26): ONE row, no overflow, fixed order ---

test("Home filter bar is a single row: LIVE leftmost, Tempat Pilihan beside it, distance tabs after", () => {
  const code = stripComments(homePage);
  // The two former bars are merged into ONE grid row (PO 2026-09-26): no
  // separate primary row and no separate distance row.
  assert.match(code, /mb-5 grid grid-cols-\[auto_auto_1fr_1fr_1fr\]/);
  assert.equal(code.includes("grid-cols-[auto_1fr]"), false, "old two-row primary bar is gone");
  assert.equal(code.includes("grid-cols-4"), false, "old separate distance bar is gone");
  // Order is locked: LIVE leftmost, Tempat Pilihan directly beside it, then
  // the distance tabs.
  const filterBar = code.indexOf("mb-5 grid grid-cols-[auto_auto_1fr_1fr_1fr]");
  const liveBtn = code.indexOf("setLiveOnly", filterBar);
  const curatedBtn = code.indexOf("setCuratedOnly(true)", filterBar);
  const distanceBtn = code.indexOf("DISTANCE_FILTERS.map", filterBar);
  assert.ok(liveBtn >= 0 && curatedBtn > liveBtn && distanceBtn > curatedBtn, "LIVE | Tempat Pilihan | distance tabs, in order");
  // The filter bar never horizontally scrolls (the old overflow strip).
  assert.equal(/className="mb-5 flex gap-2 overflow-x-auto"/.test(code.slice(0, filterBar)), false);
  // The only remaining scroll container is the curated-chips row INSIDE the
  // Tempat Pilihan layer — Dapur/Kopi/Teh never become primary tabs.
  const chipsIdx = code.indexOf('aria-label="Koleksi Tempat Pilihan"');
  assert.ok(chipsIdx > filterBar, "collection chips render only inside the Tempat Pilihan layer");
  const barSlice = code.slice(filterBar, chipsIdx);
  assert.ok(!barSlice.includes("CURATED_COLLECTIONS"), "no collection is a primary tab");
  // No Kategori tab/filter exists on Home (categories stay internal data).
  assert.equal(code.includes(">Kategori</button>"), false);
});

test("Account authority probe reads an existing membership column (no id column exists)", () => {
  const accountPage = readFileSync(new URL("../app/account/page.tsx", import.meta.url), "utf8");
  const code = stripComments(accountPage);
  // The membership probe used select("id") — producer_memberships has NO id
  // column (PK is (user_id, place_id)), so every probe errored and approved
  // Producers were treated as regular users on /account.
  assert.match(code, /\.select\("role"\)/);
  assert.doesNotMatch(code, /\.select\("id"\)/);
  assert.match(code, /\.eq\("user_id", userData\.user\.id\)/);
  assert.match(code, /\.in\("role", \["owner", "manager"\]\)/);
  // The Producer entry is driven by that probe and links the dashboard.
  assert.match(code, /isProducer: Boolean\(membership\)/);
  assert.match(code, /href: "\/producer"/);
});

// --- Auth navigation: the header flips from live session state ---

test("Session probe, sign-in, and sign-out answers are never cacheable", () => {
  const sessionRoute = readFileSync(new URL("../app/api/auth/session/route.ts", import.meta.url), "utf8");
  const signInRoute = readFileSync(new URL("../app/api/auth/sign-in/route.ts", import.meta.url), "utf8");
  const signOutCode = stripComments(signOutRoute);
  const sessionCode = stripComments(sessionRoute);
  const signInCode = stripComments(signInRoute);
  // Every session-state answer carries no-store — a cached probe answer
  // (taken signed-out) replayed to a signed-in browser is the "Daftar still
  // visible after login + refresh" bug.
  const noStore = /"Cache-Control": "no-store, must-revalidate"/;
  assert.match(sessionCode, noStore);
  assert.match(signInCode, noStore);
  assert.match(signOutCode, noStore);
  // The probe itself stays the live cookie read (no role data added).
  assert.match(sessionCode, /supabase\.auth\.getUser\(\)/);
});

test("Home shell renders per request so the header reflects the live session", () => {
  // The static Home shell was served with a year-long s-maxage; a signed-in
  // browser kept receiving the signed-out shell (stale Daftar) after
  // refresh. force-dynamic re-renders the shell with the live probe.
  const appPage = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const appCode = stripComments(appPage);
  assert.match(appCode, /export const dynamic = "force-dynamic"/);
  // The UI itself is a client component mounted by the server wrapper
  // (route segment config is ignored in "use client" files). The wrapper
  // prefetches public Places server-side (initialPlaces, PO 2026-09-26) so
  // the client never re-fetches /api/places after hydration.
  assert.match(appCode, /<HomeDiscovery initialPlaces=\{initialPlaces\} \/>/);
  assert.match(stripComments(homePage), /"use client"/);
});

test("Sign-out flips the header back to Daftar/Masuk through the same probe", () => {
  const code = stripComments(signOutButton);
  assert.match(code, /broadcastSessionChanged\(\)/);
  // SiteNav re-probes on the broadcast (already covered below) — the nav
  // renders Daftar/Masuk only when the probe says unauthenticated.
  const navCode = stripComments(siteNav);
  // Account controls replace Daftar/Masuk exactly when the probe says
  // authenticated (AccountMenu branch), and both auth entries exist in the
  // signed-out branch.
  const authedIdx = navCode.indexOf("authenticated ? (");
  const menuIdx = navCode.indexOf("<AccountMenu />");
  const elseIdx = navCode.indexOf(") : (", authedIdx);
  const signUpIdx = navCode.indexOf('href="/auth/sign-up"');
  const signInIdx = navCode.indexOf('href="/auth"');
  assert.ok(authedIdx >= 0 && menuIdx > authedIdx && elseIdx > menuIdx, "AccountMenu renders only in the authenticated branch");
  assert.ok(signUpIdx > elseIdx && signInIdx > signUpIdx, "Daftar + Masuk render only in the signed-out branch");
});

// --- A: Sign-out flips the header without a manual refresh ---

test("Sign-out broadcasts a session-changed event after server confirmation", () => {
  const code = stripComments(signOutButton);
  assert.match(code, /broadcastSessionChanged\(\)/);
  // The broadcast happens only after the server confirmed the session is gone.
  const okIdx = code.indexOf("setSuccess(true)");
  const broadcastIdx = code.indexOf("broadcastSessionChanged()");
  const fetchIdx = code.indexOf('await fetch("/api/auth/sign-out"');
  assert.ok(fetchIdx >= 0 && broadcastIdx > fetchIdx && okIdx > fetchIdx, "broadcast must follow server confirmation");
});

test("SiteNav re-probes the session on sign-out and bfcache restores", () => {
  const code = stripComments(siteNav);
  assert.match(code, /SESSION_CHANGED_EVENT/);
  assert.match(code, /window\.addEventListener\(SESSION_CHANGED_EVENT, probe\)/);
  assert.match(code, /pageshow/);
  assert.match(code, /event\.persisted/);
  // The probe hits the real session endpoint.
  assert.match(code, /api\/auth\/session/);
  // Event carries no payload; consumers verify server-side.
  assert.match(sessionEvents, /SESSION_CHANGED_EVENT = "singgah:session-changed"/);
});

test("Sign-out endpoint keeps server-side invalidation as the source of truth", () => {
  const code = stripComments(signOutRoute);
  assert.match(code, /supabase\.auth\.signOut\(\)/);
  assert.match(code, /CREATOR_GATE_COOKIE/);
  assert.match(code, /authenticated: false/);
});
