import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * PRODUCER PLACE PHOTO UPLOAD — failure-safe regression (audit fix, 2026-10-05).
 *
 * The bug that reached the Producer UI: a Hook upload stored the file in
 * Supabase Storage and the reference in `place_photos`, the route then
 * DELETED the previously working object, and only afterwards synchronised
 * `places.cover_image_url`. Two things went wrong:
 *
 *   1. if the cover synchronisation failed, the endpoint threw a generic
 *      `place_media_upload_failed` AFTER the photo was already stored, so the
 *      producer saw "Foto tidak dapat disimpan. Coba lagi." for work that had
 *      actually succeeded;
 *   2. the previous working object had already been destroyed by then, so the
 *      Place was left with a broken cover and no way back to the old image.
 *
 * The locked contract this suite pins down, in this exact order:
 *
 *   1. Producer authorization
 *   2. multipart/form-data parsing
 *   3. file validation
 *   4. title/description validation
 *   5. Storage upload
 *   6. place_photos INSERT/UPDATE
 *   7. Hook cover_image_url synchronisation
 *   8. previous Storage object removal — LAST, only after 6 and 7 succeeded
 *   9. response
 *
 * Invariants that must survive any future edit: Hook is the public Place cover,
 * ONE Hook photo is sufficient, the other four slots are never required and
 * never touch the cover, Producer authorization / bucket / place_photos schema
 * are unchanged, and Home keeps reading `places.cover_image_url`.
 */

const ROUTE = "app/api/producer/places/[placeId]/photos/[slotKey]/route.ts";
const PLACE_MEDIA = "lib/place-media.ts";
const PLACE_MEDIA_STORAGE = "lib/place-media-storage.ts";
const PLACE_FORM = "app/producer/places/PlaceForm.tsx";

const routeSource = readFileSync(new URL(`../${ROUTE}`, import.meta.url), "utf8");
const placeMediaSource = readFileSync(new URL(`../${PLACE_MEDIA}`, import.meta.url), "utf8");
const storageSource = readFileSync(new URL(`../${PLACE_MEDIA_STORAGE}`, import.meta.url), "utf8");
const formSource = readFileSync(new URL(`../${PLACE_FORM}`, import.meta.url), "utf8");

/** Every index of `needle` in `haystack`, in source order. */
function indicesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let at = -1;
  while ((at = haystack.indexOf(needle, at + 1)) !== -1) found.push(at);
  return found;
}

/** The POST handler only — the DELETE handler must not satisfy POST assertions. */
const postSource = routeSource.slice(0, routeSource.indexOf("export async function DELETE"));
const deleteSource = routeSource.slice(routeSource.indexOf("export async function DELETE"));

const SAVE = postSource.indexOf("const saved = previous.data");
const COVER = postSource.indexOf("const coverSync = resolvePlaceCoverSync");
const PREVIOUS_REMOVAL = postSource.indexOf("removePlacePhotoObject(previous.data.storage_path)");
// The file path's success response — the metadata-only branch returns a row
// earlier in the source and must not satisfy the ordering assertions.
const RESPONSE = postSource.indexOf("return NextResponse.json(mapPlacePhotoRow", PREVIOUS_REMOVAL);

/** Anchors must all exist, or every ordering assertion below is meaningless. */
assert.ok(SAVE > 0, "POST must compute the canonical place_photos save");
assert.ok(COVER > 0, "POST must resolve the cover sync");
assert.ok(PREVIOUS_REMOVAL > 0, "POST must still remove the replaced object");
assert.ok(RESPONSE > 0, "POST must return the saved slot row");

// ---------------------------------------------------------------------------
// Preconditions 1-5 are unchanged: auth, parse, validate, validate, upload.
// ---------------------------------------------------------------------------

test("the fail-closed preconditions run before any Storage write", () => {
  const auth = postSource.indexOf("await requireProducerAccess(request, placeId");
  const parse = postSource.indexOf("await request.formData()");
  const fileGate = postSource.indexOf("validatePlaceMediaFile(");
  const metaGate = postSource.indexOf("validatePlacePhotoMeta(");
  const upload = postSource.indexOf("await uploadPlacePhoto(");

  assert.ok(auth > 0, "POST must verify Producer access");
  assert.ok(auth < parse, "authorization must precede multipart parsing");
  assert.ok(parse < fileGate, "multipart parsing must precede file validation");
  assert.ok(fileGate < metaGate, "file validation must precede title/description validation");
  assert.ok(metaGate < upload, "metadata validation must precede the Storage upload");
  assert.ok(
    postSource.includes('["owner", "manager", "editor"]'),
    "the existing Producer authorization role set must be unchanged",
  );
});

