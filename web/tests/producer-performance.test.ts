import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * PRODUCER PERFORMANCE PASS (2026-10-08).
 *
 * The verified bottlenecks and the guarantees that must not regress:
 *
 * 1. SEQUENTIAL SERVER LOADS. `/producer` resolved its Places one membership
 *    at a time inside an `await` loop, and `/producer/live` did TWO sequential
 *    awaits per membership. Both are now ONE parallel batch. The batch must
 *    preserve the previous order and null filtering, and must not touch the
 *    authorization predicate, the repository behaviour, or the schema.
 * 2. NESTED SHELLS. The dashboard page wrapped the in-place Place editor in
 *    its own PageShell/PageHeader, so the editor rendered a second shell and a
 *    second header inside it. The page is now a thin loader and each state
 *    renders exactly ONE shell with ONE context and ONE back.
 * 3. SWALLOWED FAILURES. Several data loads ended in `.catch(() => undefined)`,
 *    which turned a network failure into a permanent "Memuat..." state or into
 *    a misleading empty list. Each of those loads now reports a lightweight
 *    visible error instead.
 * 4. IMAGES. Producer-area photos load lazily with async decoding, and the
 *    roster thumbnail declares its intrinsic size so the row cannot shift.
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
const livePage = stripComments(read("app/producer/live/page.tsx"));
const workspace = stripComments(read("app/producer/places/ProducerPlaceWorkspace.tsx"));
const placeWorkspace = stripComments(read("app/producer/places/[placeId]/PlaceWorkspace.tsx"));
const placeForm = stripComments(read("app/producer/places/PlaceForm.tsx"));
const experiencesPanel = stripComments(
  read("app/producer/places/[placeId]/experiences/ExperiencesPanel.tsx"),
);
const productionPanel = stripComments(
  read("app/producer/places/[placeId]/production/ProductionStoryPanel.tsx"),
);
const inbox = stripComments(read("app/producer/visit-intents/Inbox.tsx"));
const aiPanel = stripComments(read("app/producer/places/PlaceAiMediaPanel.tsx"));

const count = (source: string, needle: RegExp) => (source.match(needle) ?? []).length;

// ===========================================================================
// 1. Parallel server loads
// ===========================================================================

