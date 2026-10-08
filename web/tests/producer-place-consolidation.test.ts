import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * PRODUCER PLACE WORKSPACE — ONE context, ONE navigation layer, ONE work area.
 *
 * UI/UX restructure 2026-10-08 (second pass). The rendered Producer Place area
 * must stop stacking navigation:
 *
 * - /producer is a true landing/workspace page: the global Producer menu (the
 *   area root, so Dashboard/Tempat/Permintaan Kunjungan/Live stay reachable)
 *   plus the compact "Tempat yang Kamu Kelola" roster, "+ Tambahkan Tempat" and
 *   "Ajukan Pengelolaan Tempat". Each Place is ONE compact row.
 * - a Place is ONE workspace (PlaceWorkspace.tsx): the Place name is the title,
 *   status appears ONCE in a compact status/action row, and the only navigation
 *   is the four workspace items — Informasi | Kegiatan | Media | Kelola Proses —
 *   plus the ONE contextual back link "← Pengelola".
 * - the Producer global navigation is NEVER rendered inside a Place.
 * - "Kelola Proses" is the fourth workspace item (the existing "Dari Sini"
 *   production-story editor), not a large CTA above the navigation, and the
 *   /production route simply opens the same workspace on that item.
 * - the editor reuses the SAME PlaceForm (Informasi), the SAME ExperiencesPanel
 *   (Kegiatan) and the SAME media panel (Media); the MEDIA concept is unchanged
 *   (Manual OR Generate AI, one at a time).
 *
 * There is NO second Place list page: /producer/places and /producer/places/new
 * are pure redirects to /producer. The per-Place deep links stay reachable and
 * render the SAME canonical workspace.
 *
 * The dashboard loads Places server-side from the authenticated user's
 * owner/manager memberships via the canonical repository — no new API/auth.
 */

