import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * ADMIN SURFACE USABILITY (PO, 2026-09-28).
 *
 * Placement rules locked at source level, in the repo's existing surface-test
 * style: which tab is active on a nested route, that tab switches show a
 * skeleton instead of a frozen page, that the one data table re-reads on a
 * phone instead of leaving the frame, that every page has a way back, and
 * that text links look like links.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const stripComments = (source: string) =>
  source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");

const adminNav = read("../components/admin/admin-nav.tsx");
const adminLayout = read("../app/admin/layout.tsx");
const adminLoading = read("../app/admin/loading.tsx");
const adminUi = read("../components/admin/ui.tsx");

// ---------------------------------------------------------------------------
// 3. Navigation consistency
// ---------------------------------------------------------------------------

test("the Admin nav marks the active tab, including a nested route's parent", () => {
  const nav = stripComments(adminNav);
  // Client-rendered, because a server layout cannot know the current path —
  // and an active state that is not real is not an active state.
  assert.match(nav, /"use client"/);
  assert.match(nav, /usePathname/);
  assert.match(nav, /aria-current=\{active \? "page" : undefined\}/);
  // The exact section matches first; a nested path falls back to its parent
  // (/admin/places/[placeId] → Tempat).
  assert.match(nav, /exact: true/);
  assert.match(nav, /pathname\.startsWith\(`\$\{href\}\/`/);
  // The MVP tab set (PO, 2026-09-29), with the Indonesian labels of the UI
  // terminology standard (docs/UI_TERMINOLOGY_STANDARD.md): Ringkasan, Data
  // Pengguna, Data Pengelola, Data Tempat, Data Live, Moderasi Live, Riwayat &
  // Arsip. The standalone "Pengelola" tab is gone; "Kegiatan" and
  // "Kunjungan" stay out of the Admin navigation.
  for (const label of ["Ringkasan", "Data Pengguna", "Data Pengelola", "Data Tempat", "Data Live", "Moderasi Live", "Riwayat & Arsip"]) {
    assert.match(nav, new RegExp(`label: "${label}"`));
  }
  assert.doesNotMatch(nav, /label: "Kegiatan"/);
  assert.doesNotMatch(nav, /label: "Kunjungan"/);
  assert.doesNotMatch(nav, /label: "Pengelola"/);
  assert.doesNotMatch(nav, /admin\/producers/);

  // The archive tab points at the ONE deliberate archive surface; the archive
  // search itself is exercised further in place-claim-archive.test.ts.
  assert.match(nav, /href: "\/admin\/archives"/);
  // The layout renders the nav once — no second, divergent nav anywhere.
  assert.match(adminLayout, /<AdminNav \/>/);
  assert.doesNotMatch(adminLayout, /aria-label="Navigasi Admin"/);
});

test("every admin page has a path back and the layout always offers Beranda", () => {
  // The header link to the main app is always rendered, on every page.
  assert.match(adminLayout, /href="\/"/);
  assert.match(adminLayout, /Kembali ke Beranda/);
  // Nested pages carry their own parent back-link.
  const placeWorkspace = read("../app/admin/places/[placeId]/page.tsx");
  assert.match(placeWorkspace, /href="\/admin\/places"/);
  assert.match(placeWorkspace, /Kembali ke daftar Tempat/);
  const placeNew = read("../app/admin/places/new/page.tsx");
  assert.match(placeNew, /href="\/admin\/places"/);
});

// ---------------------------------------------------------------------------
// 2 + 4. Responsive table, loading skeleton
// ---------------------------------------------------------------------------

test("AdminDataTable is ONE table at 75vh with internal scroll, on every viewport", () => {
  const ui = stripComments(adminUi);
  // No forced minimum width anywhere — the old min-w-[640px] pushed wide
  // tables out of the phone frame.
  assert.doesNotMatch(ui, /min-w-\[640px\]/);
  // The card/list presentation is RETIRED (PO, 2026-09-28): a phone shows the
  // same table, not stacked cards — one data surface on every viewport.
  assert.doesNotMatch(ui, /sm:hidden/);
  assert.doesNotMatch(ui, /<dt/);
  assert.doesNotMatch(ui, /<dd/);
  // The viewport is capped at 75vh and scrolling happens INSIDE the table.
  assert.match(ui, /max-h-\[75vh\]/);
  assert.match(ui, /overflow-auto/);
  // Long values wrap inside their cell instead of pushing the layout wide —
  // no horizontal page overflow at 360/390px.
  assert.match(ui, /break-words/);
  assert.match(ui, /max-w-full/);
});

test("each Admin list has ONE search box above the table, without reload", () => {
  // The shared search box: a client component that narrows the loaded
  // canonical dataset in memory — no navigation, no refetch.
  const searchBox = stripComments(read("../components/admin/admin-search-box.tsx"));
  assert.match(searchBox, /"use client"/);
  assert.match(searchBox, /role="search"/);
  assert.match(searchBox, /type="search"/);
  assert.match(searchBox, /onSearch\(event\.target\.value\)/);
  // Every list page mounts it directly above its table.
  for (const [page, list] of [
    ["../app/admin/users/page.tsx", "../app/admin/users/AdminUsersTable.tsx"],
    ["../app/admin/producer-membership/page.tsx", "../app/admin/producer-membership/AdminPengelolaTable.tsx"],
    ["../app/admin/places/page.tsx", "../app/admin/places/AdminPlacesTable.tsx"],
  ] as const) {
    const source = read(page);
    assert.match(source, /Admin\w+Table/);
    const table = stripComments(read(list));
    assert.match(table, /AdminSearchBox/);
    assert.match(table, /AdminDataTable/);
  }
  // The search vocabulary per list (PO, 2026-09-29).
  const usersTable = stripComments(read("../app/admin/users/AdminUsersTable.tsx"));
  assert.match(usersTable, /user\.email/);
  const pengelolaTable = stripComments(read("../app/admin/producer-membership/AdminPengelolaTable.tsx"));
  assert.match(pengelolaTable, /row\.producerName/);
  assert.match(pengelolaTable, /row\.email/);
  assert.match(pengelolaTable, /row\.placeName/);
  const placesTable = stripComments(read("../app/admin/places/AdminPlacesTable.tsx"));
  assert.match(placesTable, /row\.ownerEmail/);
  assert.match(placesTable, /row\.name/);
});

test("Pengelola and Place lists are ordered country, then region, then name — from the canonical data", () => {
  // The order is applied in the DATABASE query over the whole domain, never
  // as a client sort of a truncated page.
  const queries = stripComments(read("../lib/admin/queries.ts"));
  const ordered = queries.match(/\.order\("country_code", \{ ascending: true \}\)[\s\S]*?\.order\("region_name", \{ ascending: true \}\)[\s\S]*?\.order\("name", \{ ascending: true \}\)/g) ?? [];
  assert.ok(ordered.length >= 2, "both the Place list and the Pengelola list read the canonical order");
  // The Pengelola ↔ Place list re-applies the same triple after filtering.
  const pengelolaTable = stripComments(read("../app/admin/producer-membership/AdminPengelolaTable.tsx"));
  assert.match(pengelolaTable, /localeCompare\(b\.countryCode/);
  assert.match(pengelolaTable, /localeCompare\(b\.regionName/);
  assert.match(pengelolaTable, /localeCompare\(b\.placeName/);
  // The reads are bounded by a platform-size guard, not a page size.
  assert.match(queries, /CANONICAL_LIST_LIMIT/);
  // Owner/membership emails are resolved server-side, Admin context only.
  assert.match(queries, /loadAuthEmails/);
  assert.match(queries, /requireAdmin\(\)/);
});

test("admin routes render a skeleton while streaming instead of a frozen page", () => {
  assert.match(adminLoading, /aria-busy="true"/);
  assert.match(adminLoading, /Memuat/);
  // Lightweight: platform pulse only, no heavy animation or new dependency.
  const animations = adminLoading.match(/animate-[-]+/g) ?? [];
  for (const animation of animations) {
    assert.equal(animation, "animate-pulse", `only animate-pulse is allowed, found ${animation}`);
  }
  assert.doesNotMatch(adminLoading, /framer|motion/);
});

// ---------------------------------------------------------------------------
// 5. Recognizable links
// ---------------------------------------------------------------------------

test("text links across the Admin area carry a consistent cue", () => {
  // Back links: accent + underline + arrow.
  for (const path of ["../app/admin/places/[placeId]/page.tsx", "../app/admin/places/new/page.tsx"]) {
    const page = stripComments(read(path));
    assert.match(page, /text-brand-primary underline underline-offset-2/);
    assert.match(page, /<span aria-hidden>←<\/span>/);
  }
  // The row action that opens a Place is a link styled as one: accent colour,
  // arrow, and never muted grey on grey. It now lives in the list's client
  // table component (the same styles, same destination).
  const placesTable = stripComments(read("../app/admin/places/AdminPlacesTable.tsx"));
  assert.match(placesTable, /text-brand-primary transition hover:bg-brand-primary\/10/);
  assert.match(placesTable, /<span aria-hidden>→<\/span>/);
  // The "lihat bukti" text action stays underlined accent.
  const claims = read("../app/admin/places/PlaceClaimsManager.tsx");
  assert.match(claims, /font-bold text-brand-primary underline underline-offset-2/);
  // Buttons that are already buttons stay buttons — no conversion either way.
  assert.match(stripComments(read("../components/admin/place-moderation.tsx")), /type="button"/);
});
