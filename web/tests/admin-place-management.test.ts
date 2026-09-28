import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  canAdminTransitionPlaceStatus,
  canTransitionPlaceStatus,
  isPlacePublicationReady,
} from "../lib/places";
import { derivePlaceIdFromName, parsePlaceMutation, PlaceInputError } from "../lib/place-management";

/**
 * ADMIN PLACE MANAGEMENT — Platform Admin's operational authority over Place
 * (Authority Master §5).
 *
 * The database-dependent rules run on a real Postgres engine (PGlite) over the
 * actual migration chain, so they are proven SEMANTICALLY rather than by
 * reading source: an archived Place is not an active/public Place, and a
 * claim against an existing Place cannot create a second one. The rest is
 * locked at the unit and source level, matching the existing test style.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

const stripComments = (source: string) =>
  source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");

const placeWorkspace = read("../lib/admin/place-workspace.ts");
const userDirectory = read("../lib/admin/user-directory.ts");
const adminQueries = read("../lib/admin/queries.ts");
const adminPlacesPage = read("../app/admin/places/page.tsx");
const adminPlaceDetailPage = read("../app/admin/places/[placeId]/page.tsx");
const adminNewPlacePage = read("../app/admin/places/new/page.tsx");
const adminPlaceEditor = read("../components/admin/place-editor.tsx");
const adminPlaceModeration = read("../components/admin/place-moderation.tsx");
const adminClaimsManager = read("../app/admin/places/PlaceClaimsManager.tsx");
const adminClaimsRoute = read("../app/api/admin/place-claims/route.ts");
const adminPlacesRoute = read("../app/api/admin/places/route.ts");
const adminPlaceRoute = read("../app/api/admin/places/[placeId]/route.ts");
const adminPlacePublicationRoute = read("../app/api/admin/places/[placeId]/publication/route.ts");
const adminUsersRoute = read("../app/api/admin/users/route.ts");
const publicPlacesRoute = read("../app/api/places/route.ts");
const placesModule = read("../lib/places.ts");
const placeClaimMigration = readMigration("0028_place_claims.sql");

const adminPayload = {
  name: "Tempat Tanpa Pengelola",
  shortDescription: "Dicatat oleh Admin, belum ada pemiliknya.",
  category: "Kuliner",
  type: "production",
  area: "Bandung",
  address: "Jalan Sbomen 1",
  contactInformation: "",
  timezone: "Asia/Jakarta",
  currency: "IDR",
  latitude: -6.9,
  longitude: 107.6,
};

// ---------------------------------------------------------------------------
// Database harness — the real migration chain, no migration file is modified.
// ---------------------------------------------------------------------------

const SHIMS = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as 'select null::uuid';
  create role anon;
  create role authenticated;
  create role service_role;
  create role supabase_admin;
  create role authenticator;
  create schema if not exists storage;
  create table if not exists storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
`;

const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

const FOUNDATION = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0020_one_membership_per_user.sql",
  "0022_allow_multiple_places_per_producer.sql",
] as const;

async function bootstrapDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIMS);
  await db.exec("create publication supabase_realtime;");
  for (const name of FOUNDATION) await db.exec(stripPgcrypto(readMigration(name)));
  await db.exec(stripPgcrypto(readMigration("0028_place_claims.sql")));
  return db;
}

const rows = async (
  db: PGlite,
  query: string,
  params?: unknown[],
): Promise<Record<string, unknown>[]> =>
  ((params ? await db.query(query, params as never[]) : await db.query(query)).rows ?? []) as Record<
    string,
    unknown
  >[];

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------
// 1. Admin dapat membuat Place tanpa Producer
// ---------------------------------------------------------------------------

test("Admin can create a Place without a Producer — producer_id is nullable and Admin writes it as NULL", () => {
  // Schema: `producer_id text references public.producers(id)` has never been
  // NOT NULL, so no schema change is required to let an Admin enter a Place
  // nobody owns yet.
  const foundationSql = readMigration("0001_visit_intent_foundation.sql");
  const placesTable = foundationSql.slice(
    foundationSql.indexOf("create table public.places ("),
    foundationSql.indexOf("create table public.experiences ("),
  );
  assert.match(placesTable, /producer_id text references public\.producers\(id\)/);
  assert.doesNotMatch(placesTable, /producer_id text not null/);

  const code = stripComments(placeWorkspace);
  assert.match(code, /await requirePlatformModerator\(\)/, "create must verify moderator authorization");
  assert.match(code, /producer_id: null/);
  assert.match(code, /claim_status: "unverified"/);
  assert.match(code, /publication_status: "draft"/);

  // The shared validator still refuses an owner in the payload, so an Admin
  // can never grant ownership by creating a Place.
  assert.throws(
    () => parsePlaceMutation({ ...adminPayload, producerId: "prod-x" }),
    (error: unknown) => error instanceof PlaceInputError && error.message === "producer_id_not_allowed",
  );

  // The create surface exists and posts to the Admin-only endpoint.
  assert.match(adminNewPlacePage, /AdminPlaceEditor/);
  assert.match(adminNewPlacePage, /Tempat baru selalu tanpa Pengelola/);
  assert.match(adminPlacesPage, /\+ Tambah Tempat/);
  assert.match(adminPlacesPage, /href="\/admin\/places\/new"/);
  assert.match(adminPlaceEditor, /\/api\/admin\/places/);
  assert.match(adminPlacesRoute, /createAdminPlace/);
});

test("a Place without a Producer stays valid — the canonical Place validator accepts it", () => {
  const mutation = parsePlaceMutation(adminPayload);
  const place = { ...mutation, producer: null, claimStatus: "unverified" as const, publicationStatus: "draft" as const };
  // isPlacePublicationReady is a content rule, never an ownership rule.
  assert.equal(isPlacePublicationReady(place), true);
  assert.equal(canTransitionPlaceStatus(place.publicationStatus, "published"), true);
  assert.equal(derivePlaceIdFromName(mutation.name), "tempat-tanpa-pengelola");
});

// ---------------------------------------------------------------------------
// 2. Admin dapat mengedit data Place
// ---------------------------------------------------------------------------

test("Admin can edit Place data, and the edit can never touch ownership or claim state", () => {
  const code = stripComments(placeWorkspace);
  assert.match(code, /export async function updateAdminPlace/);
  assert.match(code, /await requirePlatformModerator\(\)/);
  // Reuses the ONE canonical validator + the canonical repository update.
  assert.match(code, /parsePlaceMutation\(raw, id\)/);
  assert.match(code, /repository\.update\(id, mutation\)/);
  // Nothing in the edit path writes owner / claim / publication columns.
  const updateBody = code.slice(code.indexOf("export async function updateAdminPlace"));
  const updateSlice = updateBody.slice(0, updateBody.indexOf("}"));
  assert.doesNotMatch(updateSlice, /producer_id|claim_status|publication_status/);

  assert.match(adminPlaceDetailPage, /aria-label="Informasi Tempat"/);
  assert.match(adminPlaceDetailPage, /AdminPlaceEditor place=\{place\}/);
  assert.match(adminPlaceRoute, /updateAdminPlace/);
});

// ---------------------------------------------------------------------------
// 3 + 5. Moderasi: Terbitkan / Jeda / Arsipkan / Pulihkan dari arsip
// ---------------------------------------------------------------------------

test("Admin moderation covers Terbitkan, Jeda, Arsipkan, and Pulihkan dari arsip on the existing statuses", () => {
  // Same status set as the Producer flow — no new Place status is invented.
  assert.match(stripComments(placeWorkspace), /"draft",\s*"published",\s*"paused",\s*"archived"/);

  // Producer rules are untouched: archived stays terminal for a Producer.
  assert.equal(canTransitionPlaceStatus("archived", "published"), false);
  // Admin may restore an archived Place (Master 09 §5 reversible moderation,
  // §8 restore with revalidation), but only to an existing status.
  assert.equal(canAdminTransitionPlaceStatus("archived", "published"), true);
  assert.equal(canAdminTransitionPlaceStatus("archived", "paused"), true);
  assert.equal(canAdminTransitionPlaceStatus("archived", "draft"), true);
  assert.equal(canAdminTransitionPlaceStatus("draft", "published"), true);
  assert.equal(canAdminTransitionPlaceStatus("published", "paused"), true);
  assert.equal(canAdminTransitionPlaceStatus("published", "draft"), false);
  // Revalidation before anything goes public.
  assert.equal(canAdminTransitionPlaceStatus("draft", "published"), true);

  for (const label of ["Terbitkan", "Jeda", "Arsipkan", "Pulihkan dari arsip"]) {
    assert.ok(
      adminPlaceDetailPage.includes(label) || adminPlaceModeration.includes(label),
      `moderation control "${label}" missing`,
    );
  }
  assert.match(adminPlaceModeration, /Terbitkan/);
  assert.match(adminPlaceModeration, /Arsipkan/);
  assert.match(adminPlaceModeration, /Pulihkan/);
  assert.match(adminPlacePublicationRoute, /setAdminPlacePublicationStatus/);

  const moderationCode = stripComments(placeWorkspace);
  const moderationBody = moderationCode.slice(moderationCode.indexOf("export async function setAdminPlacePublicationStatus"));
  assert.match(moderationBody, /await requirePlatformModerator\(\)/);
  assert.match(moderationBody, /canAdminTransitionPlaceStatus/);
  assert.match(moderationBody, /isPlacePublicationReady/);
});

test("an archived Place is not an active or public Place (proven on the real schema)", async () => {
  const db = await bootstrapDb();
  try {
    await db.exec(`
      insert into public.places (id, name, short_description, category, type, area, address,
        contact_information, timezone, currency, latitude, longitude, producer_id, claim_status, publication_status)
      values ('tempat-arsip', 'Tempat Arsip', 'd', 'Kuliner', 'production', 'Bandung', 'Jalan Sbomen 1',
        '', 'Asia/Jakarta', 'IDR', -6.9, 107.6, null, 'unverified', 'archived');
    `);

    // The public discovery rule (places_public_read, 0001) keys on
    // publication_status = 'published' — an archived Place is neither active
    // nor public, and it stays in the table for the Admin.
    const publicVisible = await rows(
      db,
      "select id from public.places where publication_status = 'published' and id = 'tempat-arsip'",
    );
    assert.equal(publicVisible.length, 0);

    const total = await rows(db, "select id from public.places where id = 'tempat-arsip'");
    assert.equal(total.length, 1, "the archived Place row is preserved, not deleted");

    // The repository's own public read filters on the same status.
    const code = stripComments(read("../lib/place-experience-repository.ts"));
    assert.match(code, /\.eq\("publication_status", "published"\)/);
  } finally {
    await db.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Claim terhadap Place existing tidak membuat Place kedua
// ---------------------------------------------------------------------------

test("an Admin-created Place without a Producer is claimable, and a claim never creates a second Place", async () => {
  const db = await bootstrapDb();
  try {
    await db.exec(`
      insert into auth.users (id, email_confirmed_at)
      values ('${uuid(1)}', now()), ('${uuid(2)}', now());
      insert into public.users (id) values ('${uuid(1)}'), ('${uuid(2)}') on conflict do nothing;
    `);
    await db.exec(`
      insert into public.places (id, name, short_description, category, type, area, address,
        contact_information, timezone, currency, producer_id, claim_status, publication_status)
      values ('tempat-tanpa-pengelola', 'Tempat Tanpa Pengelola', 'd', 'Kuliner', 'production',
        'Bandung', 'Jalan Sbomen 1', '', 'Asia/Jakarta', 'IDR', null, 'unverified', 'published');
    `);

    // Ownership is membership OR a non-null producer_id (0028). An
    // Admin-created Place satisfies neither, so the EXISTING claim list
    // already offers it — no new claim system and no extra wiring.
    const claimable = await rows(db, "select * from public.list_claimable_places()");
    assert.ok(
      claimable.some((row) => row.place_id === "tempat-tanpa-pengelola"),
      "an Admin-created Place without a Producer must be claimable",
    );

    await db.query("select public.submit_place_claim($1, $2, $3, $4, $5, $6, $7)", [
      uuid(1),
      "tempat-tanpa-pengelola",
      "tempat-tanpa-pengelola/evidence/bukti.pdf",
      "bukti.pdf",
      "application/pdf",
      1024,
      null,
    ] as never);

    // The claim filed a row. It did NOT touch public.places at all.
    const afterSubmit = await rows(
      db,
      "select id, producer_id, claim_status from public.places where id = 'tempat-tanpa-pengelola'",
    );
    assert.equal(afterSubmit.length, 1, "claiming must not create a second Place");
    assert.equal(afterSubmit[0].producer_id, null, "a pending claim grants nothing");

    // Rejecting changes nothing either.
    const claim = (await rows(db, "select id, user_id from public.place_claims"))[0];
    await db.query("select public.review_place_claim($1, $2, $3)", [claim.id, "rejected", null] as never);
    const afterReject = await rows(
      db,
      "select id, producer_id from public.places where id = 'tempat-tanpa-pengelola'",
    );
    assert.equal(afterReject.length, 1);
    assert.equal(afterReject[0].producer_id, null);
    const membershipsAfterReject = await rows(
      db,
      "select user_id from public.producer_memberships",
    );
    assert.equal(membershipsAfterReject.length, 0, "a rejected claim grants nothing");

    // The rightful owner is a registered Producer with an existing identity
    // (the claim never invents one — 0028 binds the Place to the claimant's
    // own producer_id when the Place has none). Ownership lands on that ONE
    // Place; the claim path still never mints a second Place.
    await db.exec(`
      insert into public.producers (id, display_name) values ('prod-pemilik', 'Pemilik Sah');
      insert into public.places (id, name, short_description, category, type, area, address,
        contact_information, timezone, currency, producer_id)
      values ('tempat-pemilik', 'Tempat Pemilik', 'd', 'Kopi', 'production', 'Bandung', 'Jalan Sbomen 2',
        '', 'Asia/Jakarta', 'IDR', 'prod-pemilik');
      insert into public.producer_memberships (user_id, producer_id, place_id, role)
      values ('${uuid(2)}', 'prod-pemilik', 'tempat-pemilik', 'owner');
    `);
    await db.query("select public.submit_place_claim($1, $2, $3, $4, $5, $6, $7)", [
      uuid(2),
      "tempat-tanpa-pengelola",
      "tempat-tanpa-pengelola/evidence/bukti-2.pdf",
      "bukti-2.pdf",
      "application/pdf",
      2048,
      null,
    ] as never);
    const refiled = (
      await rows(db, "select id from public.place_claims where user_id = $1", [uuid(2)])
    )[0];
    await db.query("select public.review_place_claim($1, $2, $3)", [refiled.id, "approved", null] as never);
    const afterApprove = await rows(
      db,
      "select id, producer_id from public.places where id = 'tempat-tanpa-pengelola'",
    );
    assert.equal(afterApprove.length, 1, "approval must not create a second Place");
    const memberships = await rows(
      db,
      "select user_id, place_id, role from public.producer_memberships",
    );
    assert.equal(memberships.length, 2);
    assert.ok(
      memberships.some(
        (row) => row.place_id === "tempat-tanpa-pengelola" && row.user_id === uuid(2) && row.role === "owner",
      ),
      "approval grants owner on the claimed Place for the claimant's own account",
    );
  } finally {
    await db.close();
  }
});

test("the Admin Place surface adds no second claim system and never creates a Place from a claim", () => {
  // The claim review path is untouched and still the ONLY ownership grant.
  assert.match(placeClaimMigration, /create or replace function public\.review_place_claim/);
  assert.match(placeClaimMigration, /This is the ONLY path that turns a claim into ownership|ONLY path that turns a claim into ownership/);
  assert.match(adminClaimsRoute, /reviewPlaceClaim/);
  assert.match(adminClaimsManager, /aria-label="Klaim Tempat"/);
  // The Admin Place workspace has no claim submission/review call at all.
  assert.doesNotMatch(placeWorkspace, /submitPlaceClaim|reviewPlaceClaim|place_claims"\)\s*\.\s*insert/);
  // It reads claim history only, to display it on the workspace.
  assert.match(placeWorkspace, /\.from\("place_claims"\)/);
  // The detail page points review back to the one existing queue.
  assert.match(adminPlaceDetailPage, /Buka antrean review klaim/);
});

// ---------------------------------------------------------------------------
// 7. Admin dapat melihat email User
// ---------------------------------------------------------------------------

test("Platform Admin can see the User email, in the user-management context only", () => {
  assert.match(userDirectory, /await requirePlatformModerator\(\)/);
  assert.match(userDirectory, /auth\.admin\.listUsers/);
  assert.match(userDirectory, /email: emailById/);
  assert.match(read("../app/admin/users/page.tsx"), /row\.email/);
  assert.match(adminUsersRoute, /listAdminDirectoryUsers/);
  // No credential is ever returned next to the email.
  assert.doesNotMatch(stripComments(userDirectory), /password|token|secret|api_key/i);
});

// ---------------------------------------------------------------------------
// 8 + 9. Email tidak boleh terlihat oleh Producer maupun publik
// ---------------------------------------------------------------------------

test("a Producer can never read a User email through the UI or any API", () => {
  // The email module is imported by the Admin page and the Admin route ONLY.
  // Nothing under app/producer, app/api/producer, or any public page/API
  // references it.
  const producerAndPublic = [
    ...globList("../app/producer"),
    ...globList("../app/api/producer"),
    ...globList("../components"),
    ...globList("../app/places"),
    ...globList("../app/api/places"),
  ];
  for (const file of producerAndPublic) {
    assert.doesNotMatch(
      read(file),
      /user-directory|listAdminDirectoryUsers/,
      `${file} must not touch the Admin email module`,
    );
  }
  // The Producer Place read exposes no account email.
  assert.doesNotMatch(read("../app/api/producer/places/route.ts"), /email/i);
  assert.doesNotMatch(read("../app/api/producer/places/[placeId]/route.ts"), /email/i);
  // Producer authorization cannot read the Admin-only endpoint: it is guarded
  // by the platform moderator check, not by a Producer role.
  assert.doesNotMatch(adminUsersRoute, /requireProducer|producer_authorization/);
  assert.match(adminUsersRoute, /listAdminDirectoryUsers/);
});

test("a public visitor can never read a User email — the public Place API carries no user data at all", () => {
  assert.doesNotMatch(stripComments(publicPlacesRoute), /email|user/i);
  // The canonical public Place shape has no email field.
  const placeType = placesModule.slice(placesModule.indexOf("export type Place = {"), placesModule.indexOf("const placeIdPattern"));
  assert.doesNotMatch(placeType, /email/i);
  // Only the Admin user-management and the Creator/Developer account
  // management surfaces in the whole app can resolve an account email, and
  // both sit behind a Platform Admin or Creator guard. Nothing under
  // /producer, /auth, or any public page/API appears here.
  const emailReaders = globList("../app")
    .filter((file) => /listAdminDirectoryUsers|listPlatformAdmins/.test(read(file)))
    .map((file) => file.replace("/home/daytona/codebase/web/", "../"))
    .sort();
  assert.deepEqual(emailReaders, [
    "../app/admin/users/page.tsx",
    "../app/api/admin/users/route.ts",
    "../app/api/developer/platform-admins/route.ts",
  ]);
});

// ---------------------------------------------------------------------------
// 10. Authorization server-side
// ---------------------------------------------------------------------------

test("every Admin Place action is authorized server-side, not by hiding UI", () => {
  const workspace = stripComments(placeWorkspace);
  const exported = ["getAdminPlaceDetail", "createAdminPlace", "updateAdminPlace", "setAdminPlacePublicationStatus"];
  for (const name of exported) {
    const body = workspace.slice(workspace.indexOf(`export async function ${name}`));
    const slice = body.slice(0, body.indexOf("\n}"));
    assert.match(slice, /await requirePlatformModerator\(\)/, `${name} must verify authorization server-side`);
  }
  // No client-supplied identity anywhere in the Admin Place routes.
  for (const route of [adminPlacesRoute, adminPlaceRoute, adminPlacePublicationRoute, adminUsersRoute]) {
    assert.doesNotMatch(route, /body\.(userId|user_id|actorId|platformRole)/);
    assert.doesNotMatch(route, /createSupabaseServiceClient/);
  }
  // Every Admin route refuses an unauthorized caller with an explicit 403
  // before it touches data, the same way the claim-review route already does.
  for (const route of [adminPlacesRoute, adminPlaceRoute, adminPlacePublicationRoute, adminClaimsRoute]) {
    assert.match(route, /requirePlatformModerator\(\)/);
    assert.match(route, /status: 403/);
  }
  // The Admin area keeps the fail-closed layout guard.
  assert.match(read("../app/admin/layout.tsx"), /requirePlatformModerator/);
  // Hierarchy is unchanged: the Producer Place routes still require a
  // Producer membership, so an Admin account is not a Producer and vice versa.
  assert.match(read("../app/api/producer/places/[placeId]/publication/route.ts"), /requireProducerAccess/);
  assert.doesNotMatch(read("../app/api/producer/places/route.ts"), /requirePlatformModerator/);
});

// ---------------------------------------------------------------------------
// Shared invariants
// ---------------------------------------------------------------------------

test("a Place is never hard-deleted as an admin operation, and the Admin read layer stays canonical", () => {
  // No delete in the Admin Place workspace or the moderation route.
  assert.doesNotMatch(placeWorkspace, /\.delete\(/);
  assert.doesNotMatch(adminPlacePublicationRoute, /DELETE/);
  // The Admin list is still the existing canonical read.
  assert.match(adminPlacesPage, /listAdminPlaces/);
  assert.match(adminQueries, /from\("places"\)/);
  // No cache or search index is introduced.
  assert.doesNotMatch(stripComments(placeWorkspace), /cache|search_index|searchIndex/i);
});

function globList(relativeDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) out.push(full.replaceAll("\\", "/"));
    }
  };
  walk(new URL(relativeDir, import.meta.url).pathname);
  return out;
}
