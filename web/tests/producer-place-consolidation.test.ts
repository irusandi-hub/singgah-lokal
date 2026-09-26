import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * PRODUCER PLACE CONSOLIDATION (PO, 2026-09-26)
 *
 * One canonical Producer Place page (/producer/places) owns the whole
 * Place-management surface:
 * - the roster ("Place saya") with an explicit empty state;
 * - the "+ Tambah Place" action opening the add form IN PLACE (view "new")
 *   — no standalone new-Place route as a second UI;
 * - per-Place edit/manage reusing the SAME PlaceForm (view "edit"), loaded
 *   from the canonical GET endpoint;
 * - an explicit list/new/edit view state: a fresh load is always "list"
 *   (a refresh can never resurrect a previous session), NEW always starts
 *   empty, and a successful NEW submit transitions new → edit/manage for
 *   the saved Place (id preserved);
 * - the old per-Place edit page stays reachable (backward compatibility)
 *   and renders the SAME canonical editor — no duplicated logic.
 * The old standalone /producer/places/new route hands off (redirect) to the
 * canonical page.
 */

const placesPage = readFileSync(new URL("../app/producer/places/page.tsx", import.meta.url), "utf8");
const newPage = readFileSync(new URL("../app/producer/places/new/page.tsx", import.meta.url), "utf8");
const placeForm = readFileSync(new URL("../app/producer/places/PlaceForm.tsx", import.meta.url), "utf8");
const editPage = readFileSync(new URL("../app/producer/places/[placeId]/page.tsx", import.meta.url), "utf8");
const producerDashboard = readFileSync(new URL("../app/producer/page.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const pageCode = stripComments(placesPage);
const formCode = stripComments(placeForm);

test("One canonical Producer Places page: roster, in-place add, and edit on the same route", () => {
  // Part 1–4 of the target structure, all in the canonical page.
  assert.match(pageCode, /ProducerSubNav/);
  assert.match(pageCode, /Place saya/);
  // "+ Tambah Place" is an in-page action (button), NOT a link to a second UI.
  assert.match(pageCode, /\+ Tambah Place/);
  assert.match(pageCode, /onClick=\{\(\) => setView\(\{ name: "new" \}\)\}/);
  // The add form renders on the same page via the shared PlaceForm (NEW
  // branch) — no parallel form anywhere.
  assert.match(pageCode, /<PlaceForm onSaved=\{handleSaved\} \/>/);
});

test("The view is an explicit list/new/edit state machine", () => {
  // Explicit states...
  assert.match(pageCode, /type ProducerPlacesView =/);
  assert.match(pageCode, /\{ name: "list" \}/);
  assert.match(pageCode, /\{ name: "new" \}/);
  assert.match(pageCode, /\{ name: "edit"; place: Place \}/);
  // ...with "list" as the only initial state (refresh can never resurrect
  // a previous new/edit session).
  assert.match(pageCode, /useState<ProducerPlacesView>\(\{ name: "list" \}\)/);
  // Selecting a Place switches the whole view state, so edit A can never
  // leak into edit B.
  assert.match(pageCode, /setView\(\{ name: "edit", place \}\)/);
});

test("NEW starts empty; a successful submit transitions new → edit/manage with the id preserved", () => {
  // The roster gain + new→edit transition happens in ONE save handler.
  assert.match(pageCode, /function handleSaved\(saved: Place\)/);
  assert.match(pageCode, /current\.some\(\(place\) => place\.id === saved\.id\)/);
  assert.match(pageCode, /setView\(\{ name: "edit", place: saved \}\)/);
  // PlaceForm's NEW branch still resets transient input on successful submit
  // (locked separately by tests/lifecycle-form-state.test.ts).
  assert.match(formCode, /if \(!place\) setForm\(emptyPlaceForm\(\)\)/);
  // The saved record flows back through onSaved (form → page state).
  assert.match(formCode, /onSaved\?\.\(data\)/);
});

test("Edit reuses the canonical editor and loads the saved record", () => {
  // The edit view uses the SAME PlaceEditor (PlaceForm) — no parallel form.
  assert.match(pageCode, /<PlaceEditor id=\{view\.place\.id\} onSaved=\{handleSaved\} \/>/);
  // PlaceEditor loads from the canonical GET endpoint.
  assert.match(formCode, /fetch\(`\/api\/producer\/places\/\$\{id\}`\)/);
  // Existing manage links (Dari Sini / Experience) stay reachable in edit.
  assert.match(pageCode, /\/producer\/places\/\$\{view\.place\.id\}\/production/);
  assert.match(pageCode, /\/producer\/places\/\$\{view\.place\.id\}\/experiences/);
});

test("The standalone new-Place route is a redirect, not a second UI", () => {
  assert.match(newPage, /redirect\("\/producer\/places"\)/);
  assert.equal(newPage.includes("<PlaceForm"), false, "no duplicated form on the legacy route");
  // No other UI still links to the legacy route.
  assert.equal(producerDashboard.includes("/producer/places/new"), false);
  assert.equal(pageCode.includes("/producer/places/new"), false);
});

test("The old per-Place edit route stays reachable and renders the same editor", () => {
  // Backward compatibility: the route exists and reuses PlaceEditor —
  // no duplicated form logic.
  assert.match(editPage, /<PlaceEditor id=\{id\}/);
  assert.equal(editPage.includes("function PlaceEditor"), false);
});

test("The dashboard entry keeps existing correct information and links the canonical page", () => {
  // Existing nav + roster surface intact, pointing at /producer/places.
  assert.match(producerDashboard, /href="\/producer\/places"/);
  assert.match(producerDashboard, /Place milikmu/);
});

test("Place list data comes from the canonical Producer API", () => {
  assert.match(pageCode, /fetch\("\/api\/producer\/places"\)/);
  // Unauthorized producers are routed to login (the API stays the boundary).
  assert.match(pageCode, /\/auth\?returnTo=%2Fproducer%2Fplaces/);
});

// --- Upload tab (PO, 2026-09-26; TAHAP 2) ---------------------------------

test("The editor carries an actionable Upload tab gated on a saved Place", () => {
  // Tab "Upload" exists beside "Detail Place"...
  assert.match(formCode, /role="tab"/);
  assert.match(formCode, /Detail Place/);
  assert.match(formCode, /setEditorTab\("upload"\)/);
  // ...disabled (with the reason) while the Place has no saved id...
  assert.match(formCode, /disabled=\{!place\}/);
  assert.match(formCode, /aria-disabled=\{!place\}/);
  assert.match(formCode, /Tab Upload aktif setelah Place disimpan/);
  // ...and the photo slots render only inside the Upload tab.
  assert.match(formCode, /\{editorTab === "upload" && \(/);
  assert.match(formCode, /PLACE_PHOTO_SLOTS\.map/);
  // The slot list loads from the canonical place_photos record.
  assert.match(formCode, /\/api\/producer\/places\/\$\{place\.id\}\/photos/);
});

test("Upload/delete failures surface as slot errors (no silent success)", () => {
  // The DELETE path maps backend errors to the slot error state, exactly
  // like the upload path — the UI never claims success without the API.
  const removeIdx = formCode.indexOf("async function removeSlot");
  assert.ok(removeIdx > 0);
  const removeBlock = formCode.slice(removeIdx, removeIdx + 1400);
  assert.match(removeBlock, /if \(response\.ok\)/);
  assert.match(removeBlock, /mediaErrorLabel\(String\(data\.error \?\? "place_media_upload_failed"\)\)/);
  // Authorization/auth failures get explicit Indonesian messages.
  assert.match(formCode, /producer_authorization_required:/);
  assert.match(formCode, /authentication_required:/);
});