const producerDashboard = readFileSync(new URL("../app/producer/page.tsx", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../app/producer/places/ProducerPlaceWorkspace.tsx", import.meta.url), "utf8");
const placesPage = readFileSync(new URL("../app/producer/places/page.tsx", import.meta.url), "utf8");
const newPage = readFileSync(new URL("../app/producer/places/new/page.tsx", import.meta.url), "utf8");
const placeForm = readFileSync(new URL("../app/producer/places/PlaceForm.tsx", import.meta.url), "utf8");
const placeWorkspace = readFileSync(new URL("../app/producer/places/[placeId]/PlaceWorkspace.tsx", import.meta.url), "utf8");
const editPage = readFileSync(new URL("../app/producer/places/[placeId]/page.tsx", import.meta.url), "utf8");
const productionPage = readFileSync(new URL("../app/producer/places/[placeId]/production/page.tsx", import.meta.url), "utf8");
const productionPanel = readFileSync(new URL("../app/producer/places/[placeId]/production/ProductionStoryPanel.tsx", import.meta.url), "utf8");
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
const placeWorkspaceCode = stripComments(placeWorkspace);
const productionPageCode = stripComments(productionPage);
const productionPanelCode = stripComments(productionPanel);
const placesRedirectCode = stripComments(placesPage); // redirect page checks run comment-free
const newRedirectCode = stripComments(newPage);
const formCode = stripComments(placeForm);
const experiencesPageCode = stripComments(experiencesPage);
const experiencesPanelCode = stripComments(experiencesPanel);
const inboxCode = stripComments(inbox);
const inboxDetailCode = stripComments(inboxDetail);
const placesApiCode = stripComments(placesApiRoute);

test("The dashboard is the single landing/workspace page hosting the Place workspace", () => {
  // No Places shortcut card / no duplicate entry: the dashboard page must not
  // LINK into any Place route (the workspace import path is not a link).
  assert.equal(dashboardCode.includes('"/producer/places'), false, "dashboard must not link any /producer/places route");
  assert.equal(dashboardCode.includes("Tempat<"), false, "no Tempat shortcut card on the dashboard");
  // The page is a THIN loader: the header lives in the workspace it renders
  // (UI/perf pass 2026-10-08), which keeps exactly one shell per state.
  assert.match(workspaceCode, /Pengelola/);
  assert.equal(dashboardCode.includes("PageShell"), false, "the page must not add a shell around the workspace");
  // ...and hosts the "Tempat yang Kamu Kelola" workspace (roster + add + edit) in place.
  assert.match(dashboardCode, /<ProducerPlaceWorkspace initialPlaces=\{places\} showOnboardingHint=\{places\.length === 0\} \/>/);
  assert.match(workspaceCode, /Tempat yang Kamu Kelola/);
  assert.match(workspaceCode, /Tambahkan Tempat/);
});

test("The global Producer menu lives at the area root, never inside a Place", () => {
  // The roster view is the Producer area root, so the Producer's own functions
  // stay reachable from there...
  assert.match(workspaceCode, /<ProducerSubNav active="\/producer" \/>/);
  // ...and the Place workspace itself must NOT render a second navigation
  // system next to its four items.
  assert.equal(placeWorkspaceCode.includes("ProducerSubNav"), false, "the Place workspace must not render the global menu");
  assert.equal(placeWorkspaceCode.includes("Permintaan Kunjungan"), false, "the Place workspace must not list the global functions");
  assert.equal(placeWorkspaceCode.includes("Dashboard"), false, "the Place workspace must not list the global menu tabs");
});

test("No intermediary Place list page exists — legacy routes are pure redirects", () => {
  // The former second list page hands off to the dashboard with NO UI.
  assert.match(placesRedirectCode, /redirect\("\/producer"\)/);
  assert.equal(placesRedirectCode.includes("<PlaceForm"), false, "no form on the redirect page");
  assert.equal(placesRedirectCode.includes("useState"), false, "no view state on the redirect page");
  assert.equal(placesRedirectCode.includes("Tambahkan Tempat"), false, "no roster UI on the redirect page");
  assert.equal(placesRedirectCode.includes("Tempat yang Kamu Kelola"), false, "no roster heading on the redirect page");
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
  // The publication status is never shown as a raw database value.
  assert.equal(workspaceCode.includes("{place.publicationStatus}"), false, "no raw publication status in the roster");
  assert.equal(placeWorkspaceCode.includes("{place.publicationStatus}"), false, "no raw publication status in the workspace");
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

test("Tambahkan Tempat sits BELOW the roster and opens the form in place", () => {
  // The action renders after the roster (or its empty state)...
  const buttonIdx = workspaceCode.indexOf("Tambahkan Tempat");
  assert.ok(buttonIdx > -1);
  const listIdx = workspaceCode.indexOf("places.map");
  const emptyIdx = workspaceCode.indexOf("Belum ada Tempat yang dapat dikelola");
  assert.ok(listIdx > -1 && emptyIdx > -1);
  assert.ok(buttonIdx > listIdx && buttonIdx > emptyIdx, "the add action must come after the roster/empty state");
  // ...and stays IN PAGE: a button calling setView("new"), never a link/route.
  const aroundButton = workspaceCode.slice(Math.max(0, buttonIdx - 700), buttonIdx);
  assert.match(aroundButton, /onClick=\{\(\) => setView\(\{ name: "new" \}\)\}/);
  assert.equal(aroundButton.includes("href="), false, "the add action must be a button, not a link to a second route");
  // The new form renders on the same page via the shared PlaceForm (NEW branch).
  assert.match(workspaceCode, /<PlaceForm onSaved=\{handleSaved\} \/>/);
});

test("Edit reuses the canonical Place workspace; status and every item stay manageable", () => {
  // The edit view uses the SAME PlaceWorkspace through the shared component —
  // no parallel editor surface in the dashboard.
  assert.match(workspaceCode, /<PlaceWorkspace/);
  assert.match(workspaceCode, /placeId=\{view\.place\.id\}/);
  assert.match(workspaceCode, /initialPlace=\{view\.place\}/);
  // The workspace loads the saved record from the canonical GET endpoint.
  assert.match(placeWorkspaceCode, /fetch\(`\/api\/producer\/places\/\$\{placeId\}`\)/);
  // Publication status stays visible exactly ONCE (UI/UX restructure
  // 2026-10-08): the roster row labels it through the shared dictionary, and
  // the workspace shows it once in its compact status/action row — never a
  // second status block in the header on top of it.
  assert.match(workspaceCode, /publicationStatusLabel\(place\.publicationStatus\)/);
  assert.match(placeWorkspaceCode, /publicationStatusLabel\(place\.publicationStatus\)/);
  assert.equal(
    (placeWorkspaceCode.match(/publicationStatusLabel\(place\.publicationStatus\)/g) ?? []).length,
    1,
    "the workspace must label the status exactly once",
  );
  // ...and the old standalone "Status: …" panel markup is gone entirely.
  assert.equal(
    placeWorkspaceCode.includes("Status: <"),
    false,
    "no second status panel next to the compact status row",
  );
  // The Informasi form owns no status at all: the workspace labels it once.
  assert.equal(formCode.includes("publicationStatusLabel"), false, "the Informasi form must not re-render the status");
  // The status transitions keep running through the existing publication API.
  assert.match(placeWorkspaceCode, /\/api\/producer\/places\/\$\{placeId\}\/publication/);
  // The old per-Place edit route stays reachable and renders the same workspace.
  assert.match(editPage, /<PlaceWorkspace placeId=\{placeId\}/);
  assert.equal(editPage.includes("function PlaceEditor"), false);
});

test("The Place workspace has exactly ONE navigation layer: the four workspace items", () => {
  assert.match(placeWorkspaceCode, /type PlaceWorkspaceTab = "detail" \| "experience" \| "media" \| "production"/);
  for (const label of ["Informasi", "Kegiatan", "Media", "Kelola Proses"]) {
    assert.ok(placeWorkspaceCode.includes(`label: "${label}"`), `the workspace must offer ${label}`);
  }
  // The tab bar is ONE row of four equal cells (compact, never clipped behind
  // the viewport, never a horizontal scroll strip).
  assert.match(placeWorkspaceCode, /role="tablist"/);
  assert.match(placeWorkspaceCode, /tabListClass/);
  assert.match(placeWorkspaceCode, /role="tab"/);
  // Exactly one contextual escape: "← Pengelola" back to the dashboard.
  assert.equal((placeWorkspaceCode.match(/← Pengelola/g) ?? []).length, 2); // link + button branch, mutually exclusive
  assert.equal(placeWorkspaceCode.includes("← Dashboard Pengelola"), false);
  assert.equal(placeWorkspaceCode.includes("Kembali ke Tempat"), false);
  assert.equal(placeWorkspaceCode.includes("Kembali ke Beranda"), false);
});

test("Kelola Proses is the fourth workspace item, not a CTA above the navigation", () => {
  // The production story renders as the workspace's own work area...
  assert.match(placeWorkspaceCode, /\{tab === "production" && <ProductionStoryPanel placeId=\{place\.id\} \/>\}/);
  assert.match(placeWorkspaceCode, /import ProductionStoryPanel from "\.\/production\/ProductionStoryPanel"/);
  // ...and the /production route is just that workspace opened on the item —
  // no second page header, no second back link, no second tab layer.
  assert.match(productionPageCode, /<PlaceWorkspace placeId=\{placeId\} initialTab="production"/);
  assert.equal(productionPageCode.includes("PageShell"), false, "the production route must not render its own page shell");
  assert.equal(productionPageCode.includes("Kembali ke"), false, "the production route must not add a second back link");
  // The production functionality itself is untouched: same endpoints, same
  // actions (add, edit, reorder, review, publish, status).
  assert.match(productionPanelCode, /\/api\/producer\/places\/\$\{placeId\}\/production-story`/);
  assert.match(productionPanelCode, /\/production-story\/\$\{stage\.id\}/);
  assert.match(productionPanelCode, /\/production-story\/reorder/);
  assert.match(productionPanelCode, />Simpan draft</);
  assert.match(productionPanelCode, /productionStageStatusLabel\(stage\.status\)/);
});

test("The workspace items reuse the shared panels — no parallel surfaces", () => {
  // Informasi → the canonical PlaceForm; Kegiatan → the canonical panel;
  // Media → the canonical media panel.
  assert.match(placeWorkspaceCode, /\{tab === "detail" && <PlaceForm place=\{place\} onSaved=\{applyPlace\} \/>\}/);
  assert.match(placeWorkspaceCode, /\{tab === "experience" && <ExperiencesPanel placeId=\{place\.id\} \/>\}/);
  assert.match(placeWorkspaceCode, /\{tab === "media" && <PlaceMediaPanel place=\{place\} \/>\}/);
  // The Kegiatan route opens the SAME workspace on the same item.
  assert.match(experiencesPageCode, /<PlaceWorkspace placeId=\{placeId\} initialTab="experience"/);
  assert.equal(experiencesPageCode.includes("experiences.map"), false, "the route must not duplicate the panel list");
  // The panel keeps the canonical experiences API + deep links.
  assert.match(experiencesPanelCode, /fetch\(`\/api\/producer\/places\/\$\{placeId\}\/experiences`\)/);
  assert.match(experiencesPanelCode, /\/producer\/places\/\$\{placeId\}\/experiences\/\$\{experience\.id\}/);
});

test("The editor carries an actionable Media item gated on a saved Place", () => {
  // Tab "Media" exists beside "Informasi"/"Kegiatan"/"Kelola Proses"...
  assert.match(formCode, /Media Tempat/);
  assert.match(placeWorkspaceCode, /label: "Media"/);
  // ...and the workspace only renders it for a loaded (saved) Place.
  assert.match(placeWorkspaceCode, /\{tab === "media" && <PlaceMediaPanel place=\{place\} \/>\}/);
  // The manual method's photo slots render only once the Producer picked it.
  assert.match(formCode, /\{mediaMethod === "manual" && \(/);
  assert.match(formCode, /PLACE_PHOTO_SLOTS\.map/);
  // The slot list loads from the canonical place_photos record.
  assert.match(formCode, /\/api\/producer\/places\/\$\{place\.id\}\/photos`/);
});

test("The photo picker is a real clickable control, not static OS text", () => {
  // PO fix 2026-09-28: the bare file input rendered as "Choose File / No file
  // chosen" — OS chrome nobody could tap on a phone. The visible control is a
  // real button that opens the picker of a hidden, unchanged file input.
  assert.match(formCode, /ref=\{fileInputRef\}/);
  assert.match(formCode, /type="file"/);
  assert.match(formCode, /className="sr-only"/);
  assert.match(formCode, /onClick=\{\(\) => fileInputRef\.current\?\.click\(\)\}/);
  assert.match(formCode, /Pilih file foto/);
  // Same rules as before, unchanged: accepted formats and the 5 MB limit
  // still run at pick time and again server-side.
  assert.match(formCode, /PLACE_MEDIA_ACCEPTED_TYPES\.join\(","\)/);
});

test("The Producer form never renders a timezone input; the server owns the zone", () => {
  // PO fix, 2026-09-28: the Timezone field is gone from the Producer form —
  // coordinates are the source of truth and the zone is resolved server-side
  // (lib/place-management) before a save is accepted.
  assert.doesNotMatch(formCode, /Timezone/);
  assert.doesNotMatch(formCode, /"timezone"/);
  // The form grid and the photo rows cannot force their parents wider than the
  // phone frame: the form tracks are pinned to the container width
  // (minmax(0,1fr)), so wide content widens the item instead of the page.
  assert.match(formCode, /grid min-w-0 grid-cols-\[minmax\(0,1fr\)\] gap-4/);
  assert.match(formCode, /grid min-w-0 gap-2 border-t border-black\/10 pt-3/);
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
  assert.match(workspaceCode, /Belum ada Tempat yang dapat dikelola/);
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
  // The ONE shared shell owns the brand-cream palette (UI/UX restructure
  // 2026-10-08) — so the theme is declared once instead of being repeated per
  // page. Every Producer surface renders through it.
  const shell = readFileSync(new URL("../components/ui/kit.tsx", import.meta.url), "utf8");
  assert.match(shell, /bg-brand-cream/);
  assert.match(shell, /text-brand-ink/);
  for (const [name, code] of [
    ["area root", workspaceCode],
    ["place workspace", placeWorkspaceCode],
    ["inbox", inboxCode],
    ["inbox detail", inboxDetailCode],
  ] as const) {
    assert.match(code, /PageShell/, `${name} must render through the shared shell`);
  }
  // ...and the dashboard page itself renders NO shell: the workspace it mounts
  // owns the single one, so the in-place editor can never nest a second shell.
  assert.equal(dashboardCode.includes("PageShell"), false);
  assert.equal(dashboardCode.includes("PageHeader"), false);
  // The production story is a workspace item now, so its panel carries no
  // shell of its own — the ONE Place workspace owns the page frame.
  assert.match(placeWorkspaceCode, /<ProductionStoryPanel/);
  assert.equal(productionPanelCode.includes("PageShell"), false, "the production item must not declare a page shell");
  // ...the dark window wrappers are GONE from the Visit Intent surfaces...
  assert.equal(inboxCode.includes("bg-brand-ink"), false, "Inbox must not use the dark window");
  assert.equal(inboxDetailCode.includes("bg-brand-ink"), false, "Visit Intent detail must not use the dark window");
  assert.equal(inboxCode.includes("bg-white/10"), false, "Inbox must not use dark-surface cards");
  assert.equal(inboxDetailCode.includes("bg-white/10"), false, "detail must not use dark-surface cards");
  // ...and the embedded components declare no page of their own at all: no
  // full-screen wrapper (the workspace owns the theme) and no dark-surface
  // signature (bg-brand-ink + text-brand-cream as a page palette). Button
  // accents in the existing ink color stay untouched.
  for (const [name, code] of [["workspace", workspaceCode], ["experience panel", experiencesPanelCode], ["editor form", formCode], ["production panel", productionPanelCode]] as const) {
    assert.equal(code.includes("min-h-screen"), false, `${name} must not render its own page background`);
    assert.equal(code.includes("text-brand-cream"), false, `${name} must not switch to the dark palette`);
  }
});
