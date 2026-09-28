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
  // The MVP tab set (PO, 2026-09-28): "Kegiatan" and "Kunjungan" are gone
  // from the Admin navigation; their pages remain reachable by direct URL.
  for (const label of ["Overview", "Users", "Pengelola", "Pengelola Membership", "Tempat", "Live", "Moderation"]) {
    assert.match(nav, new RegExp(`label: "${label}"`));
  }
  assert.doesNotMatch(nav, /label: "Kegiatan"/);
  assert.doesNotMatch(nav, /label: "Kunjungan"/);
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

test("AdminDataTable is a table on desktop and labelled cards on mobile", () => {
  const ui = stripComments(adminUi);
  // No forced minimum width anywhere — the old min-w-[640px] pushed wide
  // tables out of the phone frame.
  assert.doesNotMatch(ui, /min-w-\[640px\]/);
  assert.doesNotMatch(ui, /min-w-\[/);
  // Same component, two presentations: cards below sm, the table from sm up.
  assert.match(ui, /className="grid gap-3 sm:hidden"/);
  assert.match(ui, /className="hidden overflow-x-auto rounded-2xl border border-black\/10 bg-white sm:block"/);
  // Mobile fields keep their column header as a label, so values stay
  // readable without the table's side-by-side columns.
  assert.match(ui, /<dt/);
  assert.match(ui, /<dd/);
  // Long values wrap instead of pushing the layout wide.
  assert.match(ui, /break-words/);
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
  // arrow, and never muted grey on grey.
  const places = stripComments(read("../app/admin/places/page.tsx"));
  assert.match(places, /text-brand-primary transition hover:bg-brand-primary\/10/);
  assert.match(places, /<span aria-hidden>→<\/span>/);
  // The "lihat bukti" text action stays underlined accent.
  const claims = read("../app/admin/places/PlaceClaimsManager.tsx");
  assert.match(claims, /font-bold text-brand-primary underline underline-offset-2/);
  // Buttons that are already buttons stay buttons — no conversion either way.
  assert.match(stripComments(read("../components/admin/place-moderation.tsx")), /type="button"/);
});
