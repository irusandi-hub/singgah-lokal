import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * PRODUCER PLACE WORKSPACE (PO, mockup work 2026-09-26)
 *
 * The Producer dashboard (/producer) is ONE working page for Place:
 * - header/branding + "Dashboard Producer" + Visit Intent Inbox + Live cards;
 * - the "Place milikmu" roster with each Place selectable for management;
 * - "+ Tambahkan Place baru" BELOW the roster, opening the add form IN PLACE
 *   (view "new") — save transitions new → edit/manage with the id preserved
 *   (Upload immediately usable);
 * - the editor reuses the SAME PlaceForm (Informasi | Experience | Upload
 *   tabs; Experience tab reuses the standalone experiences surface).
 *
 * There is NO second Place list page: /producer/places and /producer/places/new
 * are pure redirects to /producer (backward-compatible hand-offs, no UI, no
 * parallel form). The per-Place deep-link routes stay reachable and render the
 * SAME canonical editor.
 *
 * The Upload tab remains REAL: for a saved Place it drives the existing
 * server-side multipart endpoint (Producer-gated) → Supabase Storage →
 * place_photos, restores slots on reload; for a NEW Place it is disabled with
 * the reason shown. PLACE_PHOTO_SLOTS stays the slot source of truth.
 * The dashboard loads Places server-side from the authenticated user's
 * owner/manager memberships via the canonical repository — no new API/auth.
 */

