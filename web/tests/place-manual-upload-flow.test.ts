import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PLACE_PHOTO_SLOTS } from "@/lib/place-media";

/**
 * MANUAL PLACE PHOTO FLOW — pick, upload, then edit metadata (2026-10-19).
 *
 * ROOT CAUSES THIS LOCKS (they were real, not hypothetical):
 *
 *  1. `PlacePhotoInputs` started every slot with an EMPTY title/description
 *     and disabled its upload button until both were filled. Picking a photo
 *     did nothing on its own; the producer had to write metadata and then
 *     press a second "Unggah foto" button. The required flow is pick → upload.
 *  2. Saved metadata was never loaded back into the slot fields, so an
 *     existing photo's title/description appeared blank on reload.
 *  3. The native file input kept its value after a pick, so choosing the same
 *     photo a second time (a retry) fired no change event.
 *  4. `removeSlot()` had no `catch`: a DELETE that failed BEFORE any HTTP
 *     response escaped as an unhandled rejection and the producer saw nothing.
 *  5. A failed photo-list load rendered ordinary empty pickers, making an
 *     unknown canonical state look like "no photo saved yet".
 *
 * The flow rules asserted here: title/description are never an upload
 * prerequisite (safe slot defaults stand in), one request per slot at a time,
 * clear in-progress status, and the previous photo is kept unless the server
 * confirms the write.
 */

