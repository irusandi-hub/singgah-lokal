import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import {
  PLACE_MEDIA_MAX_BYTES,
  getPlacePhotoSlot,
  validatePlaceMediaFile,
  validatePlacePhotoMeta,
} from "@/lib/place-media";

/**
 * PLACE MEDIA regression (PO request, 2026-09-25).
 *
 * Proves the media pipeline end-to-end at the layer that can run here:
 * - the HTTP-URL input is GONE from the Place form as a media mechanism;
 * - the 5 standard slots exist with title + description prompts (Production
 *   Story content structure — no new content structure);
 * - uploads carry file + title + description to a server-side endpoint
 *   (multipart) that requires Producer access to the Place (fail-closed);
 * - validation (type/size/meta) is enforced by server-side code;
 * - the reference (slot key + storage path + title + description) is stored
 *   canonically in place_photos (0021) keyed by (place_id, slot_key), and
 *   the form restores every slot from that record on load/reload;
 * - REPLACE is idempotent: one row per slot — a repeated submit never
 *   duplicates references or leaves the old object behind;
 * - files live in Supabase Storage (bucket place-media) — clients get no
 *   direct bucket access (no client write policies on place_photos).
 */

const placeForm = readFileSync(new URL("../app/producer/places/PlaceForm.tsx", import.meta.url), "utf8");
const placeMedia = readFileSync(new URL("../lib/place-media.ts", import.meta.url), "utf8");
const storageService = readFileSync(new URL("../lib/place-media-storage.ts", import.meta.url), "utf8");
const uploadRoute = readFileSync(
  new URL("../app/api/producer/places/[placeId]/photos/[slotKey]/route.ts", import.meta.url),
  "utf8",
);
const listRoute = readFileSync(
  new URL("../app/api/producer/places/[placeId]/photos/route.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(new URL("../supabase/migrations/0021_place_photos.sql", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("--");
    })
    .join("\n");
}

// ---------- Source-contract tests ----------

test("Place form has NO HTTP-URL input as a media mechanism", () => {
  const code = stripComments(placeForm);
  assert.doesNotMatch(code, /URL Gambar Sampul/);
  assert.doesNotMatch(code, /coverImageUrl/i);
  assert.doesNotMatch(code, /type="url"/i);
  // The upload mechanism is the file input bound to the standard slots.
  assert.match(code, /type="file"/);
  assert.match(code, /PLACE_PHOTO_SLOTS\.map/);
});

test("Five standard photo slots exist with title + description (Production Story structure)", () => {
  const code = stripComments(placeMedia);
  assert.match(code, /export const PLACE_PHOTO_SLOTS/);
  const hookIdx = code.indexOf('key: "hook"');
  const processIdx = code.indexOf('key: "process"');
  const placeIdx = code.indexOf('key: "place"');
  const peopleIdx = code.indexOf('key: "people"');
  const productIdx = code.indexOf('key: "product"');
  assert.ok(hookIdx >= 0 && processIdx > hookIdx && placeIdx > processIdx && peopleIdx > placeIdx && productIdx > peopleIdx,
    "the 5 standard slots must be defined in display order (hook first)");
  // Hook prompt and the next content sections carry title + description.
  for (const slotKey of ["hook", "process", "place", "people", "product"]) {
    const at = code.indexOf(`key: "${slotKey}"`);
    const chunk = code.slice(at, at + 600);
    assert.match(chunk, /titlePrompt:/, `${slotKey} has a title prompt`);
    assert.match(chunk, /descriptionPrompt:/, `${slotKey} has a description prompt`);
  }
  // The form renders a title and a description input per slot.
  const formCode = stripComments(placeForm);
  assert.match(formCode, /Judul foto/);
  assert.match(formCode, /Deskripsi foto/);
  assert.match(formCode, /maxLength=\{120\}/);
  assert.match(formCode, /maxLength=\{1000\}/);
});

test("Upload sends file + title + description to the server-side multipart endpoint", () => {
  const code = stripComments(placeForm);
  assert.match(code, /new FormData\(\)/);
  assert.match(code, /body\.append\("file", file\)/);
  assert.match(code, /body\.append\("title", title\)/);
  assert.match(code, /body\.append\("description", description\)/);
  assert.match(code, /\/api\/producer\/places\/\$\{place\.id\}\/photos\/\$\{slotKey\}/);
  // Replace and remove flows exist alongside upload.
  assert.match(code, /"replace"/);
  assert.match(code, /removeSlot/);
});