const producerDashboard = readFileSync(new URL("../app/producer/page.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../app/producer/places/ProducerPlaceWorkspace.tsx", import.meta.url), "utf8");
const placesPage = readFileSync(new URL("../app/producer/places/page.tsx", import.meta.url), "utf8");
const newPage = readFileSync(new URL("../app/producer/places/new/page.tsx", import.meta.url), "utf8");
const placeForm = readFileSync(new URL("../app/producer/places/PlaceForm.tsx", import.meta.url), "utf8");
const editPage = readFileSync(new URL("../app/producer/places/[placeId]/page.tsx", import.meta.url), "utf8");
const experiencesPage = readFileSync(new URL("../app/producer/places/[placeId]/experiences/page.tsx", import.meta.url), "utf8");
const experiencesPanel = readFileSync(new URL("../app/producer/places/[placeId]/experiences/ExperiencesPanel.tsx", import.meta.url), "utf8");
const inbox = readFileSync(new URL("../app/producer/visit-intents/Inbox.tsx", import.meta.url), "utf8");
const inboxDetail = readFileSync(new URL("../app/producer/visit-intents/[id]/VisitIntentDetail.tsx", import.meta.url), "utf8");
const placesApiRoute = readFileSync(new URL("../app/api/producer/places/route.ts", import.meta.url), "utf8");
const placeManagement = readFileSync(new URL("../lib/place-management.ts", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const dashboardCode = stripComments(producerDashboard);
const workspaceCode = stripComments(workspace);
const placesRedirectCode = stripComments(placesPage); // redirect page checks run comment-free
const newRedirectCode = stripComments(newPage);
const formCode = stripComments(placeForm);
const experiencesPageCode = stripComments(experiencesPage);
const experiencesPanelCode = stripComments(experiencesPanel);
const inboxCode = stripComments(inbox);
const inboxDetailCode = stripComments(inboxDetail);
const placesApiCode = stripComments(placesApiRoute);

test("The dashboard is the single working page hosting the Place workspace", () => {
  // No Places shortcut card / no duplicate entry: the dashboard must not
  // LINK into any Place route (the workspace import path is not a link).
  assert.equal(dashboardCode.includes('"/producer/places'), false, "dashboard must not link any /producer/places route");
  assert.equal(dashboardCode.includes("Places<"), false, "no Places shortcut card on the dashboard");
  // The dashboard keeps the ordered surfaces: title, Inbox, Live...
  assert.match(dashboardCode, /Dashboard Producer/);
  assert.match(dashboardCode, /Visit Intent Inbox/);
  assert.match(dashboardCode, /href="\/producer\/visit-intents"/);
  assert.match(dashboardCode, /href="\/producer\/live"/);
  // ...and hosts the "Place milikmu" workspace (roster + add + edit) in place.
  assert.match(dashboardCode, /<ProducerPlaceWorkspace initialPlaces=\{places\} showOnboardingHint=\{places\.length === 0\} \/>/);
  assert.match(workspaceCode, /Place milikmu/);
  assert.match(workspaceCode, /Tambahkan Place baru/);
});

test("The dashboard carries no ProducerSubNav — it is a working surface, not a link hub", () => {
  // FAIL if the sub-nav (Dashboard/Places/... tabs) returns to /producer.
  assert.equal(dashboardCode.includes("ProducerSubNav"), false, "dashboard must not render the ProducerSubNav tabs");
});

test("No intermediary Place list page exists — legacy routes are pure redirects", () => {
  // The former second list page hands off to the dashboard with NO UI.
  assert.match(placesRedirectCode, /redirect\("\/producer"\)/);
  assert.equal(placesRedirectCode.includes("<PlaceForm"), false, "no form on the redirect page");
  assert.equal(placesRedirectCode.includes("useState"), false, "no view state on the redirect page");
  assert.equal(placesRedirectCode.includes("Tambahkan Place baru"), false, "no roster UI on the redirect page");
  assert.equal(placesRedirectCode.includes("Place milikmu"), false, "no roster heading on the redirect page");
  // The legacy standalone add route also hands off — no second form surface.
  assert.match(newRedirectCode, /redirect\("\/producer"\)/);
  assert.equal(newRedirectCode.includes("<PlaceForm"), false);
  // Nothing links into the legacy routes anymore (dashboard, workspace,
  // form, inbox, inbox detail).
  for (const code of [dashboardCode, workspaceCode, formCode, inboxCode, inboxDetailCode]) {
    assert.equal(code.includes("/producer/places/new"), false, "no /producer/places/new links");
    assert.equal(code.includes('href="/producer/places"'), false, "no plain /producer/places links");
  }
});

test("The Place surface is an explicit list/new/edit state machine", () => {
  // Explicit states...
  assert.match(workspaceCode, /type ProducerPlaceWorkspaceView =/);
  assert.match(workspaceCode, /\{ name: "list" \}/);
  assert.match(workspaceCode, /\{ name: "new" \}/);
  assert.match(workspaceCode, /\{ name: "edit"; place: Place \}/);
  // ...with "list" as the only initial state (a fresh load is always the roster).
  assert.match(workspaceCode, /useState<ProducerPlaceWorkspaceView>\(\{ name: "list" \}\)/);
  // Selecting a Place switches the whole view state (edit A never leaks into edit B).
  assert.match(workspaceCode, /setView\(\{ name: "edit", place \}\)/);
  // The roster is server-fed (initialPlaces) — no second fetch of the roster API.
  assert.match(workspaceCode, /initialPlaces: Place\[\]/);
  assert.equal(workspaceCode.includes('fetch("/api/producer/places")'), false, "roster comes from the server, not a second fetch");
});

test("NEW starts empty; a successful submit transitions new → edit/manage with the id preserved", () => {
  // The roster gain + new→edit transition happens in ONE save handler.
  assert.match(workspaceCode, /function handleSaved\(saved: Place\)/);
  assert.match(workspaceCode, /current\.some\(\(place\) => place\.id === saved\.id\)/);
  assert.match(workspaceCode, /setView\(\{ name: "edit", place: saved \}\)/);
  // PlaceForm's NEW branch still resets transient input on successful submit
  // (locked separately by tests/lifecycle-form-state.test.ts).
  assert.match(formCode, /if \(!place\) setForm\(emptyPlaceForm\(\)\)/);
  // The saved record flows back through onSaved (form → workspace state).
  assert.match(formCode, /onSaved\?\.\(data\)/);
});

test("Tambahkan Place baru sits BELOW the roster and opens the form in place", () => {
  // The action renders after the roster (or its empty state)...
  const buttonIdx = workspaceCode.indexOf("Tambahkan Place baru");
  assert.ok(buttonIdx > -1);
  const listIdx = workspaceCode.indexOf("places.map");
  const emptyIdx = workspaceCode.indexOf("Belum ada Place yang dapat dikelola");
  assert.ok(listIdx > -1 && emptyIdx > -1);
  assert.ok(buttonIdx > listIdx && buttonIdx > emptyIdx, "the add action must come after the roster/empty state");
  // ...and stays IN PAGE: a button calling setView("new"), never a link/route.
  const aroundButton = workspaceCode.slice(Math.max(0, buttonIdx - 700), buttonIdx);
  assert.match(aroundButton, /onClick=\{\(\) => setView\(\{ name: "new" \}\)\}/);
  assert.equal(aroundButton.includes("href="), false, "the add action must be a button, not a link to a second route");
  // The new form renders on the same page via the shared PlaceForm (NEW branch).
  assert.match(workspaceCode, /<PlaceForm onSaved=\{handleSaved\} \/>/);
});

test("Edit reuses the canonical editor; status, Dari Sini, and Experience stay manageable", () => {
  // The edit view uses the SAME PlaceEditor (PlaceForm) — no parallel form.
  assert.match(workspaceCode, /<PlaceEditor id=\{view\.place\.id\} onSaved=\{handleSaved\} \/>/);
  // PlaceEditor loads the saved record from the canonical GET endpoint.
  assert.match(formCode, /fetch\(`\/api\/producer\/places\/\$\{id\}`\)/);
  // Publication status stays visible in the edit surface; Dari Sini stays reachable.
  assert.match(workspaceCode, /view\.place\.publicationStatus/);
  assert.match(workspaceCode, /\/producer\/places\/\$\{view\.place\.id\}\/production/);
  // The old per-Place edit route stays reachable and renders the same editor.
  assert.match(editPage, /<PlaceEditor id=\{id\}/);
  assert.equal(editPage.includes("function PlaceEditor"), false);
});

test("Editor tabs are Informasi | Experience | Upload, with Experience reusing the standalone panel", () => {
  assert.match(formCode, /role="tab"/);
  assert.match(formCode, /Informasi/);
  assert.match(formCode, /setEditorTab\("experience"\)/);
  assert.match(formCode, /setEditorTab\("upload"\)/);
  // The Experience tab reuses the standalone experiences surface (same API,
  // same links) — no parallel management UI; gated on a saved Place.
  assert.match(formCode, /\{editorTab === "experience" && place && \(/);
  assert.match(formCode, /<ExperiencesPanel placeId=\{place\.id\} \/>/);
  // The standalone page itself reuses the SAME panel (no duplicated list).
  assert.match(experiencesPageCode, /<ExperiencesPanel placeId=\{placeId\} \/>/);
  assert.equal(experiencesPageCode.includes("experiences.map"), false, "standalone page must not duplicate the panel list");
  // The panel keeps the canonical experiences API + deep links.
  assert.match(experiencesPanelCode, /fetch\(`\/api\/producer\/places\/\$\{placeId\}\/experiences`\)/);
  assert.match(experiencesPanelCode, /\/producer\/places\/\$\{placeId\}\/experiences\/\$\{experience\.id\}/);
});

test("The editor carries an actionable Upload tab gated on a saved Place", () => {
  // Tab "Upload" exists beside "Informasi"/"Experience"...
  assert.match(formCode, /Detail Place|Informasi/);
  assert.match(formCode, /Upload/);
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

test("Dashboard Place data comes from the canonical server-side memberships path", () => {
  // Authorization stays server-side: session → memberships (owner/manager)
  // → canonical management repository. No new API, no client-side gate.
  assert.match(dashboardCode, /AuthenticationRequiredError/);
  assert.match(dashboardCode, /redirect\("\/auth\?returnTo=%2Fproducer"\)/);
  assert.match(dashboardCode, /from\("producer_memberships"\)/);
  assert.match(dashboardCode, /\.in\("role", \["owner", "manager"\]\)/);
  assert.match(dashboardCode, /getServerPlaceManagementRepository/);
  // The onboarding empty state keeps its onboarding-only link (never a
  // Place-management path).
  assert.match(workspaceCode, /href="\/producer\/onboarding"/);
  assert.match(workspaceCode, /Belum ada Place yang dapat dikelola/);
});

test("The Producer never types a Place ID — the system generates it on save", () => {
  // The user-facing "ID Place" input is REMOVED from the NEW form...
  assert.equal(formCode.includes("ID Place"), false, "no user-facing ID Place field");
  assert.equal(formCode.includes('value={form.id}'), false, "the id must not be a typed form field");
  // ...but the technical id stays internal: the form still submits the id
  // field it holds (empty for NEW) and the POST route generates it.
  assert.match(placesApiCode, /derivePlaceIdFromName\(mutation\.name\)/);
  assert.match(placesApiCode, /repository\.getById\(mutation\.id\)/);
  // The parser tolerates an empty id (system-generated) while keeping every
  // other validation, and the slug derivation matches the existing format.
  assert.match(placeManagement, /mutation\.id \|\| "system-generated"/);
  assert.match(placeManagement, /export function derivePlaceIdFromName/);
  // The save flow keeps new → edit with the server-returned record (id set).
  assert.match(workspaceCode, /setView\(\{ name: "edit", place: saved \}\)/);
});

test("Producer surfaces share the same cream/light theme (no dark producer page)", () => {
  // Dashboard, workspace container, inbox, inbox detail, and the standalone
  // experiences page use the existing brand-cream theme...
  assert.match(dashboardCode, /bg-brand-cream/);
  assert.match(dashboardCode, /text-brand-ink/);
  assert.match(experiencesPageCode, /bg-brand-cream/);
  assert.match(inboxCode, /bg-brand-cream/);
  assert.match(inboxCode, /text-brand-ink/);
  assert.match(inboxDetailCode, /bg-brand-cream/);
  // ...the dark window wrappers are GONE from the Visit Intent surfaces...
  assert.equal(inboxCode.includes("bg-brand-ink"), false, "Inbox must not use the dark window");
  assert.equal(inboxDetailCode.includes("bg-brand-ink"), false, "Visit Intent detail must not use the dark window");
  assert.equal(inboxCode.includes("bg-white/10"), false, "Inbox must not use dark-surface cards");
  assert.equal(inboxDetailCode.includes("bg-white/10"), false, "detail must not use dark-surface cards");
  // ...and the embedded components declare no page of their own at all: no
  // full-screen wrapper (the dashboard owns the theme) and no dark-surface
  // signature (bg-brand-ink + text-brand-cream as a page palette). Button
  // accents in the existing ink color stay untouched.
  for (const [name, code] of [["workspace", workspaceCode], ["experience panel", experiencesPanelCode], ["editor form", formCode]] as const) {
    assert.equal(code.includes("min-h-screen"), false, `${name} must not render its own page background`);
    assert.equal(code.includes("text-brand-cream"), false, `${name} must not switch to the dark palette`);
  }
});