test("a request without a file is a metadata edit on an existing slot, never a new upload", () => {
  // 2026-10-19: photo uploads happen the moment the file is picked, so the
  // endpoint also accepts a file-less POST for editing title/description.
  // A slot with NO saved reference is still refused — a metadata-only row
  // must never be invented, and no Storage write may happen without a file.
  const previousLookup = postSource.indexOf("const previous = await supabase");
  const metadataBranch = postSource.indexOf("if (!file) {");
  const upload = postSource.indexOf("await uploadPlacePhoto(");

  assert.ok(previousLookup > 0, "the endpoint must look up the saved reference first");
  assert.ok(metadataBranch > previousLookup, "the metadata branch must know whether a slot exists");
  assert.ok(upload > metadataBranch, "the Storage upload stays on the file path only");
  assert.ok(
    postSource.includes('if (!previous.data) throw new PlaceMediaError("place_photo_file_required")'),
    "a missing file on an unsaved slot must fail closed",
  );

  const block = postSource.slice(metadataBranch, upload);
  assert.ok(block.includes("title: meta.title") && block.includes("description: meta.description"));
  assert.ok(block.includes('update({ title: meta.title'), "the metadata edit updates the existing row");
  assert.ok(!block.includes("uploadPlacePhoto"), "no Storage write on the metadata-only path");
  assert.ok(!block.includes("resolvePlaceCoverSync"), "an unchanged object cannot change the cover");
});

// ---------------------------------------------------------------------------
// 1. A new Hook upload succeeds → Storage + place_photos + cover_image_url all
//    point at the new object.
// ---------------------------------------------------------------------------

test("a new Hook upload saves the reference and the cover, and only then answers", () => {
  assert.ok(SAVE < COVER, "the canonical reference must be saved before the cover sync");
  assert.ok(COVER < RESPONSE, "the cover sync must complete before the success response");

  assert.ok(
    postSource.includes('resolvePlaceCoverSync({ slotKey: slot.key, action: "save", url: uploaded.url })'),
    "the POST cover sync must come from the single shared rule, fed the uploaded URL",
  );
  assert.ok(
    postSource.includes('const cover = await supabase.from("places").update(coverSync).eq("id", placeId);'),
    "the cover must be written to places.cover_image_url",
  );
  // The insert branch must carry the new object, and the metadata the producer typed.
  assert.ok(
    postSource.includes("storage_path: uploaded.storagePath"),
    "the saved reference must point at the newly uploaded object",
  );
  assert.ok(
    postSource.includes("title: meta.title") && postSource.includes("description: meta.description"),
    "the producer-supplied title and description must be persisted",
  );
});

// ---------------------------------------------------------------------------
// 2. A new non-Hook upload succeeds → no cover change.
// ---------------------------------------------------------------------------

test("non-Hook slots never write cover_image_url", () => {
  assert.ok(
    placeMediaSource.includes("if (params.slotKey !== PLACE_COVER_SLOT_KEY) return null;"),
    "resolvePlaceCoverSync must short-circuit for every non-hook slot",
  );
  assert.ok(
    placeMediaSource.includes('export const PLACE_COVER_SLOT_KEY = "hook";'),
    "the hook slot must be the one cover-owning slot",
  );

  // The POST only ever writes the cover through `coverSync`, which is null for
  // the four content slots — so exactly one places.update may exist in POST.
  const coverWrites = indicesOf(postSource, '.from("places").update(');
  assert.equal(coverWrites.length, 1, "POST must write places.cover_image_url from exactly one place");
  assert.ok(
    postSource.includes("update(coverSync)"),
    "that single cover write must be driven by resolvePlaceCoverSync, not a hardcoded payload",
  );
});

// ---------------------------------------------------------------------------
// 3. Hook replacement succeeds → new reference + cover are consistent, and the
//    old object is removed only after success.
// ---------------------------------------------------------------------------

test("a Hook replacement persists the new state before removing the old object", () => {
  assert.ok(
    postSource.includes('previous.data && previous.data.storage_path !== uploaded.storagePath'),
    "the replaced object must only be removed when it is genuinely a different object",
  );
  assert.ok(
    postSource.includes("await removePlacePhotoObject(previous.data.storage_path).catch(() => {})"),
    "removing the replaced object must be best-effort: a Storage hiccup cannot fail a saved upload",
  );
  assert.equal(
    indicesOf(postSource, "removePlacePhotoObject(previous.data.storage_path)").length,
    1,
    "the previous object must be removed from exactly one place in POST",
  );
});

