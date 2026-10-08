import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * PRODUCER NAVIGATION CONTRACT (UI structure only).
 *
 * ONE page → ONE context → ONE navigation layer → ONE work area. Concretely:
 * - the global Producer menu (components/producer-sub-nav.tsx) is declared
 *   once and rendered at the Producer area root (the roster view of the
 *   dashboard), plus on the other top-level Producer functions (Permintaan
 *   Kunjungan, Live);
 * - a Place is a Place workspace: its ONE navigation layer is its four items
 *   (Informasi | Kegiatan | Media | Kelola Proses) and its ONE escape is
 *   "← Pengelola" to /producer — the global menu is never rendered inside it;
 * - /producer itself never links back to itself, but keeps the standard way
 *   back to the public home;
 * - each nested Producer surface keeps exactly ONE contextual back link;
 * - the legacy Place list/add routes stay pure redirects.
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
const placeWorkspace = stripComments(read("app/producer/places/[placeId]/PlaceWorkspace.tsx"));
const livePage = stripComments(read("app/producer/live/page.tsx"));
const inbox = stripComments(read("app/producer/visit-intents/Inbox.tsx"));
const inboxDetail = stripComments(read("app/producer/visit-intents/[id]/VisitIntentDetail.tsx"));
const placeDetailRoute = stripComments(read("app/producer/places/[placeId]/page.tsx"));
const experiencesRoute = stripComments(read("app/producer/places/[placeId]/experiences/page.tsx"));
const newExperience = stripComments(read("app/producer/places/[placeId]/experiences/new/page.tsx"));
const editExperience = stripComments(
  read("app/producer/places/[placeId]/experiences/[experienceId]/page.tsx"),
);
const productionRoute = stripComments(read("app/producer/places/[placeId]/production/page.tsx"));
const placesRedirect = stripComments(read("app/producer/places/page.tsx"));
const newPlaceRedirect = stripComments(read("app/producer/places/new/page.tsx"));
const onboarding = stripComments(read("app/producer/onboarding/page.tsx"));
const subNav = read("components/producer-sub-nav.tsx");

