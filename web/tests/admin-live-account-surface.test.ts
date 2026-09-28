import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * ADMIN SURFACE — Live inside the Place workspace, and the Account Center
 * cards (PO, 2026-09-28).
 *
 * These are placement rules, not behaviour rules, so they are locked at the
 * source level in the same style the repo already uses for surface tests: what
 * a page is allowed to show, and what it must stop showing.
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

const overviewPage = read("../app/admin/page.tsx");
const livePage = read("../app/admin/live/page.tsx");
const placeWorkspacePage = read("../app/admin/places/[placeId]/page.tsx");
const placeWorkspace = read("../lib/admin/place-workspace.ts");
const adminQueries = read("../lib/admin/queries.ts");
const accountPage = read("../app/account/page.tsx");

// ---------------------------------------------------------------------------
// 1. Live lives with the Place
// ---------------------------------------------------------------------------

test("the Place workspace shows that Place's Live sessions and reports, read-only", () => {
  // Sessions: session / status / waktu / proses. Reports: report / kategori /
  // waktu. Both are plain reads inside the existing workspace payload.
  assert.match(placeWorkspace, /liveSessions: AdminPlaceLiveSessionRow\[\]/);
  assert.match(placeWorkspace, /liveReports: AdminPlaceLiveReportRow\[\]/);
  assert.match(placeWorkspace, /\.eq\("place_id", id\)/);
  // A report is scoped through the Place's own sessions, so no Place can ever
  // surface another Place's reports.
  assert.match(placeWorkspace, /\.in\("live_session_id", sessionIds\)/);

  const page = stripComments(placeWorkspacePage);
  assert.match(page, /aria-label="Live"/);
  assert.match(page, /Live Session/);
  assert.match(page, /Live Report/);
  assert.match(page, /formatAdminTimestamp\(session\.startedAt\)/);
  assert.match(page, /formatAdminTimestamp\(report\.createdAt\)/);
  assert.match(page, /proses \(stage\)/);

  // Read-only: the workspace renders Live, it never acts on it. No Live
  // mutation route, RPC, or start/end control is added anywhere.
  assert.doesNotMatch(page, /fetch\(/);
  assert.doesNotMatch(page, /start_live_session|end_live_session|moderate_live/);
});

test("the Admin Overview has no Live Session or Live Report cards", () => {
  const page = stripComments(overviewPage);
  assert.doesNotMatch(page, /Live Sessions?/);
  assert.doesNotMatch(page, /Live Reports?/);
  assert.doesNotMatch(page, /liveSession|recentLiveSession|recentLiveReport/);
  // The Overview keeps the platform counts it is for.
  assert.match(page, /label: "Tempat"/);
  // And the query no longer computes what the page must not show.
  const queries = stripComments(adminQueries);
  assert.doesNotMatch(queries, /recentLiveSessions|recentLiveReports/);
  assert.doesNotMatch(queries, /countRows\("live_sessions"\)/);
  assert.doesNotMatch(queries, /countRows\("live_reports"\)/);
});

test("the Admin Overview carries no Kunjungan — counts only, no row reads", () => {
  // PO, 2026-09-28: the Kunjungan stat and the "Kunjungan terbaru" table are
  // gone from the Overview; /admin/visit-intents owns that data. The Overview
  // is a totals screen and must stay one.
  const page = stripComments(overviewPage);
  // No Kunjungan STAT CARD and no Kunjungan TABLE — the word may appear only
  // as the pointer to the tab that owns the data.
  assert.doesNotMatch(page, /label: "Kunjungan"/);
  assert.doesNotMatch(page, /aria-label="Kunjungan/);
  assert.doesNotMatch(page, /recentVisitIntents|visitIntent/);
  assert.doesNotMatch(page, /AdminDataTable/);

  const queries = stripComments(adminQueries);
  assert.doesNotMatch(queries, /listRecentVisitIntents/);
  assert.doesNotMatch(queries, /countRows\("visit_intents"\)/);
  assert.doesNotMatch(queries, /visitIntents: number/);
  // The Overview still counts what it exists to count.
  assert.match(queries, /countRows\("users"\)/);
  assert.match(queries, /countRows\("places"\)/);
  assert.match(queries, /countRows\("experiences"\)/);
  // The Kunjungan system itself is untouched: the Admin list page and its
  // read both remain.
  const visitPage = read("../app/admin/visit-intents/page.tsx");
  assert.match(visitPage, /listAdminVisitIntents/);
  assert.match(queries, /export async function listAdminVisitIntents/);
});

test("/admin/live is a read-only report queue outside the Place workspace", () => {
  const page = stripComments(livePage);
  // No Live Session table and no Live summary cards remain here.
  assert.doesNotMatch(page, /listAdminLiveSessions/);
  assert.doesNotMatch(page, /Ringkasan Live/);
  assert.doesNotMatch(page, /aria-label="Live Sessions"/);
  // What remains: the read-only reports, and the eligibility table the
  // existing RPC-gated grant / revoke flow depends on.
  assert.match(page, /listAdminLiveReports/);
  assert.match(page, /aria-label="Live Report"/);
  assert.match(page, /listAdminEligibility/);
  // Observing, not mutating.
  assert.doesNotMatch(page, /fetch\(|start_live_session|end_live_session|moderate_live/);
  // The report query itself is unchanged and read-only.
  assert.match(stripComments(adminQueries), /export async function listAdminLiveReports/);
});

// ---------------------------------------------------------------------------
// 3. Account Center
// ---------------------------------------------------------------------------

test("the Account Center cards carry no role-specific heading", () => {
  const page = stripComments(accountPage);
  for (const heading of ["Pengelola Dashboard", "Admin Center", "Developer Center"]) {
    assert.equal(page.includes(heading), false, `${heading} must not be a card heading`);
  }
  // A card is a short description plus the link — nothing else.
  assert.doesNotMatch(page, /eyebrow/);
  assert.doesNotMatch(page, /<h2 className="text-lg/);
  assert.match(page, /<p className="text-sm leading-6 text-black\/70">\{description\}<\/p>/);
  assert.match(page, /group-hover:translate-x-0\.5/);

  // No function is removed: every area the account holds is still offered at
  // the same href, and the server-side authority probe is untouched.
  for (const href of ["/producer", "/admin", "/developer"]) {
    assert.match(page, new RegExp(`href: "${href.replace("/", "\\/")}"`));
    assert.match(page, new RegExp(`href=\\{href\\}`));
  }
  assert.match(page, /authority\.isProducer/);
  assert.match(page, /authority\.isPlatformAdmin/);
  assert.match(page, /authority\.isCreator/);
  // The account email still shows, as before.
  assert.match(page, /Masuk sebagai/);
  assert.match(page, /authority\.email/);

  // PO fix 2026-09-28: the surface is named Account Center — the same term
  // the account menu entry that opens it uses. No second naming, no new
  // account system: structure, probe, and links are untouched.
  assert.match(page, /Account Center/);
  assert.doesNotMatch(page, /Area akun/);
  assert.match(page, /Kembali ke Beranda|← Beranda/);
});
