import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const homePage = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
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

test("Tempat pilihan is the default curated heading; Tempat di sekitar is radius-gated only", () => {
  assert.match(homePage, /Tempat pilihan/);
  // The proximity label exists but ONLY under an active bounded radius —
  // never a permanent label for a Place that merely has coordinates.
  // Gating is done on the unbounded filter ("10 km+") staying curated.
  const code = stripComments(homePage);
  assert.match(code, /distanceFilter === "10 km\+"/);
  assert.match(code, /Tempat di sekitar/);
  // A Place is never statically labeled "Tempat di sekitar" outside the
  // filter-gated expressions (two occurrences, both inside a ternary whose
  // condition is the unbounded filter).
  const occurrences = code.split("Tempat di sekitar").length - 1;
  const conditional = (code.match(/"10 km\+"\s*\?\s*"Tempat pilihan"\s*:\s*"Tempat di sekitar"/g) ?? []).length;
  assert.ok(
    occurrences === 2 && conditional === 2,
    `expected both occurrences radius-gated (got ${occurrences} occurrences, ${conditional} gated)`,
  );
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

test("Producer Place form sends coverImageUrl and EDIT restores the saved value", () => {
  const code = stripComments(placeForm);
  assert.match(code, /coverImageUrl: \"\"/);
  assert.match(code, /coverImageUrl: place\.coverImageUrl \?\? \"\"/);
  assert.match(code, /coverImageUrl: form\.coverImageUrl\.trim\(\) \|\| null/);
  assert.match(code, /URL Gambar Sampul/);
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