test("/producer resolves every managed Place in ONE parallel batch", () => {
  assert.match(dashboard, /await Promise\.all\(/);
  // The old shape was `for (const membership of …) { const place = await … }`.
  assert.equal(
    /for \(const membership of[\s\S]{0,240}?await /.test(dashboard),
    false,
    "the per-membership lookups must not be sequential",
  );
  // The batch keeps the memberships order and drops missing Places exactly as
  // the sequential loop did, so the roster content and order are identical.
  assert.match(dashboard, /resolved\.filter\(\(place\): place is Place => Boolean\(place\)\)/);
  assert.match(dashboard, /memberships \?\? \[\]\)\.map\(\(membership\) => placeRepository\.getById/);
});

test("/producer keeps its authorization predicate and session gate unchanged", () => {
  assert.match(dashboard, /\.in\("role", \["owner", "manager"\]\)/);
  assert.match(dashboard, /AuthenticationRequiredError/);
  assert.match(dashboard, /redirect\("\/auth\?returnTo=%2Fproducer"\)/);
  assert.match(dashboard, /export const dynamic = "force-dynamic"/);
});

test("/producer/live resolves every authorized Place in ONE parallel batch", () => {
  assert.match(livePage, /await Promise\.all\(/);
  assert.equal(
    /for \(const membership of[\s\S]{0,320}?await /.test(livePage),
    false,
    "the per-membership Place/stage reads must not be sequential",
  );
  // Both reads still happen per Place, and the order + null filtering match the
  // previous sequential loop.
  assert.match(livePage, /placeRepository\.getById\(membership\.place_id\)/);
  assert.match(livePage, /stageRepository\.listForPlace\(membership\.place_id, true\)/);
  assert.match(livePage, /resolved\.filter\(\(place\): place is LivePlace => place !== null\)/);
  // Authorization is untouched: still owner/manager memberships, still
  // formatted published stages only.
  assert.match(livePage, /membership\.role === "owner" \|\| membership\.role === "manager"/);
  assert.match(livePage, /filter\(\(stage\) => stage\.status === "published"\)/);
});

test("the public Live discovery endpoint resolves its rows concurrently", () => {
  const discovery = stripComments(read("app/api/live/discovery/route.ts"));
  assert.match(discovery, /await Promise\.all\(/);
  assert.equal(
    /for \(const row of[\s\S]{0,240}?await /.test(discovery),
    false,
    "the per-session Place/stage reads must not be sequential",
  );
  // Fail-closed visibility and the no-write public cache budget are unchanged.
  assert.match(discovery, /getPublishedPlaceById\(row\.place_id\)/);
  assert.match(discovery, /if \(!place\) return null;/);
  assert.equal(discovery.includes("applyLiveDurationCap"), false);
  assert.match(discovery, /export const revalidate = 10;/);
});

// ===========================================================================
// 2. One shell, one header per rendered state
// ===========================================================================

test("the dashboard page is a thin loader with no chrome of its own", () => {
  for (const forbidden of ["PageShell", "PageHeader", "ProducerSubNav", "Kembali ke"]) {
    assert.equal(
      dashboard.includes(forbidden),
      false,
      `the dashboard page must not render ${forbidden}`,
    );
  }
});

test("every dashboard state renders exactly ONE shell and ONE header", () => {
  // Each state is its own branch; a branch owns at most one shell and one
  // header, so no state can nest a second one inside the first.
  const branch = (marker: string) => {
    const start = workspace.indexOf(marker);
    assert.ok(start > -1, `${marker} must exist`);
    const end = workspace.indexOf("\n  }\n", start);
    return workspace.slice(start, end === -1 ? workspace.length : end);
  };

  // claim — the single shell only: PlaceClaimPanel owns the ONE heading and the
  // ONE back action of that state.
  const claim = branch('if (view.name === "claim")');
  assert.equal(count(claim, /<PageShell/g), 1);
  assert.equal(claim.includes("PageHeader"), false, "the claim state must not add a second header");
  assert.match(claim, /<PlaceClaimPanel onBack=\{\(\) => setView\(\{ name: "list" \}\)\} \/>/);

  // add — ONE shell + ONE header + the shared form.
  const add = branch('if (view.name === "new")');
  assert.equal(count(add, /<PageShell/g), 1);
  assert.equal(count(add, /<PageHeader/g), 1);
  assert.match(add, /title="Tambah Tempat"/);
  assert.match(add, /<PlaceForm onSaved=\{handleSaved\} \/>/);

  // in-place editor — NO shell of its own: PlaceWorkspace brings the single one.
  const edit = branch('if (view.name === "edit")');
  assert.equal(edit.includes("PageShell"), false, "the edit state must not nest a second shell");
  assert.equal(edit.includes("PageHeader"), false, "the edit state must not nest a second header");
  assert.match(edit, /<PlaceWorkspace/);

  // roster — the Producer area root: ONE shell + ONE header + the ONE menu.
  const roster = workspace.slice(workspace.lastIndexOf("<PageShell>"));
  assert.equal(count(roster, /<PageShell/g), 1);
  assert.equal(count(roster, /<PageHeader/g), 1);
  assert.match(roster, /title="Dashboard Pengelola"/);
  assert.match(roster, /<ProducerSubNav active="\/producer" \/>/);
  assert.match(roster, /Tempat yang Kamu Kelola/);
});

test("the Place workspace renders exactly ONE shell, header and back action", () => {
  assert.equal(count(placeWorkspace, /<PageShell/g), 1);
  assert.equal(count(placeWorkspace, /<PageHeader/g), 1);
  assert.equal(count(placeWorkspace, /← Pengelola/g), 2); // link branch + in-place button branch
});

// ===========================================================================
// 3. No swallowed network failures
// ===========================================================================

test("no state-gating data load swallows its failure", () => {
  for (const [name, code] of [
    ["place workspace", placeWorkspace],
    ["media panel", placeForm],
    ["experiences panel", experiencesPanel],
    ["production panel", productionPanel],
    ["visit intent inbox", inbox],
  ] as const) {
    assert.equal(
      code.includes(".catch(() => undefined)"),
      false,
      `${name} must not swallow a load failure with an empty catch handler`,
    );
  }
});

test("every repaired load reports a visible, non-blocking failure", () => {
  // Each message is rendered through the existing lightweight states
  // (role="alert" / role="status" text) — no loading library was introduced.
  assert.match(placeWorkspace, /setError\("Tempat tidak dapat dimuat\. Periksa koneksi lalu muat ulang\."\)/);
  assert.match(placeForm, /setLoadError\("Foto Tempat tidak dapat dimuat\. Periksa koneksi lalu muat ulang\."\)/);
  assert.match(placeForm, /role="alert">\{loadError\}/);
  assert.match(experiencesPanel, /setError\("Kegiatan tidak dapat dimuat\. Periksa koneksi lalu muat ulang\."\)/);
  assert.match(productionPanel, /setMessage\("Daftar tahap tidak dapat dimuat\. Periksa koneksi lalu muat ulang\."\)/);
  assert.match(inbox, /setError\("Kunjungan tidak dapat dimuat\. Periksa koneksi lalu muat ulang\."\)/);
  assert.match(inbox, /Daftar Tempat untuk filter tidak dapat dimuat\./);
  // The inbox resolves its loading state on failure instead of hanging.
  const failed = inbox.indexOf("Kunjungan tidak dapat dimuat. Periksa koneksi");
  assert.ok(failed > -1);
  assert.match(inbox.slice(failed, failed + 200), /setLoading\(false\)/);
});

// ===========================================================================
// 4. Images: native lazy loading + stable dimensions
// ===========================================================================

test("the roster thumbnail declares its size and loads lazily", () => {
  const rosterImage = workspace.slice(workspace.indexOf("src={place.coverImageUrl}"));
  assert.match(rosterImage.slice(0, 400), /width=\{40\}[\s\S]{0,80}height=\{40\}/);
  assert.match(rosterImage.slice(0, 400), /loading="lazy"/);
  assert.match(rosterImage.slice(0, 400), /decoding="async"/);
});

test("every Producer-area media photo loads lazily with async decoding", () => {
  for (const [name, code] of [
    ["manual slots", placeForm],
    ["ai sources/outputs", aiPanel],
  ] as const) {
    assert.ok(code.includes('loading="lazy"'), `${name} must lazy-load its photos`);
    assert.ok(code.includes('decoding="async"'), `${name} must decode off the main thread`);
  }
  // No media architecture change: the same upload/generation APIs and slots.
  assert.match(placeForm, /PLACE_PHOTO_SLOTS\.map/);
  assert.match(placeForm, /\/api\/producer\/places\/\$\{place\.id\}\/photos\/\$\{slotKey\}/);
  assert.match(aiPanel, /\/ai-media\/sources\/\$\{sourceKey\}/);
});
