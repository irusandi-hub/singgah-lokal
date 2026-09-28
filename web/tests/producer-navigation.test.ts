import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * PRODUCER NAVIGATION CONTRACT (UI structure only).
 *
 * Every page in the Producer area must let the Producer get back to its
 * parent menu, and there must be exactly ONE navigation system:
 * - the main page (/producer) never links back to itself (it is a working
 *   surface, not a link hub);
 * - a Place-related page returns to the dashboard or to that Place detail;
 * - any other page returns to its correct Producer parent menu;
 * - the shared components/producer-sub-nav.tsx owns the Producer menu tabs,
 *   so no page re-declares a second nav list;
 * - the Visit Intent / Live routes stay reachable from the Place detail
 *   surfaces (the dashboard cards that used to point at them are gone) while
 *   the routes themselves stay untouched.
 */

function read(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const dashboard = stripComments(read("app/producer/page.tsx"));
const workspace = stripComments(read("app/producer/places/ProducerPlaceWorkspace.tsx"));
const livePage = stripComments(read("app/producer/live/page.tsx"));
const inbox = stripComments(read("app/producer/visit-intents/Inbox.tsx"));
const inboxDetail = stripComments(read("app/producer/visit-intents/[id]/VisitIntentDetail.tsx"));
const placeDetail = stripComments(read("app/producer/places/[placeId]/page.tsx"));
const experiences = stripComments(read("app/producer/places/[placeId]/experiences/page.tsx"));
const newExperience = stripComments(read("app/producer/places/[placeId]/experiences/new/page.tsx"));
const editExperience = stripComments(
  read("app/producer/places/[placeId]/experiences/[experienceId]/page.tsx"),
);
const production = stripComments(read("app/producer/places/[placeId]/production/page.tsx"));
const placesRedirect = stripComments(read("app/producer/places/page.tsx"));
const newPlaceRedirect = stripComments(read("app/producer/places/new/page.tsx"));
const onboarding = stripComments(read("app/producer/onboarding/page.tsx"));
const subNav = read("components/producer-sub-nav.tsx");

test("The main Producer page has no navigation back to itself", () => {
  // No sub-nav (it would list "Dashboard" as a self-entry) and no shortcut
  // cards left behind.
  assert.equal(dashboard.includes("ProducerSubNav"), false, "dashboard must not render the ProducerSubNav tabs");
  assert.equal(dashboard.includes("←"), false, "dashboard must not carry a back link to itself");
  // PO fix 2026-09-28: the working dashboard is still never a dead end —
  // it offers the standard way back to the public home (arrow-free, because
  // a "←" on this page would read as a self-link).
  assert.match(dashboard, /href="\/"/, "dashboard keeps a way back to the public home");
  assert.match(dashboard, /Kembali ke Beranda/, "the way back is labelled as a way back");
  assert.equal(dashboard.includes("Area Pengelola"), false, "the shortcut-card section is gone");
});

test("The Producer menu is owned by the shared sub-nav component only", () => {
  assert.match(subNav, /aria-label="Navigasi Pengelola"/);
  // The sub-nav's exit points back to the public home.
  assert.match(subNav, /← Kembali ke beranda/);
  for (const [name, code] of [
    ["dashboard", dashboard],
    ["workspace", workspace],
    ["live", livePage],
    ["inbox", inbox],
    ["inbox detail", inboxDetail],
    ["place detail", placeDetail],
    ["experiences", experiences],
    ["production", production],
  ] as const) {
    assert.equal(
      code.includes("Navigasi Pengelola"),
      false,
      `${name} must not re-declare the Producer menu markup`,
    );
  }
  // Every page that shows the menu imports the SAME component (no duplicate).
  for (const [name, code] of [
    ["live", livePage],
    ["inbox", inbox],
    ["place detail", placeDetail],
    ["workspace", workspace],
  ] as const) {
    assert.match(code, /from "@\/components\/producer-sub-nav"/, `${name} must reuse the shared sub-nav`);
  }
});

test("Visit Intent and Live stay reachable from the Place detail surfaces", () => {
  // The dashboard no longer links them; the Place detail surfaces do, through
  // the shared menu — the routes themselves are untouched.
  assert.equal(dashboard.includes("/producer/visit-intents"), false);
  assert.equal(dashboard.includes("/producer/live"), false);
  for (const [name, code] of [
    ["place detail", placeDetail],
    ["workspace Place detail", workspace],
    ["live", livePage],
    ["inbox", inbox],
  ] as const) {
    assert.match(code, /<ProducerSubNav active="\/producer\/(places|visit-intents|live)" \/>/, `${name} must show the Producer menu`);
  }
});

test("Top-level Producer pages return to the dashboard", () => {
  assert.match(livePage, /href="\/producer"/);
  assert.match(livePage, /← Dashboard Pengelola/);
  assert.match(inbox, /href="\/producer"/);
  assert.match(inbox, /← Dashboard Pengelola/);
});

test("Every Producer page below the dashboard can return to the dashboard", () => {
  // Every descendant page carries its own "← Dashboard Pengelola" link, so no
  // page is ever stranded: a Place page returns to the dashboard (and to that
  // Place detail), any other page returns to its own Producer parent.
  for (const [name, code] of [
    ["live", livePage],
    ["permintaan kunjungan", inbox],
    ["permintaan kunjungan detail", inboxDetail],
    ["place detail", placeDetail],
    ["experiences", experiences],
    ["new experience", newExperience],
    ["edit experience", editExperience],
    ["production", production],
    ["onboarding", onboarding],
  ] as const) {
    assert.match(code, /href="\/producer"/, `${name} must link back to the dashboard`);
    assert.match(code, /← Dashboard Pengelola/, `${name} must show a back link to the dashboard`);
  }
  // ...and the dashboard itself never links back to itself.
  assert.equal(dashboard.includes('href="/producer"'), false, "the dashboard must not link to itself");
});

test("Place-related pages return to the dashboard or that Place detail", () => {
  // Place detail (/producer/places/[placeId]) is the dashboard's Place detail
  // route, so it goes back to the dashboard — NOT to the redirect-only
  // /producer/places route.
  assert.match(placeDetail, /href="\/producer"/);
  assert.equal(placeDetail.includes('href="/producer/places"'), false, "Place detail must not link the redirect-only list route");
  // Place children go back to that Place detail.
  assert.match(experiences, /← Kembali ke Tempat/);
  assert.match(experiences, /`\/producer\/places\/\$\{placeId\}`/);
  assert.match(production, /← Kembali ke Tempat/);
  assert.match(production, /href=\{`\/producer\/places\/\$\{placeId\}`\}/);
  // The dashboard's in-page Place editor returns to the roster.
  assert.match(workspace, /Kembali ke Tempat/);
});

test("Kegiatan pages return to the Kegiatan list of the same Place", () => {
  for (const [name, code] of [
    ["new experience", newExperience],
    ["edit experience", editExperience],
  ] as const) {
    assert.match(code, /← Kembali ke Kegiatan/, name);
    assert.match(code, /`\/producer\/places\/\$\{placeId\}\/experiences`/);
  }
});

test("The Kunjungan detail returns to the Permintaan Kunjungan list", () => {
  assert.match(inboxDetail, /href="\/producer\/visit-intents"/);
  assert.match(inboxDetail, /← Kembali ke Permintaan Kunjungan/);
});

test("Legacy Place list/add routes stay pure redirects (no page, no nav)", () => {
  for (const [name, code] of [
    ["places", placesRedirect],
    ["places/new", newPlaceRedirect],
  ] as const) {
    assert.match(code, /redirect\("\/producer"\)/);
    assert.equal(code.includes("<"), false, `${name} must render no UI`);
  }
});

test("The Producer application page stays on the user-area navigation", () => {
  // Onboarding runs before any membership exists, so it keeps the public home
  // as its parent and reuses the shared SiteNav rather than the Producer menu.
  assert.match(onboarding, /<SiteNav \/>/);
  assert.match(onboarding, /← Kembali ke beranda/);
  assert.equal(onboarding.includes("ProducerSubNav"), false);
});