// ---------------------------------------------------------------------------
// 4. Storage/reference failure → no dangling object and no dangling reference.
// ---------------------------------------------------------------------------

test("a failed place_photos save removes the new object and still reports failure", () => {
  const guard = postSource.indexOf("if (saved.error || !saved.data) {");
  assert.ok(guard > SAVE, "the save-failure guard must sit directly after the canonical write");

  const block = postSource.slice(guard, postSource.indexOf("}", postSource.indexOf("throw", guard)));
  assert.ok(
    block.includes("removePlacePhotoObject(uploaded.storagePath)"),
    "a failed canonical write must remove the object it just uploaded",
  );
  assert.ok(
    block.includes('throw new Error("place_media_upload_failed")'),
    "after cleaning up, the route must still report the failure",
  );

  // The guard must run BEFORE the previous object is touched, so a failed save
  // can never leave the Place with neither object.
  assert.ok(guard < PREVIOUS_REMOVAL, "the save-failure guard must precede any previous-object removal");
});

// ---------------------------------------------------------------------------
// 5 + 6 + 7. Hook cover-sync failure → no misleading half-saved state.
// ---------------------------------------------------------------------------

test("a Hook cover-sync failure reconciles the reference and reports failure", () => {
  const guard = postSource.indexOf("if (cover.error) {");
  assert.ok(guard > COVER, "the cover-failure guard must sit inside the cover-sync block");

  // The rollback block runs from the guard up to the LAST-MUTATION removal, so
  // this slice cannot accidentally satisfy the assertions from success-path code.
  const block = postSource.slice(guard, PREVIOUS_REMOVAL);
  assert.ok(
    block.includes('throw new Error("place_media_upload_failed")'),
    "a cover-sync failure must surface as a failure, never as a silent success",
  );
  assert.ok(
    block.includes("removePlacePhotoObject(uploaded.storagePath)"),
    "a cover-sync failure must remove the newly uploaded object",
  );

  // 6. With a previous reference, the previous reference is restored.
  assert.ok(
    block.includes("storage_path: previous.data.storage_path")
      && block.includes("title: previous.data.title")
      && block.includes("description: previous.data.description"),
    "a replacement rollback must restore the previous reference fields verbatim",
  );

  // 7. With no previous reference, the row that was just written is removed.
  assert.ok(
    block.includes('from("place_photos").delete().eq("id", saved.data.id)'),
    "a brand-new Hook cover-sync failure must delete the reference it just wrote",
  );

  // Both branches must be selected by whether a previous reference existed.
  assert.ok(
    block.indexOf("if (previous.data) {") > -1 && block.indexOf("} else {") > -1,
    "the rollback must branch on the existence of a previous reference",
  );
});

test("a cover-sync failure never destroys the previously working object", () => {
  const guard = postSource.indexOf("if (cover.error) {");
  const rollback = postSource.slice(guard, PREVIOUS_REMOVAL);
  assert.ok(
    !rollback.includes("removePlacePhotoObject(previous.data.storage_path)"),
    "the rollback must never delete the object the restored reference points at",
  );
  assert.ok(
    guard < PREVIOUS_REMOVAL,
    "the previous object must only be removed after the cover sync has succeeded",
  );
});

// ---------------------------------------------------------------------------
// 8. The client error surface maps the failure to the message the producer saw.
// ---------------------------------------------------------------------------

test("the client maps place_media_upload_failed to the observed Indonesian message", () => {
  assert.ok(
    formSource.includes('place_media_upload_failed: "Foto tidak dapat disimpan. Coba lagi."'),
    "the observed message must stay mapped to the upload-failed code",
  );
  assert.ok(
    formSource.includes("export function mediaErrorLabel(code: string)"),
    "every backend code must be routed through one label function",
  );
});

// ---------------------------------------------------------------------------
// 9. DELETE syncs the cover and surfaces failure exactly like the upload path.
// ---------------------------------------------------------------------------

