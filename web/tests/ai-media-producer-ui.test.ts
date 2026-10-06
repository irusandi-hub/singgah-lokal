import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  AI_MEDIA_ACCEPTED_TYPES,
  AI_MEDIA_MAX_BYTES,
  AI_MEDIA_OUTPUT_SLOTS,
  AI_MEDIA_SOURCE_SLOTS,
} from "@/lib/ai-media";

/**
 * PRODUCER AI PLACE MEDIA UI (locked foundation).
 *
 * The Producer surface must:
 *  - offer exactly the 4 locked source slots and the 2 locked outputs;
 *  - reuse the EXISTING AI media APIs (sources / outputs / approve);
 *  - never expose an active generation action, and keep "Generate Ulang" locked;
 *  - never auto-publish: both outputs are drafts until a Producer decides;
 *  - never write the canonical cover directly (only the server approval path);
 *  - import no server-only helper into the client bundle and name no AI vendor;
 *  - leave the standard 5 Place photo slots untouched.
 */

function read(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

/** Comments explain the code; they are never rendered, so they are ignored. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const panel = read("app/producer/places/PlaceAiMediaPanel.tsx");
const panelCode = stripComments(panel);
const placeForm = read("app/producer/places/PlaceForm.tsx");
const placeFormCode = stripComments(placeForm);

// ===========================================================================
// The locked slot vocabulary
// ===========================================================================

test("the panel is driven by the locked source and output slot vocabulary", () => {
  assert.match(panelCode, /AI_MEDIA_SOURCE_SLOTS\.map\(/);
  assert.match(panelCode, /AI_MEDIA_OUTPUT_SLOTS\.map\(/);
});

test("the source slots are exactly Tempat / Bahan / Proses Produksi / Hasil", () => {
  assert.deepStrictEqual(
    AI_MEDIA_SOURCE_SLOTS.map((slot) => [slot.key, slot.label]),
    [
      ["place", "Tempat"],
      ["material", "Bahan"],
      ["process", "Proses Produksi"],
      ["result", "Hasil"],
    ],
  );
});

test("the outputs are exactly Hook Image (portrait) and Place Story Image (landscape)", () => {
  assert.deepStrictEqual(
    AI_MEDIA_OUTPUT_SLOTS.map((slot) => [slot.key, slot.label, slot.aspect]),
    [
      ["hook", "Hook Image", "portrait"],
      ["place_story", "Place Story Image", "landscape"],
    ],
  );
});

// ===========================================================================
// Existing APIs are reused (no parallel/new backend call)
// ===========================================================================

test("sources upload through the existing private source API", () => {
  assert.match(panelCode, /\/api\/producer\/places\/\$\{placeId\}\/ai-media\/sources\/\$\{sourceKey\}/);
  assert.match(panelCode, /method: "POST"/);
});

test("the source list is read from the existing AI media API", () => {
  assert.match(panelCode, /\/api\/producer\/places\/\$\{placeId\}\/ai-media`/);
});

test("outputs are read from the existing read-only outputs API", () => {
  assert.match(panelCode, /\/api\/producer\/places\/\$\{placeId\}\/ai-media\/outputs/);
});

test("approval and rejection use the existing approval API", () => {
  assert.match(panelCode, /\/api\/producer\/places\/\$\{placeId\}\/ai-media\/approve/);
  assert.match(panelCode, /decideOutput\(slot\.key, "approved"\)/);
  assert.match(panelCode, /decideOutput\(slot\.key, "rejected"\)/);
});

// ===========================================================================
// Generation stays LOCKED and is never an active client action
// ===========================================================================

test("Generate Ulang is never an active client action", () => {
  // The panel must not call the regeneration route. Generate Ulang stays locked
  // in the architecture; the client cannot bypass it.
  assert.equal(panelCode.includes("generate-ulg"), false, "the panel must not call generate-ulg");
  // The lock is stated as text, never as an enabled control.
  assert.match(panelCode, /Generate Ulang/);
});

test("the initial generation action is driven by the server capability endpoint", () => {
  // Buat Gambar posts to the INITIAL generation path, not the regeneration path.
  assert.match(
    panelCode,
    /\/api\/producer\/places\/\$\{placeId\}\/ai-media\/generate`/,
  );
  assert.match(panelCode, /createGeneration/);
  assert.match(panelCode, /" Buat Gambar"|Buat Gambar"/);
});

test("initial generation is enabled only when the server says it is available", () => {
  // The panel reads /ai-media/generate and only enables Buat Gambar when the
  // server capability is available AND all 4 sources are complete.
  assert.match(panelCode, /sourcesComplete/);
  assert.match(panelCode, /generationAvailable/);
  // The server remains the authority: the client does not compute generation
  // permission from local state alone, and it only POSTs to /ai-media/generate
  // (the initial generation path) after the server said generation is possible.
  assert.match(panelCode, /fetch\(`\/api\/producer\/places\/\$\{placeId\}\/ai-media\/generate`/);
  assert.match(
    panelCode,
    /available: response\.data\.available === true|available: data\.available === true/,
  );
});

test("no generation is faked when no provider is configured", () => {
  // The panel must not fabricate outputs, a provider name, or a success.
  assert.match(
    panelCode,
    /ai_media_generation_locked|ai_media_generation_failed|ai_media_quota_exhausted/,
  );
  // The honest "not available" wording is acceptable in a few forms; what
  // matters is that the UI never pretends a generation occurred.
  assert.match(panelCode, /Gambar AI belum dapat dibuat/);
  // It must still show the outputs area honestly (draft / empty).
  assert.match(panelCode, /Belum ada gambar\./);
});

// ===========================================================================
// Draft-until-approval, never auto-publish, no direct cover write
// ===========================================================================

test("both outputs are drafts until an explicit Producer decision", () => {
  assert.match(panelCode, /output\.status === "draft"/);
  assert.match(panelCode, /draft: "Draft"/);
});

test("approval is never automatic", () => {
  // Approval only ever happens inside a click handler; the mount effect that
  // loads state contains no approve/decide call.
  const effectMatch = panelCode.match(/useEffect\(\(\) => \{[\s\S]*?\n  \}, \[placeId\]\);/);
  assert.ok(effectMatch, "the mount effect must exist");
  assert.equal(
    effectMatch[0].includes("approve") || effectMatch[0].includes("decideOutput"),
    false,
    "the mount effect must not approve or decide anything",
  );
  // decideOutput is wired to the output approve/reject buttons, not to the
  // mount effect or to any automatic refresh path.
  assert.match(
    panelCode,
    /approved/,
    "the panel must contain an approve decision",
  );
  assert.match(
    panelCode,
    /rejected/,
    "the panel must contain a reject decision",
  );
  // The output approve/reject buttons are clicked by the user; they must not be
  // driven by the mount effect or by any automatic refresh path.
  for (const approveRef of ["onApprove", "onReject", "decideOutput"]) {
    assert.ok(
      panelCode.includes(approveRef),
      `the panel must contain the ${approveRef} control wiring`,
    );
  }
});

test("the UI never writes the canonical cover directly", () => {
  assert.equal(panelCode.includes("cover_image_url"), false);
  assert.equal(panelCode.includes("coverImageUrl"), false);
  assert.match(panelCode, /Place Story Image tetap terpisah dari sampul/);
});

// ===========================================================================
// Limits are mirrored client-side; server stays the authority
// ===========================================================================

test("the panel mirrors the locked 5 MB / accepted-type limits", () => {
  assert.match(panelCode, /validateAiMediaSourceFile\(/);
  assert.match(panelCode, /AI_MEDIA_ACCEPTED_TYPES\.join\(","\)/);
  assert.match(panelCode, /AI_MEDIA_MAX_BYTES/);
  assert.equal(AI_MEDIA_MAX_BYTES, 5 * 1024 * 1024);
  assert.deepStrictEqual(Array.from(AI_MEDIA_ACCEPTED_TYPES), [
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/avif",
  ]);
});

test("upload, success, failure and replacement states are all rendered", () => {
  assert.match(panelCode, /Mengunggah\.\.\./);
  assert.match(panelCode, /Foto sumber tersimpan\./);
  assert.match(panelCode, /Foto sumber diganti\./);
  assert.match(panelCode, /Ganti foto sumber/);
  assert.match(panelCode, /role="alert"/);
});

// ===========================================================================
// Safety: no server-only import, no vendor, no fake image
// ===========================================================================

test("no server-only helper is imported into the client panel", () => {
  for (const forbidden of ["ai-media-storage", "ai-media-audit", "ai-media-generation", "server-only"]) {
    assert.equal(panel.includes(forbidden), false, `the client panel must not import ${forbidden}`);
  }
  // Only the client-safe contract module is imported from the AI media libs.
  assert.match(panel, /from "@\/lib\/ai-media"/);
});

test("no AI vendor and no fake/mock image is introduced", () => {
  const lower = panelCode.toLowerCase();
  for (const vendor of ["openai", "anthropic", "gemini", "dall-e", "dalle", "midjourney", "stability", "stablediffusion"]) {
    assert.equal(lower.includes(vendor), false, `the panel must not name the vendor ${vendor}`);
  }
  for (const fake of ["picsum", "placeholder.com", "placehold.co", "unsplash", "data:image", "loremflickr"]) {
    assert.equal(lower.includes(fake), false, `the panel must not render a fake image (${fake})`);
  }
});

// ===========================================================================
// Coexistence with the standard 5 photo slots
// ===========================================================================

test("the standard 5 Place photo slots are untouched", () => {
  assert.match(placeFormCode, /PLACE_PHOTO_SLOTS\.map\(/);
  assert.match(placeFormCode, /Foto Tempat \(\{PLACE_PHOTO_SLOTS\.length\} slot\)/);
  assert.match(placeFormCode, /\/api\/producer\/places\/\$\{place\.id\}\/photos\/\$\{slotKey\}/);
});

test("the AI media surface sits on its own tab, reachable only for a saved Place", () => {
  assert.match(placeFormCode, /import PlaceAiMediaPanel from "\.\/PlaceAiMediaPanel"/);
  assert.match(placeFormCode, />\s*AI Media\s*<\/button>/);
  assert.match(placeFormCode, /editorTab === "ai-media" && place/);
  assert.match(placeFormCode, /<PlaceAiMediaPanel key=\{place\.id\} placeId=\{place\.id\} \/>/);
});

test("the panel never renders a raw stored enum value", () => {
  // Output statuses and the (absent) provider go through local labels.
  assert.equal(panelCode.includes("{output.status}"), false);
  assert.equal(panelCode.includes("{output.provider}"), false);
  assert.match(panelCode, /outputStatusLabel\(output\.status\)/);
});
