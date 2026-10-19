import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

import {
  PLACE_MEDIA_ACCEPTED_TYPES,
  PLACE_MEDIA_MAX_BYTES,
  PLACE_PHOTO_SLOTS,
  PlaceMediaError,
  validatePlaceMediaFile,
} from "@/lib/place-media";
import {
  PLACE_PROFILE_PHOTO_KIND_LABEL,
  PLACE_PROFILE_PHOTO_SLOT_KEY,
  isPlaceOwnMediaPath,
  placeMediaStoragePathFromUrl,
  resolvePlaceProfilePhotoKind,
} from "@/lib/place-cover";

/**
 * ADMIN PHOTO AUTHORITY — the Platform Admin's power to add/replace the
 * profile photo of a Place.
 *
 * ROOT CAUSE THIS LOCKS: the only upload path was the Producer one
 * (requireProducerAccess), so a Place with no active manager — or one still
 * showing a placeholder/dummy photo — could not be fixed at all, and the
 * Producer form is explicitly forbidden from carrying a cover field
 * (place-detail-cover.test.ts). The Admin path adds exactly ONE authority to
 * exactly ONE existing value: `places.cover_image_url`.
 *
 * What must stay true, and is asserted here:
 *  - ONE photo source (the canonical cover column) and ONE storage mechanism
 *    (the existing public `place-media` bucket via the existing helper);
 *  - admin authority verified SERVER-SIDE on every call, distinct from the
 *    Producer gates, so a non-admin cannot reach it through the UI or by
 *    calling the endpoint directly;
 *  - the change never touches publication status, ownership (`producer_id`),
 *    claim state, or the dummy flag, and never grants management rights;
 *  - failure handling is fail-closed: no partial state, no "looks saved" UI.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const adminCoverService = read("../lib/admin/place-cover.ts");
const adminCoverServiceCode = stripComments(adminCoverService);
const adminCoverRoute = read("../app/api/admin/places/[placeId]/cover/route.ts");
const adminCoverRouteCode = stripComments(adminCoverRoute);
const editor = read("../components/admin/place-cover-editor.tsx");
const editorCode = stripComments(editor);
const detailPage = read("../app/admin/places/[placeId]/page.tsx");
const producerSlotRoute = read("../app/api/producer/places/[placeId]/photos/[slotKey]/route.ts");
const storage = read("../lib/place-media-storage.ts");

// ---------------------------------------------------------------------------
// Database harness — the REAL migration chain on a real Postgres engine.
// No migration file is modified and no migration is added: this feature needs
// none (the cover column, the bucket layout, and the audit vocabulary all
// already exist).
// ---------------------------------------------------------------------------

const readMigration = (name: string) => read(`../supabase/migrations/${name}`);

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
  create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
`;

const CHAIN = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0020_one_membership_per_user.sql",
  "0022_allow_multiple_places_per_producer.sql",
  "0018_place_cover_image.sql",
  "0021_place_photos.sql",
  "0031_place_audit.sql",
  "0032_place_geography.sql",
  "0033_place_category_currency.sql",
  "0035_place_curated_flag.sql",
  "0036_place_curated_admin.sql",
  "0039_dummy_place_developer_authority.sql",
] as const;

const stripPgcrypto = (sql: string) => sql.replace(/create extension if not exists pgcrypto;?/gim, "");

async function bootstrapCoverDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIMS);
  await db.exec("create publication supabase_realtime;");
  for (const name of CHAIN) await db.exec(stripPgcrypto(readMigration(name)));
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

// ===========================================================================
// 1. THE CANONICAL PHOTO — one source, one classification rule
// ===========================================================================

test("no cover URL means the app's own placeholder, and that is deterministic", () => {
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(resolvePlaceProfilePhotoKind({ coverImageUrl: value }), "placeholder");
  }
  // A missing cover is the ONLY placeholder state: nothing else in the app
  // renders /place-cover-placeholder.svg.
  const home = read("../components/home-discovery.tsx");
  assert.match(home, /src="\/place-cover-placeholder\.svg"/);
});

test("a saved cover on a real listing is an actual photo, on a Dummy Place it is fixture media", () => {
  const url = "https://project.supabase.co/storage/v1/object/public/place-media/places/p/hook-ab.png";
  assert.equal(resolvePlaceProfilePhotoKind({ coverImageUrl: url, isDummy: false }), "foto");
  assert.equal(resolvePlaceProfilePhotoKind({ coverImageUrl: url }), "foto");
  // is_dummy = "this row is a development/testing fixture, not a real listing"
  // (Master Dummy Place v1.0 §2) — canonical, never inferred from the image.
  assert.equal(resolvePlaceProfilePhotoKind({ coverImageUrl: url, isDummy: true }), "dummy");
});

test("every determinable state has an operator-facing label", () => {
  assert.deepEqual(Object.keys(PLACE_PROFILE_PHOTO_KIND_LABEL).sort(), ["dummy", "foto", "placeholder"]);
  for (const label of Object.values(PLACE_PROFILE_PHOTO_KIND_LABEL)) assert.ok(label.trim().length > 0);
  assert.equal(PLACE_PROFILE_PHOTO_KIND_LABEL.placeholder, "Placeholder");
  assert.equal(PLACE_PROFILE_PHOTO_KIND_LABEL.dummy, "Foto dummy");
});

test("the admin object slot is not a media-library slot", () => {
  assert.equal(PLACE_PROFILE_PHOTO_SLOT_KEY, "cover");
  // No `place_photos` row may ever be written for it (0021's slot contract is
  // the Producer's media library, not the profile photo).
  const slotKeys: string[] = PLACE_PHOTO_SLOTS.map((slot) => slot.key as string);
  assert.equal(slotKeys.includes(PLACE_PROFILE_PHOTO_SLOT_KEY), false);
  assert.deepEqual(slotKeys, ["hook", "process", "place", "people", "product"]);
});

test("a stored public URL maps back to its object path, and nothing else does", () => {
  assert.equal(
    placeMediaStoragePathFromUrl(
      "https://project.supabase.co/storage/v1/object/public/place-media/places/duku/cover-ab12.png",
    ),
    "places/duku/cover-ab12.png",
  );
  // Query/hash suffixes are not part of the object path.
  assert.equal(
    placeMediaStoragePathFromUrl("https://x.co/storage/v1/object/public/place-media/places/p/c-1.png?t=2#z"),
    "places/p/c-1.png",
  );
  // Anything that is not one of OUR public objects is refused, so it can never
  // be treated as a deletable object: an external host, another bucket, or a
  // non-string value.
  assert.equal(placeMediaStoragePathFromUrl("https://cdn.example.com/a/b.png"), null);
  assert.equal(placeMediaStoragePathFromUrl("https://x.co/storage/v1/object/public/ai-media-sources/a.png"), null);
  assert.equal(placeMediaStoragePathFromUrl("https://x.co/storage/v1/object/sign/place-media/a.png"), null);
  assert.equal(placeMediaStoragePathFromUrl(null), null);
  assert.equal(placeMediaStoragePathFromUrl(undefined), null);
  // A hostile, oversized path is not returned either.
  assert.equal(placeMediaStoragePathFromUrl(`https://x.co/storage/v1/object/public/place-media/${"a".repeat(600)}`), null);
});

test("only this Place's own media folder is considered replaceable cleanup", () => {
  assert.equal(isPlaceOwnMediaPath("places/duku/cover-1.png", "duku"), true);
  // A promoted AI output lives in another folder and belongs to another owner.
  assert.equal(isPlaceOwnMediaPath("ai-outputs/duku/hook-1.png", "duku"), false);
  assert.equal(isPlaceOwnMediaPath("places/duku-2/cover-1.png", "duku"), false);
  assert.equal(isPlaceOwnMediaPath("", "duku"), false);
  assert.equal(isPlaceOwnMediaPath("places/duku/x.png", ""), false);
});

// ===========================================================================
// 2. THE REUSED FILE RULE (real behaviour of the shared validator)
// ===========================================================================

test("the shared media gate really refuses a disallowed type and an oversized file", () => {
  assert.deepEqual([...PLACE_MEDIA_ACCEPTED_TYPES], ["image/jpeg", "image/png", "image/webp", "image/avif"]);
  assert.throws(
    () => validatePlaceMediaFile({ type: "application/pdf", size: 1024 }),
    (error: unknown) => error instanceof PlaceMediaError && error.code === "place_photo_type_invalid",
  );
  assert.throws(
    () => validatePlaceMediaFile({ type: "image/png", size: PLACE_MEDIA_MAX_BYTES + 1 }),
    (error: unknown) => error instanceof PlaceMediaError && error.code === "place_photo_size_invalid",
  );
  assert.throws(
    () => validatePlaceMediaFile({ type: "image/png", size: 0 }),
    (error: unknown) => error instanceof PlaceMediaError && error.code === "place_photo_size_invalid",
  );
  assert.doesNotThrow(() => validatePlaceMediaFile({ type: "image/png", size: 1024 }));
});

// ===========================================================================
// 3. SERVER AUTHORITY — admin identity, verified server-side
// ===========================================================================

test("the service verifies Platform Admin authorization first, and the actor is the guard's value", () => {
  const fn = adminCoverServiceCode.slice(adminCoverServiceCode.indexOf("export async function setAdminPlaceProfilePhoto"));
  assert.match(fn, /^\s*?[\s\S]*?await requirePlatformModerator\(\)/, "the guard runs first");
  const guardIndex = fn.indexOf("await requirePlatformModerator()");
  const actorIndex = fn.indexOf("actor.userId");
  const writeIndex = fn.indexOf('from("places")');
  assert.ok(guardIndex >= 0, "the guard must exist");
  assert.ok(actorIndex > guardIndex, "the audit actor is the guard's return value");
  assert.ok(writeIndex > guardIndex, "no write happens before authorization");
  // No client-supplied identity anywhere.
  assert.doesNotMatch(adminCoverServiceCode, /body\.(userId|user_id|actorId|platformRole)/);
  assert.doesNotMatch(adminCoverServiceCode, /p_actor_id|service_role.*actor/i);
});

test("admin authority and producer authority stay separate: neither gate can reach the other's path", () => {
  // The Admin photo path requires NO Producer membership — that is exactly what
  // makes a managerless Place fixable — and the Producer photo path never
  // accepts a Platform Admin role as a substitute.
  assert.doesNotMatch(adminCoverServiceCode, /requireProducerAccess|producer_memberships/);
  assert.doesNotMatch(adminCoverRouteCode, /requireProducerAccess|producer_authorization/);
  assert.doesNotMatch(producerSlotRoute, /requirePlatformModerator/);
  // The Producer route still re-checks the membership gate in both handlers.
  assert.equal(
    (stripComments(producerSlotRoute).match(/requireProducerAccess\(request, placeId, \["owner", "manager", "editor"\]\)/g) ?? [])
      .length,
    2,
  );
});

test("a Place without an active manager is never refused for being managerless", () => {
  // The only preconditions are: a real Place row and an acceptable file. There
  // is no membership count, no owner requirement, and no "appoint a manager
  // first" branch — a Place may legitimately stand without a Pengelola (0058).
  const fn = adminCoverServiceCode.slice(adminCoverServiceCode.indexOf("export async function setAdminPlaceProfilePhoto"));
  assert.match(fn, /if \(!place\) throw new AdminPlaceCoverError\("place_not_found"\)/);
  assert.doesNotMatch(fn, /membership|owner|last_owner|manager_required/i);
});

// ===========================================================================
// 4. THE WRITE — one column, one storage mechanism, no status change
// ===========================================================================

test("the profile photo is the canonical cover column, written through the service role", () => {
  assert.match(adminCoverServiceCode, /cover_image_url: uploaded\.url/);
  assert.match(adminCoverServiceCode, /createSupabaseServiceClient\(\)/);
  assert.match(adminCoverServiceCode, /\.eq\("id", id\)/);
  // No second photo source: no new column, table, bucket, or RPC is introduced.
  assert.doesNotMatch(adminCoverServiceCode, /createBucket|create bucket|storage\.create/);
  assert.doesNotMatch(adminCoverServiceCode, /\.rpc\(/);
  assert.doesNotMatch(adminCoverRouteCode, /createSupabaseServiceClient/);
  // The object goes to the EXISTING public bucket through the EXISTING helper.
  assert.match(adminCoverServiceCode, /uploadPlacePhoto\(\{ placeId: id, slotKey: PLACE_PROFILE_PHOTO_SLOT_KEY, file \}\)/);
  assert.match(storage, /from\(PLACE_MEDIA_BUCKET\)/);
});

test("the Admin write never touches status, ownership, claim, or the dummy flag", () => {
  for (const forbidden of [
    "publication_status",
    "producer_id",
    "claim_status",
    "is_dummy",
    "is_curated",
    "published",
    "archived",
  ]) {
    assert.equal(
      adminCoverServiceCode.includes(forbidden),
      false,
      `the admin photo path must not write ${forbidden}`,
    );
  }
  // The write payload is exactly the cover plus the canonical touch time.
  assert.match(adminCoverServiceCode, /\.update\(\{ cover_image_url: [A-Za-z.]+, updated_at: new Date\(\)\.toISOString\(\) \}\)/);
});

test("place_photos is read for safety but never written by the Admin photo path", () => {
  assert.match(adminCoverServiceCode, /from\("place_photos"\)\s*\n?\s*\.select\("id"\)/);
  assert.doesNotMatch(adminCoverServiceCode, /from\("place_photos"\)\s*\.\s*(insert|update|delete|upsert)/);
  // The Producer media library is untouched: the Producer route keeps its own
  // five-slot contract and the hook ⇄ cover rule.
  assert.match(stripComments(producerSlotRoute), /PLACE_PHOTO_SLOTS|place_photos/);
});

// ===========================================================================
// 5. FAILURE HANDLING — no partial state, never a "looks saved" surface
// ===========================================================================

test("an upload/save failure removes what it created and reports failure", () => {
  assert.match(adminCoverServiceCode, /throw new AdminPlaceCoverError\("place_cover_upload_failed"\)/);
  // The cover write failure removes the just-uploaded object before throwing.
  const writeFailure = adminCoverServiceCode.slice(
    adminCoverServiceCode.indexOf("if (write.error)"),
    adminCoverServiceCode.indexOf("await recordPlaceAudit({"),
  );
  assert.match(writeFailure, /removePlacePhotoObject\(uploaded\.storagePath\)\.catch\(\(\) => \{\}\)/);
  assert.match(writeFailure, /throw new AdminPlaceCoverError\("place_unavailable"\)/);
});

test("a failed audit record reverts the cover and drops the new object, so no unattributed change survives", () => {
  const auditBlock = adminCoverServiceCode.slice(
    adminCoverServiceCode.indexOf("await recordPlaceAudit({"),
    adminCoverServiceCode.indexOf("return { placeId: id, coverImageUrl: uploaded.url }"),
  );
  assert.match(auditBlock, /action: PLACE_AUDIT_ACTIONS\.updated/);
  assert.match(auditBlock, /cover_image_url: place\.coverImageUrl/, "the previous value is restored");
  assert.match(auditBlock, /removePlacePhotoObject\(uploaded\.storagePath\)\.catch\(\(\) => \{\}\)/);
  assert.match(auditBlock, /AdminPlaceCoverError\("place_audit_unavailable"\)/);
});

test("the replaced object is deleted only when it is ours and unreferenced — best-effort and last", () => {
  const cleanup = adminCoverServiceCode.slice(
    adminCoverServiceCode.indexOf("const previousPath"),
    adminCoverServiceCode.indexOf("return { placeId: id, coverImageUrl: uploaded.url }"),
  );
  assert.match(cleanup, /placeMediaStoragePathFromUrl\(place\.coverImageUrl\)/);
  assert.match(cleanup, /isPlaceOwnMediaPath\(previousPath, id\)/);
  assert.match(cleanup, /\.eq\("storage_path", previousPath\)/);
  assert.match(cleanup, /if \(!referenced\.error && !referenced\.data\?\.length\)/);
  assert.match(cleanup, /removePlacePhotoObject\(previousPath\)\.catch\(\(\) => \{\}\)/);
  // The cleanup is the LAST thing the function does: the canonical state is
  // already safe, so a Storage hiccup cannot fail a completed change.
  assert.ok(
    adminCoverServiceCode.indexOf("const previousPath") >
      adminCoverServiceCode.indexOf("await recordPlaceAudit({"),
    "the cleanup runs after the change is canonical and audited",
  );
});

// ===========================================================================
// 6. THE API ROUTE — direct calls are refused for non-admins
// ===========================================================================

test("the route re-verifies Platform Admin authorization before reading the upload", () => {
  assert.match(adminCoverRouteCode, /await requirePlatformModerator\(\)/);
  assert.match(adminCoverRouteCode, /status: 403/);
  assert.match(adminCoverRouteCode, /code: "admin_required"/);
  // The guard decision precedes any form parsing or service call.
  const guardIndex = adminCoverRouteCode.indexOf("await denyUnlessModerator()");
  const formIndex = adminCoverRouteCode.indexOf("await request.formData()");
  const serviceIndex = adminCoverRouteCode.indexOf("setAdminPlaceProfilePhoto(placeId, file)");
  assert.ok(guardIndex >= 0 && formIndex > guardIndex && serviceIndex > formIndex);
  // Calling the endpoint directly with a valid session that is not an admin is
  // refused by that guard: the route carries no role/identity parameter at all.
  assert.doesNotMatch(adminCoverRouteCode, /platform_role|platformRole|userId/);
  // A missing file is refused (fail closed) instead of writing anything.
  assert.match(adminCoverRouteCode, /place_photo_file_required/);
  // Every service error maps through the shared operator-facing table.
  assert.match(adminCoverRouteCode, /adminPlaceCoverErrorMessage\(error\.code\)/);
  assert.match(adminCoverRouteCode, /adminPlaceCoverErrorStatus\(error\.code\)/);
  assert.match(adminCoverRoute, /export const dynamic = "force-dynamic"/);
});

test("the operator-facing messages never leak internals or credentials", () => {
  const start = adminCoverServiceCode.indexOf("export function adminPlaceCoverErrorMessage");
  const messages = adminCoverServiceCode.slice(start, adminCoverServiceCode.indexOf("export function adminPlaceCoverErrorStatus"));
  assert.match(messages, /Format foto tidak didukung/);
  assert.match(messages, /maksimal 5 MB/);
  assert.match(messages, /Riwayat tindakan tidak dapat dicatat/);
  // The operator sees a plain reason only: no role, key, bucket path, or
  // internal identifier is ever returned to the caller.
  assert.doesNotMatch(messages, /service_role|SUPABASE_SERVICE_ROLE_KEY|bucket key|storage_path|token|producer_id/i);
});

// ===========================================================================
// 7. THE ADMIN SURFACE
// ===========================================================================

test("the Place workspace offers the photo section with the canonical current value", () => {
  assert.match(detailPage, /aria-label="Foto Profil Tempat"/);
  assert.match(detailPage, /<AdminPlaceCoverEditor/);
  assert.match(detailPage, /coverImageUrl=\{place\.coverImageUrl\}/);
  assert.match(detailPage, /publicationStatus=\{place\.publicationStatus\}/);
  assert.match(detailPage, /isDummy=\{place\.isDummy\}/);
  assert.match(detailPage, /placeId=\{place\.id\}/);
  // The section states the boundaries in the operator's language.
  assert.match(detailPage, /Tidak ada\s+Pengelola baru yang perlu ditunjuk/);
});

test("the editor shows the current photo, previews the pick, and reports progress and outcome", () => {
  // 1. the current photo (or the app placeholder) comes from the server prop
  assert.match(editorCode, /src=\{savedUrl\}/);
  assert.match(editorCode, /src="\/place-cover-placeholder\.svg"/);
  assert.match(editorCode, /PLACE_PROFILE_PHOTO_KIND_LABEL\[kind\]/);
  assert.match(editorCode, /resolvePlaceProfilePhotoKind\(\{ coverImageUrl: savedUrl, isDummy \}\)/);
  // 2. pick from device + preview BEFORE saving
  assert.match(editorCode, /type="file"/);
  assert.match(editorCode, /accept=\{PLACE_MEDIA_ACCEPTED_TYPES\.join\(","\)\}/);
  assert.match(editorCode, /Pratinjau/);
  assert.match(editorCode, /Pratinjau ini belum tersimpan/);
  // The preview URL is created on pick and released again — on cancel, on
  // save, and when the surface goes away.
  assert.match(editorCode, /URL\.createObjectURL\(file\)/);
  assert.match(editorCode, /URL\.revokeObjectURL\(previewUrlRef\.current\)/);
  assert.match(editorCode, /URL\.revokeObjectURL\(previewUrlRef\.current\)[\s\S]*?\}, \[\]\)/, "released on unmount");
  assert.match(editorCode, /function releasePreview\(\)/);
  // 3. the same file rule the server enforces, for instant feedback
  assert.match(editorCode, /validatePlaceMediaFile\(\{ type: file\.type, size: file\.size \}\)/);
  // 4. upload progress + clear outcome messages
  assert.match(editorCode, /Mengunggah…/);
  assert.match(editorCode, /aria-busy=\{busy\}/);
  assert.match(editorCode, /role="status"/);
  assert.match(editorCode, /role="alert"/);
  // 5. the payload is the FILE only — no status, owner, or admin parameter
  assert.match(editorCode, /body\.append\("file", picked\.file\)/);
  assert.doesNotMatch(editorCode, /body\.append\("(status|publicationStatus|producerId|userId|isDummy)"|JSON\.stringify/);
});

test("the displayed photo adopts the SERVER's saved URL, never the local preview", () => {
  // Success is decided by the stored URL the server returns; the local preview
  // is discarded and the page re-reads the canonical value.
  assert.match(editorCode, /const savedRaw = record\?\.coverImageUrl/);
  assert.match(editorCode, /setSavedPhoto\(\{ base: coverImageUrl, url: savedRaw \}\)/);
  // The shown value is derived from the canonical prop plus that one result,
  // so a newer server value can never be masked by an older local one.
  assert.match(
    editorCode,
    /const savedUrl = savedPhoto && savedPhoto\.base === coverImageUrl \? savedPhoto\.url : coverImageUrl/,
  );
  assert.match(editorCode, /router\.refresh\(\)/);
  const successBlock = editorCode.slice(
    editorCode.indexOf("const savedRaw = record?.coverImageUrl"),
    editorCode.indexOf("router.refresh()"),
  );
  assert.ok(
    successBlock.indexOf("setSavedPhoto({ base: coverImageUrl, url: savedRaw })") >= 0,
    "the shown photo comes from the response",
  );
  assert.doesNotMatch(successBlock, /picked\.previewUrl/);
  // A success answer WITHOUT the stored URL is treated as a failure rather
  // than showing the preview as saved.
  assert.match(editorCode, /Server tidak mengembalikan foto tersimpan/);
  // A failed request keeps the previous photo and reports the error.
  assert.match(editorCode, /setError\(/);
});

// ===========================================================================
// 8. THE REAL DATABASE — the write, on the actual schema
// ===========================================================================

test("a managerless, archived Place really accepts the profile photo, and nothing else about it changes", async () => {
  const db = await bootstrapCoverDb();
  try {
    const actor = "00000000-0000-4000-8000-000000000001";
    await db.exec(`
      insert into auth.users (id, email_confirmed_at) values ('${actor}', now());
      insert into public.users (id) values ('${actor}') on conflict do nothing;
      insert into public.places (id, name, short_description, category, type, area, address,
        contact_information, timezone, currency, latitude, longitude, producer_id, claim_status, publication_status)
      values ('tempat-tanpa-pengelola', 'Tempat Tanpa Pengelola', 'd', 'Perdagangan & Jasa', 'production',
        'Bandung', 'Jalan Sbomen 1', '', 'Asia/Jakarta', 'IDR', -6.9, 107.6, null, 'unverified', 'archived');
    `);

    // The Place has no membership at all: managerless is a LEGITIMATE target.
    const memberships = await rows(db, "select user_id from public.producer_memberships where place_id = 'tempat-tanpa-pengelola'");
    assert.equal(memberships.length, 0);

    const photoUrl =
      "https://project.supabase.co/storage/v1/object/public/place-media/places/tempat-tanpa-pengelola/cover-abc123.png";
    // The EXACT statement the Admin service issues: the canonical cover column
    // plus the touch time, and nothing else.
    await db.query("update public.places set cover_image_url = $1, updated_at = now() where id = $2", [
      photoUrl,
      "tempat-tanpa-pengelola",
    ] as never);

    const after = (await rows(
      db,
      "select cover_image_url, publication_status, producer_id, claim_status, is_dummy, is_curated from public.places where id = 'tempat-tanpa-pengelola'",
    ))[0];
    assert.equal(after.cover_image_url, photoUrl, "the photo is really stored");
    // An archived Place STAYS archived: fixing a photo is not a restore, and
    // the Admin is never asked to publish it to do so.
    assert.equal(after.publication_status, "archived");
    // No manager is assigned and no ownership is implied.
    assert.equal(after.producer_id, null);
    assert.equal(after.claim_status, "unverified");
    // A real listing keeps its dummy/curated flags.
    assert.equal(after.is_dummy, false);
    assert.equal(after.is_curated, false);

    // The schema itself refuses a cover that is not an https URL, which is why
    // the service only ever writes the URL of the object it just stored.
    await assert.rejects(
      () =>
        db.query("update public.places set cover_image_url = $1 where id = $2", [
          "http://insecure.example.com/x.png",
          "tempat-tanpa-pengelola",
        ] as never),
      /places_cover_image_url_https|check constraint/i,
    );
  } finally {
    await db.close();
  }
});

test("a Place WITH an active manager takes the same photo update, and the membership is untouched", async () => {
  const db = await bootstrapCoverDb();
  try {
    const admin = "00000000-0000-4000-8000-000000000002";
    const owner = "00000000-0000-4000-8000-000000000003";
    await db.exec(`
      insert into auth.users (id, email_confirmed_at) values ('${admin}', now()), ('${owner}', now());
      insert into public.users (id) values ('${admin}'), ('${owner}') on conflict do nothing;
      insert into public.producers (id, display_name) values ('prod-owner', 'Pengelola Aktif');
      insert into public.places (id, name, short_description, category, type, area, address,
        contact_information, timezone, currency, producer_id, claim_status, publication_status)
      values ('tempat-berpengelola', 'Tempat Berpengelola', 'd', 'Perdagangan & Jasa', 'production',
        'Bandung', 'Jalan Sbomen 2', '', 'Asia/Jakarta', 'IDR', 'prod-owner', 'verified', 'published');
      insert into public.producer_memberships (user_id, producer_id, place_id, role)
      values ('${owner}', 'prod-owner', 'tempat-berpengelola', 'owner');
    `);

    await db.query("update public.places set cover_image_url = $1, updated_at = now() where id = $2", [
      "https://project.supabase.co/storage/v1/object/public/place-media/places/tempat-berpengelola/cover-def.png",
      "tempat-berpengelola",
    ] as never);

    // Case A: a Place with a manager is a valid target, and the Admin action
    // neither removes nor rewrites the membership that makes it managed.
    const row = (await rows(
      db,
      "select cover_image_url, producer_id, publication_status from public.places where id = 'tempat-berpengelola'",
    ))[0];
    assert.match(String(row.cover_image_url), /cover-def\.png$/);
    assert.equal(row.producer_id, "prod-owner");
    assert.equal(row.publication_status, "published");
    const membership = await rows(db, "select user_id, role from public.producer_memberships where place_id = 'tempat-berpengelola'");
    assert.equal(membership.length, 1);
    assert.equal(membership[0].role, "owner");
  } finally {
    await db.close();
  }
});

test("the existing audit vocabulary really records the photo change — no migration needed", async () => {
  const db = await bootstrapCoverDb();
  try {
    const actor = "00000000-0000-4000-8000-000000000004";
    await db.exec(`
      insert into auth.users (id, email_confirmed_at) values ('${actor}', now());
      insert into public.users (id) values ('${actor}') on conflict do nothing;
      insert into public.places (id, name, short_description, category, type, area, address,
        contact_information, timezone, currency, claim_status, publication_status)
      values ('tempat-audit', 'Tempat Audit', 'd', 'Perdagangan & Jasa', 'production',
        'Bandung', 'Jalan Sbomen 3', '', 'Asia/Jakarta', 'IDR', 'unverified', 'published');
    `);

    const before = JSON.stringify({ cover_image_url: null, name: "Tempat Audit" });
    const after = JSON.stringify({ cover_image_url: "https://x/cover-1.png", name: "Tempat Audit" });
    await db.query(
      `insert into public.place_audit (place_id, actor_id, action, before_data, after_data, detail)
       values ($1, $2, 'admin_place_updated', $3::jsonb, $4::jsonb, $5::jsonb)`,
      [
        "tempat-audit",
        actor,
        before,
        after,
        JSON.stringify({ field: "cover_image_url", operation: "profile_photo_uploaded" }),
      ] as never,
    );

    const entry = (await rows(db, "select action, before_data, after_data, detail from public.place_audit"))[0];
    assert.equal(entry.action, "admin_place_updated", "the existing action vocabulary is enough");
    assert.equal((entry.before_data as Record<string, unknown>).cover_image_url, null);
    assert.equal((entry.after_data as Record<string, unknown>).cover_image_url, "https://x/cover-1.png");
    assert.equal((entry.detail as Record<string, unknown>).field, "cover_image_url");

    // The trail stays append-only even for the service role: the change can
    // never be rewritten or removed after the fact.
    await assert.rejects(() => db.query("update public.place_audit set action = 'admin_place_updated'"));
    await assert.rejects(() => db.query("delete from public.place_audit"));
  } finally {
    await db.close();
  }
});

test("the editor never writes the canonical column itself and claims no access it does not have", () => {
  assert.doesNotMatch(editorCode, /cover_image_url/);
  assert.doesNotMatch(editorCode, /createSupabaseServiceClient|service_role|SUPABASE/);
  // The boundaries are stated where the Admin acts.
  assert.match(editorCode, /tidak menunjuk atau menambah Pengelola/);
  assert.match(editorCode, /tidak memulihkan Tempat ini dari arsip/);
  // Mobile first: stacked layout, widened at the sm breakpoint.
  assert.match(editorCode, /sm:grid-cols-\[minmax\(0,200px\)_minmax\(0,1fr\)\]/);
});