test("Upload route is server-side, Producer-gated, and service-role only", () => {
  const code = stripComments(uploadRoute);
  // The Producer gate runs BEFORE any storage or DB write.
  const gateIdx = code.indexOf('requireProducerAccess(request, placeId, ["owner", "manager", "editor"])');
  const formDataIdx = code.indexOf("await request.formData()");
  assert.ok(gateIdx >= 0 && formDataIdx > gateIdx, "Producer access check must precede formData processing");
  // Server-side validation (type/size/meta) via the media contract.
  assert.match(code, /validatePlaceMediaFile\(\{ type: file\.type, size: file\.size \}\)/);
  assert.match(code, /validatePlacePhotoMeta\(form\.get\("title"\), form\.get\("description"\)\)/);
  // Storage writes use the service-role client; the saved reference is
  // canonical in place_photos keyed by (place_id, slot_key).
  assert.match(code, /createSupabaseServiceClient\(\)/);
  assert.match(code, /uploadPlacePhoto\(/);
  assert.match(code, /\.eq\("place_id", placeId\)/);
  assert.match(code, /\.eq\("slot_key", slot\.key\)/);
});

test("Server-side validation limits match the locked media contract", () => {
  const code = stripComments(placeMedia);
  assert.match(code, /PLACE_MEDIA_MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(code, /"image\/jpeg"/);
  assert.match(code, /"image\/png"/);
  assert.match(code, /"image\/webp"/);
  assert.match(code, /"image\/avif"/);
  assert.match(code, /place_photo_type_invalid/);
  assert.match(code, /place_photo_size_invalid/);
  assert.match(code, /place_photo_title_invalid/);
  assert.match(code, /place_photo_description_invalid/);
});

test("Reload restores every slot from the canonical record", () => {
  const formCode = stripComments(placeForm);
  // The form fetches the saved slots on mount...
  assert.match(formCode, /\/api\/producer\/places\/\$\{place\.id\}\/photos`/);
  // ...and the list endpoint returns them from place_photos (not client state).
  const listCode = stripComments(listRoute);
  assert.match(listCode, /from\("place_photos"\)/);
  assert.match(listCode, /slotKey: slot\.key/);
  assert.match(listCode, /title: photo\.title/);
  assert.match(listCode, /description: photo\.description/);
  assert.match(listCode, /url: photo\.url/);
});

test("Files go to Supabase Storage under the place-media bucket; clients get no direct access", () => {
  const storageCode = stripComments(storageService);
  assert.match(storageCode, /PLACE_MEDIA_BUCKET/);
  assert.match(storageCode, /places\/\$\{placeId\}/);
  assert.match(storageCode, /\.upload\(/);
  assert.match(storageCode, /\.remove\(/);
  // No client write policy on place_photos (server-side API only).
  assert.doesNotMatch(migration, /create policy place_photos_\w+_insert/i);
  assert.doesNotMatch(migration, /create policy place_photos_\w+_update/i);
});

// ---------- Engine test: 0021 schema semantics on PGlite ----------

const SHIMS = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as '
    select nullif(current_setting(''request.jwt.claims.sub'', true), '''')::uuid
  ';
  create role anon;
  create role authenticated;
  create role service_role;
  create role supabase_admin;
  create role authenticator;
`;

const stripPgcrypto = (s: string) =>
  s.replace(/create extension if not exists pgcrypto;?/gim, "");

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

async function bootstrapDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIMS);
  await db.exec("create publication supabase_realtime;");
  for (const name of [
    "0001_visit_intent_foundation.sql",
    "0002_harden_visit_intent_rls.sql",
    "0003_persistence_integrity.sql",
    "0004_place_management.sql",
    "0005_experience_management.sql",
  ]) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  await db.exec(stripPgcrypto(readMigration("0021_place_photos.sql")));
  return db;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("place_photos keeps exactly one canonical reference per slot and survives reload", async () => {
  const db = await bootstrapDb();
  try {
    const rows = async (query: string, params: unknown[] = []) =>
      ((await db.query(query, params)).rows ?? []) as Record<string, unknown>[];

    const userId = uuid(1);
    await db.exec(`insert into auth.users (id, email_confirmed_at) values ('${userId}', now());`);
    await db.exec(`insert into public.producers (id, display_name) values ('media-producer', 'Media Producer');`);
    await db.exec(
      `insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id)
       values ('media-place', 'Media Place', 'desc', 'Kuliner', 'production', 'Yogyakarta', 'Asia/Jakarta', 'IDR', 'media-producer');`,
    );
    await db.exec(
      `insert into public.producer_memberships (user_id, producer_id, place_id, role)
       values ('${userId}', 'media-producer', 'media-place', 'owner');`,
    );

    // First upload for the hook slot → reference saved.
    await db.exec(
      `insert into public.place_photos (place_id, slot_key, storage_path, title, description, sort_order)
       values ('media-place', 'hook', 'places/media-place/hook-abc123.jpg', 'Bakso keluar dari dapur', 'Uap pertama setiap pagi — hook cerita Place ini.', 0);`,
    );

    // REPLACE (same slot, new object): the upload API updates the SAME row
    // (place_id, slot_key) — one canonical reference per slot, ever.
    await db.exec(
      `insert into public.place_photos (place_id, slot_key, storage_path, title, description, sort_order)
       values ('media-place', 'hook', 'places/media-place/hook-def456.jpg', 'Bakso keluar dari dapur', 'Uap pertama setiap pagi — hook cerita Place ini.', 0)
       on conflict (place_id, slot_key) do update
       set storage_path = excluded.storage_path, updated_at = now();`,
    );

    const hookRows = await rows(
      `select storage_path, title, description from public.place_photos where place_id = 'media-place' and slot_key = 'hook'`,
    );
    assert.equal(hookRows.length, 1, "replace keeps exactly one reference per slot");
    assert.equal(hookRows[0].storage_path, "places/media-place/hook-def456.jpg");
    assert.equal(hookRows[0].title, "Bakso keluar dari dapur");
    assert.equal(hookRows[0].description, "Uap pertama setiap pagi — hook cerita Place ini.");

    // All 5 standard slots fit the unique contract.
    for (const [index, slot] of ["hook", "process", "place", "people", "product"].entries()) {
      if (slot === "hook") continue;
      await db.exec(
        `insert into public.place_photos (place_id, slot_key, storage_path, title, description, sort_order)
         values ('media-place', '${slot}', 'places/media-place/${slot}-x.jpg', 'Judul ${slot}', 'Deskripsi ${slot}.', ${index});`,
      );
    }
    const all = await rows(`select slot_key from public.place_photos where place_id = 'media-place' order by sort_order`);
    assert.equal(all.length, 5, "all five standard slots are stored");

    // Metadata constraints are enforced by the DB.
    await assert.rejects(
      () =>
        db.query(
          `insert into public.place_photos (place_id, slot_key, storage_path, title, description)
           values ('media-place', 'process', 'places/media-place/x.jpg', '${"a".repeat(121)}', 'y')`,
        ),
      /place_photos_title_check/,
    );

    // Non-standard slot keys are refused by the server-side contract module
    // (the API layer never lets one reach the DB).
    assert.throws(() => getPlacePhotoSlot("extra"), /place_photo_slot_invalid/);
    assert.throws(() => validatePlacePhotoMeta("", "x"), /place_photo_title_invalid/);
    assert.throws(
      () => validatePlaceMediaFile({ type: "image/gif", size: 1000 }),
      /place_photo_type_invalid/,
    );
    assert.throws(
      () => validatePlaceMediaFile({ type: "image/jpeg", size: PLACE_MEDIA_MAX_BYTES + 1 }),
      /place_photo_size_invalid/,
    );

    // Deleting the Place cascades (no orphaned media references).
    await db.exec(`delete from public.places where id = 'media-place';`);
    const remaining = await rows(`select count(*)::int as c from public.place_photos`);
    assert.equal(remaining[0].c, 0, "photo references cascade with the Place");
  } finally {
    await db.close();
  }
});