test("DELETE clears the hook cover and reports a failed cover clear", () => {
  assert.ok(
    deleteSource.includes('resolvePlaceCoverSync({ slotKey: slot.key, action: "delete" })'),
    "DELETE must resolve the hook-delete cover sync",
  );
  assert.ok(
    deleteSource.includes('const cover = await supabase.from("places").update(coverSync).eq("id", placeId);'),
    "DELETE must clear places.cover_image_url",
  );
  assert.ok(
    deleteSource.includes('if (cover.error) throw new Error("place_media_upload_failed")'),
    "a failed cover clear on DELETE must surface a failure, not a silent success",
  );

  // The reference row goes before the cover, so a failed cover clear is
  // reported rather than hidden behind a partial success.
  assert.ok(
    deleteSource.indexOf('from("place_photos").delete()') < deleteSource.indexOf('update(coverSync)'),
    "DELETE must remove the reference before clearing the cover",
  );
});

test("DELETE clears the cover before it deletes the object the cover points at", () => {
  // ROOT CAUSE (2026-10-19): the Storage object used to be removed before the
  // Hook cover was cleared. If clearing the cover failed (or the Storage call
  // threw), places.cover_image_url was left pointing at a deleted object and
  // Home showed a permanently broken cover. The public reference must be
  // reconciled first; object cleanup is the LAST, best-effort step.
  const referenceRemoval = deleteSource.indexOf('from("place_photos").delete()');
  const coverClear = deleteSource.indexOf('update(coverSync)');
  const objectRemoval = deleteSource.indexOf("removePlacePhotoObject(existing.data.storage_path)");

  assert.ok(referenceRemoval >= 0 && coverClear > referenceRemoval);
  assert.ok(objectRemoval > coverClear, "the object must outlive the reference that points at it");
  assert.ok(
    deleteSource.includes("await removePlacePhotoObject(existing.data.storage_path).catch(() => {})"),
    "object cleanup must be best-effort after the canonical state is committed",
  );
  // No failure response may follow the cleanup: it cannot fail the delete.
  const tail = deleteSource.slice(objectRemoval);
  assert.ok(tail.indexOf("NextResponse.json({ ok: true })") > 0);
});

// ---------------------------------------------------------------------------
// 10. Previous-object removal is the LAST mutation, after save + cover sync.
// ---------------------------------------------------------------------------

test("previous-object removal is the last mutation, after the save and the cover sync", () => {
  assert.ok(SAVE < PREVIOUS_REMOVAL, "the previous object must not be removed before the save");
  assert.ok(COVER < PREVIOUS_REMOVAL, "the previous object must not be removed before the cover sync");
  assert.ok(PREVIOUS_REMOVAL < RESPONSE, "the removal must happen inside the request, before the response");

  // Nothing that mutates canonical state may follow it.
  const tail = postSource.slice(PREVIOUS_REMOVAL, RESPONSE);
  assert.ok(
    !tail.includes(".update(") && !tail.includes(".insert(") && !tail.includes(".delete()"),
    "no canonical write may follow the previous-object removal",
  );
});

// ---------------------------------------------------------------------------
// Locked invariants that must not regress.
// ---------------------------------------------------------------------------

test("the storage contract is unchanged: same bucket, same layout, service-role only", () => {
  assert.ok(
    placeMediaSource.includes('export const PLACE_MEDIA_BUCKET = "place-media";'),
    "the existing Storage bucket must be reused unchanged",
  );
  assert.ok(
    storageSource.includes("`places/${placeId}/${params.slotKey}-${randomSuffix()}.${ext}`"),
    "the existing object layout must be reused unchanged",
  );
  assert.ok(
    storageSource.includes("upsert: false"),
    "uploads must stay non-overwriting",
  );
});

test("one Hook photo is sufficient — no all-five-slots requirement is introduced", () => {
  const postHandler = routeSource.slice(0, routeSource.indexOf("export async function DELETE"));
  assert.ok(
    !postHandler.includes("PLACE_MEDIA_MIN_SLOTS"),
    "the upload endpoint must never require all five slots",
  );
  // The slot list itself is untouched: five standard slots, Hook first.
  assert.ok(
    placeMediaSource.includes('key: "hook"'),
    "the hook slot must still exist as a standard slot",
  );
  assert.ok(
    !placeMediaSource.includes("process/place/people/product"),
    "no content slot may be described as a cover writer",
  );
});

test("Home keeps rendering places.cover_image_url, never place_photos directly", () => {
  // Home renders through the discovery component, which maps the canonical
  // `places.cover_image_url` column into `coverImageUrl`.
  const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
  assert.ok(
    homeDiscovery.includes("place.coverImageUrl"),
    "Home must keep rendering the canonical Place cover field",
  );
  assert.ok(
    !homeDiscovery.includes("place_photos"),
    "Home must never read place_photos directly",
  );
});