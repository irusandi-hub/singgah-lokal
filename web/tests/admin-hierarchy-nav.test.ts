import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * ADMIN HIERARCHY NAVIGATION (PO, 2026-09-28).
 *
 * Every Admin page states where it sits in the hierarchy: a back-link to its
 * parent section, and the layout's Beranda link above it. Source-level rules,
 * in the repo's existing surface-test style.
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

const ui = read("../components/admin/ui.tsx");
const layout = read("../app/admin/layout.tsx");

const SECTION_PAGES = [
  "../app/admin/users/page.tsx",
  "../app/admin/producer-membership/page.tsx",
  "../app/admin/experiences/page.tsx",
  "../app/admin/visit-intents/page.tsx",
  "../app/admin/live/page.tsx",
  "../app/admin/moderation/page.tsx",
];

test("every admin section page carries the shared back-link to Admin Center", () => {
  // One component, one cue: the same accent underline back-link everywhere.
  const backLink = stripComments(ui);
  assert.match(backLink, /export function AdminBackToAdminCenter/);
  assert.match(backLink, /href="\/admin"/);
  assert.match(backLink, /Kembali ke Admin Center/);
  assert.match(backLink, /text-brand-primary underline underline-offset-2/);

  for (const path of SECTION_PAGES) {
    const page = stripComments(read(path));
    assert.match(page, /<AdminBackToAdminCenter \/>/, `${path} must render the back-link`);
  }
});

test("the Overview links up too, and the layout always offers Beranda", () => {
  const overview = stripComments(read("../app/admin/page.tsx"));
  assert.match(overview, /<AdminBackToAdminCenter \/>/);
  // The layout renders the Beranda link on every page, above the tab bar.
  assert.match(layout, /href="\/"/);
  assert.match(layout, /Kembali ke Beranda/);
  assert.match(layout, /<AdminNav \/>/);
});

test("nested Place routes keep their parent back-link, styled like every other link", () => {
  for (const path of ["../app/admin/places/[placeId]/page.tsx", "../app/admin/places/new/page.tsx"]) {
    const page = stripComments(read(path));
    // Parent is the PLACE LIST, not the Admin Center — hierarchy, not a
    // one-size link.
    assert.match(page, /href="\/admin\/places"/);
    assert.match(page, /Kembali ke daftar Tempat/);
    assert.match(page, /text-brand-primary underline underline-offset-2/);
    assert.match(page, /<span aria-hidden>←<\/span>/);
  }
  // The workspace keeps the section's own deep links consistent as well.
  const workspace = stripComments(read("../app/admin/places/[placeId]/page.tsx"));
  assert.match(workspace, /Buka antrean review klaim/);
});

test("long identifiers and emails wrap instead of leaving the frame", () => {
  const dataTable = stripComments(ui);
  // Every cell bounds its width and wraps; the mobile card fields do the same.
  assert.match(dataTable, /max-w-\[16rem\]/);
  assert.match(dataTable, /break-words/);
  assert.match(dataTable, /min-w-0 break-words/);
  // The nav wraps by flex-wrap, so nine tabs never force a horizontal scroll.
  const nav = stripComments(read("../components/admin/admin-nav.tsx"));
  assert.match(nav, /flex flex-wrap gap-2/);
});
