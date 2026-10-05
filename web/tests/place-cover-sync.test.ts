import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  PLACE_COVER_SLOT_KEY,
  PLACE_PHOTO_SLOTS,
  getPlacePhotoSlot,
  isPlacePhotoSlotKey,
  resolvePlaceCoverSync,
} from "@/lib/place-media";

/**
 * PRODUCER HOOK ⇄ PLACE COVER SYNC (audit fix, 2026-10-05)
 *
 * ROOT CAUSE THIS LOCKS: the upload API saved the file to Storage and the
 * reference to `place_photos`, but never touched `places.cover_image_url`.
 * Home and the Place hero render `place.coverImageUrl`, so a successful Hook
 * upload was invisible on Home — the Producer had done the work and nothing
 * appeared.
 *
 * The rule is ONE pure function (`resolvePlaceCoverSync`), called by the
 * existing POST/DELETE handlers, so both the behaviour and its wiring are
 * testable without a database:
 *
 *   hook   + save   → cover_image_url = the uploaded object's public URL
 *   hook   + delete → cover_image_url = null
 *   other  + save   → null (do not touch the cover)
 *   other  + delete → null (do not touch the cover)
 *
 * PRESERVED, and asserted here: the Producer authorization gate, the
 * service-role Storage architecture, the `place_photos` contract, the five
 * standard slots, Home's rendering path, and the database schema. One Hook is
 * enough — there is deliberately no "all five slots" requirement, and Home
 * still never reads `place_photos` directly.
 */

