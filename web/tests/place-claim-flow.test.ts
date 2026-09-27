import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  PLACE_CLAIM_EVIDENCE_ACCEPTED_TYPES,
  PLACE_CLAIM_EVIDENCE_BUCKET,
  PLACE_CLAIM_EVIDENCE_MAX_BYTES,
  PlaceClaimError,
  normalizePlaceClaimNote,
  placeClaimErrorStatus,
  validatePlaceClaimEvidence,
} from "../lib/place-claim";
import { parsePlaceMutation } from "../lib/place-management";

/**
 * Application-layer regression for "Klaim Place yang Sudah Ada".
 *
 * The engine-level semantics live in tests/place-claim-migration.test.ts
 * (migration 0028 on a real Postgres engine). This file covers the layers
 * above it — the HTTP routes, the server service, the private storage module
 * and the two UI surfaces — against the same locked requirements, so a rule
 * cannot be satisfied in SQL and then undone by the application.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const claimContract = read("../lib/place-claim.ts");
const claimStorage = read("../lib/place-claim-storage.ts");
const claimService = read("../lib/producer/place-claim.ts");
const producerClaimRoute = read("../app/api/producer/place-claims/route.ts");
const claimablePlacesRoute = read("../app/api/producer/place-claims/claimable-places/route.ts");
const producerEvidenceRoute = read("../app/api/producer/place-claims/[claimId]/evidence/route.ts");
const adminClaimRoute = read("../app/api/admin/place-claims/route.ts");
const adminEvidenceRoute = read("../app/api/admin/place-claims/[claimId]/evidence/route.ts");
const claimPanel = read("../app/producer/places/PlaceClaimPanel.tsx");
const claimManager = read("../app/admin/places/PlaceClaimsManager.tsx");
const placeWorkspace = read("../app/producer/places/ProducerPlaceWorkspace.tsx");
const createPlaceRoute = read("../app/api/producer/places/route.ts");
const adminPlacesPage = read("../app/admin/places/page.tsx");

// --- 4 (API level) — proof of ownership is mandatory ---------------------

test("4. the claim API refuses a submission with no proof, before anything is uploaded", () => {
  assert.match(producerClaimRoute, /form\.get\("file"\)/, "the route reads the uploaded file");
  assert.match(
    producerClaimRoute,
    /!\(file instanceof File\)[\s\S]{0,120}place_claim_evidence_required/,
    "a missing file is a hard rejection, not a warning",
  );
  // The file gate runs before the service call, so nothing is stored.
  const fileGate = producerClaimRoute.indexOf('form.get("file")');
  const submit = producerClaimRoute.indexOf("submitPlaceClaim(");
  assert.ok(fileGate > -1 && submit > fileGate, "the evidence check precedes the submit call");

  // Server-side type/size gate (never only in the browser).
  assert.throws(
    () => validatePlaceClaimEvidence({ type: "text/html", size: 1024 }),
    (error: unknown) => error instanceof PlaceClaimError && error.code === "place_claim_evidence_type_invalid",
  );
  assert.throws(
    () => validatePlaceClaimEvidence({ type: "application/pdf", size: PLACE_CLAIM_EVIDENCE_MAX_BYTES + 1 }),
    (error: unknown) => error instanceof PlaceClaimError && error.code === "place_claim_evidence_size_invalid",
  );
  assert.throws(
    () => validatePlaceClaimEvidence({ type: "application/pdf", size: 0 }),
    (error: unknown) => error instanceof PlaceClaimError && error.code === "place_claim_evidence_size_invalid",
  );
  validatePlaceClaimEvidence({ type: "application/pdf", size: 1024 });
  assert.ok(PLACE_CLAIM_EVIDENCE_ACCEPTED_TYPES.includes("application/pdf"), "PDF proof is accepted");
  assert.match(claimService, /validatePlaceClaimEvidence\(params\.file\)/, "the service re-validates server-side");
});

test("the claim form requires the evidence input in the browser too", () => {
  assert.match(claimPanel, /type="file"/);
  assert.match(claimPanel, /required/, "the proof input is required");
});

// --- 1 / 2 (API level) — the unowned-only filter is server-side ----------

test("1/2. the unowned-only filter lives in the database, not in the browser or the route", () => {
  // The list route is a thin pass-through: it holds no ownership logic.
  assert.match(claimablePlacesRoute, /listClaimablePlaces\(\)/);
  assert.doesNotMatch(claimablePlacesRoute, /\.filter\(/, "the route must not filter client-supplied lists");
  assert.doesNotMatch(claimablePlacesRoute, /producer_memberships|producer_id/, "no ownership logic in the route");

  // The service reads the database function and nothing else.
  assert.match(claimService, /rpc\("list_claimable_places"\)/);
  assert.doesNotMatch(claimService, /\.from\("places"\)/, "the claim list is not assembled from a raw table read");

  // The browser never computes ownership either.
  assert.doesNotMatch(claimPanel, /producer_memberships/, "the Producer UI holds no ownership data");

  // A direct API claim of an owned Place is refused by the server gate.
  assert.match(claimService, /rpc\("submit_place_claim"/);
  assert.match(claimService, /place_already_owned/);
  assert.equal(placeClaimErrorStatus("place_already_owned"), 409, "an owned Place is a state conflict");
  assert.equal(placeClaimErrorStatus("place_claim_evidence_required"), 400);
  assert.equal(placeClaimErrorStatus("place_claim_not_pending"), 409);
});

// --- 5 — evidence is private ---------------------------------------------

test("5. claim evidence is private: no public URL, no client bucket access, short-lived signed links only", () => {
  assert.equal(PLACE_CLAIM_EVIDENCE_BUCKET, "place-claim-evidence");
  assert.notEqual(PLACE_CLAIM_EVIDENCE_BUCKET, "place-media", "the public media bucket is not reused for evidence");

  // No public-object URL may exist anywhere in the claim surface.
  for (const [name, source] of [
    ["storage", claimStorage],
    ["service", claimService],
    ["producer route", producerClaimRoute],
    ["admin route", adminClaimRoute],
  ] as const) {
    assert.doesNotMatch(source, /getPublicUrl/, `${name} must not build a public object URL`);
    assert.doesNotMatch(source, /\/object\/public\//, `${name} must not reference a public object path`);
  }

  // Access is a short-lived signed URL, minted server-side only.
  assert.match(claimStorage, /import "server-only"/);
  assert.match(claimStorage, /createSignedUrl\(storagePath, PLACE_CLAIM_EVIDENCE_URL_TTL_SECONDS\)/);
  assert.match(claimStorage, /PLACE_CLAIM_EVIDENCE_URL_TTL_SECONDS = 300/);
  assert.match(claimStorage, /createSupabaseServiceClient/, "storage access is service-role only");
  assert.match(claimStorage, /cacheControl: "0"/, "personal documents are not cached");
  assert.doesNotMatch(claimStorage, /NEXT_PUBLIC_/, "no client-visible storage configuration");

  // The claim row stores the object reference, never the file itself.
  assert.doesNotMatch(claimService, /base64|data:/, "no binary is inlined into the claim record");
});

// --- 6 — one Producer cannot read another's evidence ---------------------

test("6. evidence access is scoped: a Producer only ever reaches their own claim", () => {
  // The service scopes the lookup by the account id, not just by claim id.
  assert.match(
    claimService,
    /\.from\("place_claims"\)[\s\S]{0,200}?\.eq\("id", claimId\)[\s\S]{0,120}?\.eq\("user_id", userId\)/,
    "the evidence lookup filters on the caller",
  );
  assert.match(claimService, /rpc\("list_user_place_claims", \{\s*p_user_id: userId/);

  // The route takes the identity from the session only.
  assert.match(producerEvidenceRoute, /requireAuthenticatedActor\(request\)/);
  assert.match(producerEvidenceRoute, /createUserPlaceClaimEvidenceUrl\(actor\.userId, claimId\)/);
  assert.doesNotMatch(producerEvidenceRoute, /body\.|userId.*request|request\.(json|formData)/,
    "identity is never taken from the request");

  // A claim that is not the caller's is reported as not found.
  assert.match(producerEvidenceRoute, /place_claim_not_found/);

  // The Admin path is moderator-guarded; Producers are not let in.
  assert.match(adminEvidenceRoute, /requirePlatformModerator\(\)/);
  assert.match(adminClaimRoute, /requirePlatformModerator\(\)/);
});

// --- 7 / 8 / 9 / 10 — ownership only through approval --------------------

test("7/8. filing a claim grants nothing: the submit path never touches ownership", () => {
  assert.doesNotMatch(claimService, /from\("producer_memberships"\)|rpc\("grant/, "the service writes no membership row");
  assert.doesNotMatch(claimStorage, /producer_memberships/);
  // Only the database review function grants ownership.
  assert.match(claimService, /rpc\("review_place_claim"/);
  assert.doesNotMatch(producerClaimRoute, /review_place_claim/, "a Producer cannot review their own claim");
  assert.match(producerClaimRoute, /status: "pending"/, "a filed claim is reported as pending");
});

test("9/10. approval is an explicit Admin decision, and the review RPC is the only ownership path", () => {
  assert.match(adminClaimRoute, /decision === "approved" \|\| body\.decision === "rejected"/,
    "only these two decisions are accepted");
  assert.doesNotMatch(adminClaimRoute, /body\.role/, "a claim approval cannot pick an arbitrary role");

  // Nothing is auto-approved: the initial load is a read, and a decision is
  // only ever taken from an explicit click.
  const initialLoad = claimManager.indexOf('fetch("/api/admin/place-claims")');
  const postCall = claimManager.indexOf('method: "POST"');
  assert.ok(initialLoad > -1 && postCall > initialLoad, "the panel loads read-only first");
  const loadBody = claimManager.slice(initialLoad, initialLoad + 120);
  assert.doesNotMatch(loadBody, /method: "POST"/, "loading the queue never decides anything");
  assert.match(claimManager, /onClick=\{\(\) => void review\(claim\.id, "approved"\)\}/);
  assert.match(claimManager, /onClick=\{\(\) => void review\(claim\.id, "rejected"\)\}/);
  // Re-deciding a processed claim is refused, so approval happens once.
  assert.equal(placeClaimErrorStatus("place_claim_not_pending"), 409);
});

test("the Admin review queue shows everything needed to assess a claim", () => {
  for (const field of ["placeName", "category", "type", "userId", "createdAt", "status", "evidenceFileName"]) {
    assert.ok(claimManager.includes(field), `the review queue must surface ${field}`);
  }
  // Canonical category/type are shown read-only, never editable here.
  assert.doesNotMatch(claimManager, /setCategory|setType|onCategoryChange/);
});

// --- no Place is created or changed by a claim ---------------------------

test("claiming never creates a Place and never changes the canonical category", () => {
  assert.doesNotMatch(claimService, /\.from\("places"\)\s*\.(insert|update|upsert|delete)/,
    "the claim path writes nothing to places");
  assert.doesNotMatch(claimService, /(?<![\w.])createPlace\(|insertPlace/);

  // The claim form has no category/type control, and sends no category.
  const sent = [...claimPanel.matchAll(/form\.set\("([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sent.sort(), ["file", "note", "placeId"], "the claim submits only placeId, file and note");
  assert.doesNotMatch(claimPanel, /<select[^>]*category|name="category"/i, "no category selector on the claim form");
  // The canonical values are displayed, not chosen.
  assert.match(claimPanel, /selected\.category/);
  assert.match(claimPanel, /selected\.type/);

  // The claim entry point is clearly separate from "add Place".
  assert.match(placeWorkspace, /Klaim Place yang Sudah Ada/);
  assert.match(placeWorkspace, /\{ name: "claim" \}/);
  assert.match(placeWorkspace, /Tambahkan Place baru/);
});

// --- 12 / 13 — existing flows and authorization are untouched -----------

test("12. the existing Create Place flow is untouched by the claim feature", () => {
  assert.doesNotMatch(createPlaceRoute, /claim/i, "the create-place route has no claim logic");
  assert.match(createPlaceRoute, /requireProducerOwner\(request\)/, "it keeps its existing authorization");
  assert.match(createPlaceRoute, /repository\.create\(mutation, actor\.producerId/);

  // The existing input gate still behaves exactly as before.
  const valid = {
    name: "Place Baru", shortDescription: "Cerita lokal", category: "Kopi", type: "production",
    area: "Bandung", address: "Jalan Lokal 1", timezone: "Asia/Jakarta", currency: "idr",
    latitude: -6.9, longitude: 107.6,
  };
  assert.equal(parsePlaceMutation(valid).currency, "IDR");
  assert.throws(() => parsePlaceMutation({ ...valid, producerId: "other" }), /producer_id_not_allowed/);
  assert.throws(() => parsePlaceMutation({ ...valid, category: "Other" }), /place_type_or_category_invalid/);
});

test("13. existing Producer authorization patterns are reused, and every claim surface is authenticated", () => {
  // Producer routes authenticate through the existing helper.
  assert.match(producerClaimRoute, /requireAuthenticatedActor\(request\)/);
  assert.match(claimablePlacesRoute, /requireAuthenticatedActor\(request\)/);
  assert.match(producerEvidenceRoute, /requireAuthenticatedActor\(request\)/);
  // The claimant identity is always the session's, never request input.
  assert.match(producerClaimRoute, /submitPlaceClaim\(\{\s*userId: actor\.userId/);
  assert.doesNotMatch(producerClaimRoute, /body\.userId|form\.get\("userId"\)|form\.get\("producerId"\)/);

  // Every failure path returns a closed response, never a silent success.
  for (const [name, source] of [
    ["producer claims", producerClaimRoute],
    ["claimable places", claimablePlacesRoute],
  ] as const) {
    assert.match(source, /status: 401/, `${name} rejects anonymous callers`);
    assert.doesNotMatch(source, /catch \(\) \{\s*return NextResponse\.json\(\{ ok: true/, `${name} never swallows errors`);
  }
  // The Admin surface follows the existing convention: 403 for anyone who is
  // not a Platform Moderator (same as the Producer applications API).
  assert.match(adminClaimRoute, /status: 403/, "admin claims refuse non-moderators");
  assert.match(adminClaimRoute, /admin_required/);
  assert.doesNotMatch(adminClaimRoute, /status: 401/, "the admin API never leaks a 401 distinction");

  // The Admin review surface is mounted on the EXISTING admin page — no new
  // admin area, and the admin layout guard still applies.
  assert.match(adminPlacesPage, /PlaceClaimsManager/);
  assert.doesNotMatch(adminPlacesPage, /requirePlatformModerator\(\)\s*\{/, "the page keeps using the layout guard");
});

test("claim notes are bounded and normalized on the server", () => {
  assert.equal(normalizePlaceClaimNote(null), null);
  assert.equal(normalizePlaceClaimNote("  spaced  "), "spaced");
  assert.equal(normalizePlaceClaimNote("   "), null);
  assert.throws(
    () => normalizePlaceClaimNote("x".repeat(1001)),
    (error: unknown) => error instanceof PlaceClaimError && error.code === "place_claim_note_invalid",
  );
  assert.match(claimService, /normalizePlaceClaimNote/, "notes are validated in the service, not only the form");
});