test("The main Producer page has no navigation back to itself", () => {
  // PERF/UX pass 2026-10-08: the dashboard page is a thin data loader and owns
  // NO chrome, so all of its presentation assertions moved to the workspace
  // component that actually renders them.
  assert.equal(dashboard.includes("ProducerSubNav"), false, "dashboard must not render the ProducerSubNav tabs itself");
  assert.equal(dashboard.includes("PageShell"), false, "the dashboard page must not declare a second shell");
  assert.equal(dashboard.includes("PageHeader"), false, "the dashboard page must not declare a second header");
  // The roster state (the Producer area root) is never a dead end — it offers
  // the standard way back to the public home (arrow-free, because a "←" on
  // this page would read as a self-link).
  assert.match(workspace, /href="\//, "the area root keeps a way back to the public home");
  assert.match(workspace, /Kembali ke Beranda/, "the way back is labelled as a way back");
  assert.equal(workspace.includes("Area Pengelola"), false, "the shortcut-card section is gone");
  // ...and the dashboard never links back to itself.
  assert.equal(workspace.includes('href="/producer"'), false, "the area root must not link to itself");
});

test("The global Producer menu is owned by one component and rendered at the area root", () => {
  assert.match(subNav, /aria-label="Navigasi Pengelola"/);
  // The shared nav is a PURE menu: it carries no escape link of its own, so
  // the way out is owned once by the page you are on instead of being repeated
  // on every Producer screen.
  assert.equal(
    subNav.includes("Kembali ke beranda"),
    false,
    "the shared nav must not carry a second escape link",
  );
  for (const [name, code] of [
    ["dashboard", dashboard],
    ["workspace", workspace],
    ["place workspace", placeWorkspace],
    ["live", livePage],
    ["inbox", inbox],
    ["inbox detail", inboxDetail],
  ] as const) {
    assert.equal(
      code.includes("Navigasi Pengelola"),
      false,
      `${name} must not re-declare the Producer menu markup`,
    );
  }
  // The pages that show the global menu reuse the SAME component.
  for (const [name, code] of [
    ["workspace roster", workspace],
    ["live", livePage],
    ["inbox", inbox],
  ] as const) {
    assert.match(code, /from "@\/components\/producer-sub-nav"/, `${name} must reuse the shared sub-nav`);
    assert.match(code, /<ProducerSubNav active="\/producer(\/(visit-intents|live))?" \/>/, `${name} must render the shared menu`);
  }
  // A Place workspace never renders the global menu: its ONE navigation layer
  // is its own four items.
  assert.equal(placeWorkspace.includes("ProducerSubNav"), false, "a Place must not render the global menu");
});

test("Visit Intent and Live stay reachable from the Producer area root", () => {
  // The dashboard page itself no longer links them; the shared menu rendered at
  // the area root does, and the routes themselves are untouched.
  assert.equal(dashboard.includes("/producer/visit-intents"), false);
  assert.equal(dashboard.includes("/producer/live"), false);
  assert.match(subNav, /href: "\/producer\/visit-intents"/);
  assert.match(subNav, /href: "\/producer\/live"/);
  // The global menu is rendered before the roster (it is the area menu, not a
  // second system beside it), and only once.
  assert.equal((workspace.match(/<ProducerSubNav/g) ?? []).length, 1);
  assert.ok(
    workspace.indexOf("<ProducerSubNav") < workspace.indexOf("Tempat yang Kamu Kelola"),
    "the area menu belongs above the roster",
  );
  // Inside a Place, the Producer's global functions are NOT listed.
  for (const label of ["Permintaan Kunjungan", "Live"]) {
    assert.ok(
      !placeWorkspace.includes(`label: "${label}"`),
      `the Place workspace must not list ${label} as a Place item`,
    );
  }
});

test("Top-level Producer pages return to the dashboard with one label", () => {
  for (const [name, code] of [
    ["live", livePage],
    ["permintaan kunjungan", inbox],
  ] as const) {
    assert.match(code, /href="\/producer"/, `${name} must link back to the dashboard`);
    assert.match(code, /← Pengelola/, `${name} must show the one contextual back link`);
    assert.equal(
      (code.match(/← /g) ?? []).length,
      1,
      `${name} must carry exactly one back link`,
    );
  }
});

test("The Place workspace has ONE escape route and ONE navigation layer", () => {
  // One contextual escape ("← Pengelola" → /producer)...
  assert.match(placeWorkspace, /href="\/producer"/);
  assert.match(placeWorkspace, /← Pengelola/);
  assert.equal(
    (placeWorkspace.match(/← /g) ?? []).length,
    2, // the link branch + the dashboard's in-place button branch, mutually exclusive
    "the workspace must carry exactly one back action",
  );
  // ...and one navigation layer: the four Place items, nothing else.
  for (const label of ["Informasi", "Kegiatan", "Media", "Kelola Proses"]) {
    assert.ok(placeWorkspace.includes(`label: "${label}"`), `the workspace must offer ${label}`);
  }
  assert.equal(placeWorkspace.includes("Kembali ke Tempat"), false);
  assert.equal(placeWorkspace.includes("← Dashboard Pengelola"), false);
  // Every Place entry route renders the SAME workspace (one context, no
  // stacked navigation layers).
  assert.match(placeDetailRoute, /<PlaceWorkspace placeId=\{placeId\} \/>/);
  assert.match(experiencesRoute, /<PlaceWorkspace placeId=\{placeId\} initialTab="experience" \/>/);
  assert.match(productionRoute, /<PlaceWorkspace placeId=\{placeId\} initialTab="production" \/>/);
  for (const [name, code] of [["place detail", placeDetailRoute], ["experiences route", experiencesRoute], ["production route", productionRoute]] as const) {
    assert.equal(code.includes("PageShell"), false, `${name} must not declare a second shell`);
    assert.equal(code.includes("Kembali ke"), false, `${name} must not add a second back link`);
  }
});

test("The dashboard's in-place Place editor returns to the roster", () => {
  // The in-place editor uses the SAME workspace and hands the ONE escape back
  // to the roster instead of a route.
  assert.match(workspace, /onBack=\{\(\) => setView\(\{ name: "list" \}\)\}/);
  assert.match(workspace, /Kembali ke Tempat/);
});

test("Kegiatan pages return to the Kegiatan item of the same Place", () => {
  for (const [name, code] of [
    ["new experience", newExperience],
    ["edit experience", editExperience],
  ] as const) {
    assert.match(code, /← Kembali ke Kegiatan/, name);
    assert.match(code, /`\/producer\/places\/\$\{placeId\}\/experiences`/);
    assert.equal(code.includes("← Dashboard Pengelola"), false, `${name} must not stack a second back link`);
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
  assert.equal(onboarding.includes("← Dashboard Pengelola"), false);
});