const formSource = readFileSync(new URL("../app/producer/places/PlaceForm.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const code = stripComments(formSource);

function between(start: string, end: string): string {
  const from = code.indexOf(start);
  const to = code.indexOf(end, from);
  assert.ok(from >= 0, `missing anchor: ${start}`);
  assert.ok(to > from, `missing end anchor after ${start}: ${end}`);
  return code.slice(from, to);
}

const uploadBody = between("async function uploadSlot", "async function saveSlotMeta");
const metaBody = between("async function saveSlotMeta", "async function removeSlot");
const removeBody = between("async function removeSlot", "return (\n    <section className=\"grid min-w-0 gap-4\" aria-label=\"Media Tempat\">");
const pickerBody = code.slice(code.indexOf("function PlacePhotoInputs"));

// ---------------------------------------------------------------------------
// 1. Picking a file is the upload.
// ---------------------------------------------------------------------------

test("choosing a file uploads immediately, with no second upload button", () => {
  // The native change handler reads the file and calls the upload path.
  assert.match(
    pickerBody,
    /onChange=\{\(event\) => \{[\s\S]*?void onFileChange\(candidate\);/,
    "the file input must start the upload itself",
  );
  assert.match(pickerBody, /const confirmed = await onUpload\(/, "the pick handler awaits the real upload");

  // The old gated controls are gone — no second click, no metadata gate.
  assert.doesNotMatch(code, /Unggah foto/);
  assert.doesNotMatch(code, /Simpan perubahan/);
  assert.doesNotMatch(code, /disabled=\{busy \|\| disabled \|\| !file \|\| !title\.trim\(\)/);
});

test("title and description are not prerequisites for the upload", () => {
  // Empty fields fall back to slot defaults at the call site.
  assert.match(pickerBody, /title\.trim\(\) \|\| defaultTitle/);
  assert.match(pickerBody, /description\.trim\(\) \|\| defaultDescription/);

  // The defaults are derived from the locked slot identity, never invented
  // media facts: slot label + Place name, and the existing slot prompt.
  assert.match(code, /function slotDefaultMeta\(placeName: string, slot: \{ label: string; descriptionPrompt: string \}\)/);
  assert.match(code, /`\$\{slot\.label\}: \$\{placeName\}`\.trim\(\)\.slice\(0, 120\)/);
  assert.match(code, /slot\.descriptionPrompt\.trim\(\)\.slice\(0, 1000\)/);
  assert.match(code, /const defaults = slotDefaultMeta\(place\.name, slot\)/);
});

// ---------------------------------------------------------------------------
// 2. Saved metadata is the slot's starting value.
// ---------------------------------------------------------------------------

test("a saved slot opens with its stored title and description", () => {
  assert.match(pickerBody, /const initialTitle = savedTitle\?\.trim\(\) \? savedTitle : defaultTitle;/);
  assert.match(pickerBody, /const initialDescription = savedDescription\?\.trim\(\) \? savedDescription : defaultDescription;/);
  assert.match(pickerBody, /useState\(initialTitle\)/);
  assert.match(pickerBody, /useState\(initialDescription\)/);
  // Reload / write confirmation re-initialises from the canonical slot state
  // through the saved-identity key (not an effect that could fight typing).
  assert.match(
    code,
    /key=\{`\$\{slot\.key\}:\$\{photo\?\.id \?\? "empty"\}:\$\{photo\?\.title \?\? ""\}:\$\{photo\?\.description \?\? ""\}`\}/,
  );
  assert.match(code, /savedTitle=\{photo\?\.title \?\? null\}/);
  assert.match(code, /savedDescription=\{photo\?\.description \?\? null\}/);
});

// ---------------------------------------------------------------------------
// 3. Re-picking the same photo must fire again.
// ---------------------------------------------------------------------------

test("the native input is cleared so the same photo can be selected again", () => {
  assert.match(pickerBody, /event\.target\.value = "";[\s\S]*?void onFileChange\(candidate\);/);
});

// ---------------------------------------------------------------------------
// 4. One request per slot, with a visible status.
// ---------------------------------------------------------------------------

test("a slot cannot send overlapping uploads or metadata saves", () => {
  // Parent-level guard, not only a disabled button.
  assert.ok(
    (code.match(/if \(busySlotsRef\.current\.has\(slotKey\)\) return false;/g) ?? []).length >= 2,
    "both writes must be guarded against a duplicate request",
  );
  assert.match(uploadBody, /busySlotsRef\.current\.add\(slotKey\)/);
  assert.match(metaBody, /busySlotsRef\.current\.add\(slotKey\)/);

  // The picker is disabled while busy and announces the operation.
  assert.match(pickerBody, /disabled=\{busy \|\| disabled\}/);
  assert.match(pickerBody, /aria-busy=\{busy\}/);
  assert.match(pickerBody, /role="status">\{busyLabel\}/);
  assert.match(code, /busyLabel=\{busyMode === "meta" \? "Menyimpan judul dan deskripsi…" : "Mengunggah foto…"\}/);
});

// ---------------------------------------------------------------------------
// 5. Failures never claim success and never clear the saved photo.
// ---------------------------------------------------------------------------

test("an upload failure keeps the previous photo and reports the error", () => {
  const okGuard = uploadBody.indexOf("if (!response.ok) {");
  const slotWrite = uploadBody.indexOf("setSlots(");
  assert.ok(okGuard > 0, "the upload must check the server response");
  assert.ok(slotWrite > okGuard, "the slot may only be replaced after a confirmed response");
  assert.match(uploadBody, /setMessage\(replacing \? "Foto diganti\." : "Foto tersimpan\."\)/);
  assert.ok(
    uploadBody.indexOf('setMessage(replacing ? "Foto diganti." : "Foto tersimpan.")') > okGuard,
    "the success message belongs after the confirmed write",
  );

  // The fetch rejection branch reports a network failure and writes no slot.
  const catchBlock = uploadBody.slice(uploadBody.indexOf("} catch {"), uploadBody.indexOf("} finally {"));
  assert.match(catchBlock, /mediaErrorLabel\("place_media_network_error"\)/);
  assert.doesNotMatch(catchBlock, /setSlots\(/);
  assert.doesNotMatch(catchBlock, /setMessage\(/);

  // The picker drops only the pending file name; the saved photo is untouched.
  assert.match(pickerBody, /if \(!confirmed\) setFile\(null\);/);
});

test("a DELETE that fails before any HTTP response is reported, not swallowed", () => {
  assert.match(removeBody, /\} catch \{/);
  const catchBlock = removeBody.slice(removeBody.indexOf("} catch {"), removeBody.indexOf("} finally {"));
  assert.match(catchBlock, /mediaErrorLabel\("place_media_network_error"\)/);
  assert.doesNotMatch(catchBlock, /setSlots\(/);
  assert.doesNotMatch(catchBlock, /setMessage\(/);

  // Success is still only claimed for an ok response.
  const okBranch = removeBody.slice(removeBody.indexOf("if (response.ok) {"));
  assert.match(okBranch, /setMessage\("Foto dihapus\."\)/);
});

test("every write clears the previous success message before it starts", () => {
  for (const body of [uploadBody, metaBody, removeBody]) {
    const start = body.indexOf("setSlotError(");
    const clear = body.indexOf('setMessage("")');
    assert.ok(clear > start, "no stale success message may survive into a new request");
  }
});

// ---------------------------------------------------------------------------
// 6. A failed photo-list load is honest and blocks blind replacement.
// ---------------------------------------------------------------------------

test("a failed photo load is reported, offers a retry, and disables pickers", () => {
  assert.match(code, /setLoadError\("Foto Tempat tidak dapat dimuat\. Periksa koneksi lalu muat ulang\."\)/);
  assert.match(code, /setReloadNonce\(\(current\) => current \+ 1\)/);
  assert.match(code, /Muat ulang foto/);
  assert.match(code, /disabled=\{Boolean\(loadError\)\}/);
  // The effect reloads the canonical list on retry.
  assert.match(code, /\}, \[place\.id, reloadNonce\]\);/);
});

// ---------------------------------------------------------------------------
// 7. Metadata remains editable without a new endpoint.
// ---------------------------------------------------------------------------

test("saved metadata is edited through the same slot endpoint, without a file", () => {
  assert.match(metaBody, /body\.append\("title", title\)/);
  assert.match(metaBody, /body\.append\("description", description\)/);
  assert.doesNotMatch(metaBody, /body\.append\("file"/);
  assert.match(metaBody, /fetch\(`\/api\/producer\/places\/\$\{place\.id\}\/photos\/\$\{slotKey\}`, \{ method: "POST", body \}\)/);
  assert.match(pickerBody, /Simpan judul &amp; deskripsi/);
  assert.match(pickerBody, /onSaveMeta\(title\.trim\(\), description\.trim\(\)\)/);
  // No invented metadata endpoint.
  assert.equal(code.includes("/photos/meta"), false);
  assert.equal(code.includes("/metadata"), false);
});

// ---------------------------------------------------------------------------
// 8. The locked contract around the flow is unchanged.
// ---------------------------------------------------------------------------

test("the five manual slots and the AI alternative are untouched", () => {
  assert.deepEqual(
    PLACE_PHOTO_SLOTS.map((slot) => slot.key),
    ["hook", "process", "place", "people", "product"],
  );
  assert.equal(PLACE_PHOTO_SLOTS[0].label, "Hook");
  assert.equal(PLACE_PHOTO_SLOTS[1].label, "Proses Produksi");
  assert.equal(PLACE_PHOTO_SLOTS[2].label, "Suasana Tempat");
  assert.equal(PLACE_PHOTO_SLOTS[3].label, "Orang di Baliknya");
  assert.equal(PLACE_PHOTO_SLOTS[4].label, "Hasil / Produk");

  // Manual and AI stay alternative methods, and AI is not rebuilt here.
  assert.match(code, /mediaMethod === "manual" &&/);
  assert.match(code, /mediaMethod === "generate-ai" &&/);
  assert.match(code, /<PlaceAiMediaPanel key=\{place\.id\} placeId=\{place\.id\} \/>/);
});