const route = readFileSync(
  new URL("../app/api/producer/places/[placeId]/photos/[slotKey]/route.ts", import.meta.url),
  "utf8",
);
const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const migration0018 = readFileSync(new URL("../supabase/migrations/0018_place_cover_image.sql", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

const routeCode = stripComments(route);

// ---------------------------------------------------------------------------
// 1. Hook upload synchronizes the cover (the bug).
// ---------------------------------------------------------------------------

test("a successful Hook upload points the Place cover at the uploaded object", () => {
  const url = "https://project.supabase.co/storage/v1/object/public/place-media/places/bakso-migran/hook-abc.png";
  assert.deepEqual(resolvePlaceCoverSync({ slotKey: "hook", action: "save", url }), {
    cover_image_url: url,
  });
});

test("replacing a Hook changes the cover URL to the new object", () => {
  const first = "https://project.supabase.co/storage/v1/object/public/place-media/places/p/hook-1.png";
  const second = "https://project.supabase.co/storage/v1/object/public/place-media/places/p/hook-2.png";
  const before = resolvePlaceCoverSync({ slotKey: "hook", action: "save", url: first });
  const after = resolvePlaceCoverSync({ slotKey: "hook", action: "save", url: second });
  assert.deepEqual(before, { cover_image_url: first });
  assert.deepEqual(after, { cover_image_url: second });
  assert.notEqual(before?.cover_image_url, after?.cover_image_url, "the cover must follow the replacement");
});

// ---------------------------------------------------------------------------
// 2. Hook deletion clears the cover.
// ---------------------------------------------------------------------------

test("deleting a Hook clears the Place cover", () => {
  assert.deepEqual(resolvePlaceCoverSync({ slotKey: "hook", action: "delete" }), {
    cover_image_url: null,
  });
  // Deletion has no URL to point at, and must not invent one.
  assert.equal(resolvePlaceCoverSync({ slotKey: "hook", action: "delete", url: "https://x/y.png" })?.cover_image_url, null);
});

// ---------------------------------------------------------------------------
// 3. The four other slots must NEVER touch the cover.
// ---------------------------------------------------------------------------

test("process / place / people / product never modify the cover", () => {
  const url = "https://project.supabase.co/storage/v1/object/public/place-media/places/p/process-abc.png";
  for (const slot of ["process", "place", "people", "product"] as const) {
    assert.equal(
      resolvePlaceCoverSync({ slotKey: slot, action: "save", url }),
      null,
      `${slot} upload must not change the cover`,
    );
    assert.equal(
      resolvePlaceCoverSync({ slotKey: slot, action: "delete" }),
      null,
      `${slot} delete must not change the cover`,
    );
  }
});

test("a save without a usable URL never clears a working cover", () => {
  for (const url of [undefined, null, ""]) {
    assert.equal(resolvePlaceCoverSync({ slotKey: "hook", action: "save", url }), null);
  }
  // An unknown slot key is not the cover slot, and must not throw or clear it.
  assert.equal(resolvePlaceCoverSync({ slotKey: "HOOK", action: "save", url: "https://x/y.png" }), null);
  assert.equal(resolvePlaceCoverSync({ slotKey: "cover", action: "delete" }), null);
});

// ---------------------------------------------------------------------------
// 4. The route actually calls the rule — both handlers, in the right place.
// ---------------------------------------------------------------------------

test("the POST handler applies the cover sync from the uploaded object", () => {
  assert.match(routeCode, /resolvePlaceCoverSync\(\{ slotKey: slot\.key, action: "save", url: uploaded\.url \}\)/);
  const syncIdx = routeCode.indexOf('resolvePlaceCoverSync({ slotKey: slot.key, action: "save"');
  // The save-failure guard is now a BLOCK: it removes the object it just
  // uploaded before throwing, so a failed reference write never leaves a
  // dangling Storage object behind. The cover sync still runs only after the
  // reference is successfully saved.
  const savedIdx = routeCode.indexOf("if (saved.error || !saved.data) {");
  assert.ok(savedIdx >= 0, "a failed reference save must be handled explicitly");
  assert.ok(syncIdx > savedIdx, "the cover sync runs only after the reference is saved");
  // It writes the canonical Place column through the service-role client.
  assert.match(routeCode, /const cover = await supabase\.from\("places"\)\.update\(coverSync\)\.eq\("id", placeId\);/);
  // ...and fails loudly rather than serving a stale cover. The failed cover
  // sync reconciles the reference back to the previous photo (or removes the
  // row it just wrote) and removes the new object, so the request never
  // reports a failure while a half-saved photo stays on the Place.
  assert.match(routeCode, /if \(cover\.error\) throw new Error\("place_media_upload_failed"\);/);
  assert.match(
    routeCode,
    /removePlacePhotoObject\(previous\.data\.storage_path\)\.catch\(\(\) => \{\}\)/,
    "removing the replaced object must stay best-effort so it cannot fail an already-saved upload",
  );
});

test("the DELETE handler clears the cover only after the reference is deleted", () => {
  assert.match(routeCode, /resolvePlaceCoverSync\(\{ slotKey: slot\.key, action: "delete" \}\)/);
  const deleteIdx = routeCode.indexOf('from("place_photos").delete()');
  const syncIdx = routeCode.indexOf('resolvePlaceCoverSync({ slotKey: slot.key, action: "delete"');
  assert.ok(deleteIdx >= 0 && syncIdx > deleteIdx, "the cover is cleared only after the reference is gone");
});

test("the cover column is written in exactly the two places the rule allows", () => {
  const coverWrites = routeCode.match(/update\(coverSync\)/g) ?? [];
  assert.equal(coverWrites.length, 2, "one write in POST, one in DELETE");
  // No hand-written cover_image_url assignment can bypass the rule.
  assert.doesNotMatch(routeCode, /cover_image_url:/);
});

// ---------------------------------------------------------------------------
// 5. Everything that must NOT have changed.
// ---------------------------------------------------------------------------

test("Producer authorization, storage architecture, and the media contract are intact", () => {
  // The gate still runs before any storage or DB write, in both handlers.
  assert.equal(
    (routeCode.match(/requireProducerAccess\(request, placeId, \["owner", "manager", "editor"\]\)/g) ?? []).length,
    2,
  );
  const gateIdx = routeCode.indexOf('requireProducerAccess(request, placeId, ["owner", "manager", "editor"])');
  const uploadIdx = routeCode.indexOf("uploadPlacePhoto({");
  assert.ok(gateIdx >= 0 && uploadIdx > gateIdx, "authorization precedes the upload");
  // Storage + reference mechanics unchanged.
  assert.match(routeCode, /createSupabaseServiceClient\(\)/);
  assert.match(routeCode, /uploadPlacePhoto\(\{/);
  assert.match(routeCode, /removePlacePhotoObject\(/);
  assert.match(routeCode, /\.eq\("place_id", placeId\)/);
  assert.match(routeCode, /\.eq\("slot_key", slot\.key\)/);
  // Server-side validation unchanged.
  assert.match(routeCode, /validatePlaceMediaFile\(\{ type: file\.type, size: file\.size \}\)/);
  assert.match(routeCode, /validatePlacePhotoMeta\(form\.get\("title"\), form\.get\("description"\)\)/);
});

test("the five standard slots are unchanged and hook is the cover slot", () => {
  assert.deepEqual(
    PLACE_PHOTO_SLOTS.map((slot) => slot.key),
    ["hook", "process", "place", "people", "product"],
  );
  assert.equal(PLACE_COVER_SLOT_KEY, "hook");
  assert.equal(getPlacePhotoSlot("hook").key, PLACE_COVER_SLOT_KEY);
  assert.equal(isPlacePhotoSlotKey("hook"), true);
  assert.equal(isPlacePhotoSlotKey("nope"), false);
});

test("Home still renders coverImageUrl and never reads place_photos directly", () => {
  const homeCode = stripComments(homeDiscovery);
  assert.match(homeCode, /\{place\.coverImageUrl \? \(/);
  assert.doesNotMatch(homeCode, /place_photos/);
  // No new upload mechanism was introduced on the Home side.
  assert.doesNotMatch(homeCode, /uploadPlacePhoto|resolvePlaceCoverSync/);
});

test("the schema is untouched: the cover column keeps its existing contract", () => {
  assert.match(migration0018, /add column if not exists cover_image_url text;/);
  // Only HTTPS URLs or NULL are storable, which is what the sync writes.
  assert.match(migration0018, /check \(cover_image_url is null or cover_image_url ~\* '\^https:\/\/'\);/);
});