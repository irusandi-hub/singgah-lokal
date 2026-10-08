import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  AI_MEDIA_COVER_OUTPUT_KEY,
  AI_MEDIA_HOOK_HORIZONTAL_OUTPUT_KEY,
  AI_MEDIA_OUTPUT_KEYS,
  AI_MEDIA_OUTPUT_SLOTS,
  AI_MEDIA_SOURCE_KEYS,
  AI_MEDIA_SOURCE_SLOTS,
} from "@/lib/ai-media";
import { PLACE_COVER_SLOT_KEY, PLACE_PHOTO_SLOTS } from "@/lib/place-media";

/**
 * MEDIA TEMPAT — the approved two-method structure (restructure 2026-10-07).
 *
 * Media is NOT one long slot list and NOT "5 manual slots + 4 AI slots". It is
 * ONE surface where the Producer first picks exactly ONE of two ALTERNATIVE
 * methods:
 *
 *   MANUAL      — the Producer manages the standard Place photos themselves
 *                 (existing server-side upload API → Storage → place_photos).
 *   GENERATE AI — exactly 4 source photos in, exactly 2 generated outputs out
 *                 (Cover + Hook Horizontal), reviewed and approved/rejected.
 *
 * This suite locks the structure: one media surface, two exclusive methods, the
 * exact AI input/output counts, the server as the only generation authority,
 * draft-until-approval, and the cover staying reachable only through the
 * existing approval path.
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
const form = read("app/producer/places/PlaceForm.tsx");
const formCode = stripComments(form);
// The tab layer moved to the ONE Place workspace (UI/UX restructure
// 2026-10-08): Media is one of the four Place items, and the media panel is
// rendered as that item's work area.
const workspace = read("app/producer/places/[placeId]/PlaceWorkspace.tsx");
const workspaceCode = stripComments(workspace);

// ===========================================================================
// ONE media surface, TWO exclusive methods
// ===========================================================================

test("the editor offers one Media tab, not a separate upload page and AI page", () => {
  assert.match(formCode, /Media Tempat/);
  assert.match(workspaceCode, /\{ key: "media", label: "Media" \}/);
  // The old two-tab split is gone: nothing sets the editor back to an
  // "upload" or "ai-media" tab, so there is no second surface that also looks
  // like the main upload workflow.
  assert.equal(formCode.includes('setEditorTab("upload")'), false);
  assert.equal(formCode.includes('setEditorTab("ai-media")'), false);
  assert.equal(formCode.includes("editorTab === \"ai-media\""), false);
  assert.equal(formCode.includes("editorTab === \"upload\""), false);
});

test("the method choice is explicit and exclusive", () => {
  // The chooser (a compact selector, UI/UX restructure 2026-10-08) presents
  // exactly the two methods and records exactly one of them.
  assert.match(formCode, /role="radiogroup"/);
  assert.match(formCode, /role="radio"/);
  assert.match(formCode, /\{ key: "manual" as const, label: "Manual" \}/);
  assert.match(formCode, /\{ key: "generate-ai" as const, label: "Generate AI" \}/);
  assert.match(formCode, /setMediaMethod\(method\.key\)/);
  assert.match(formCode, /aria-checked=\{mediaMethod === method\.key\}/);
  // Each method body renders only for its own value — never both together.
  assert.match(formCode, /\{mediaMethod === "manual" && \(/);
  assert.match(formCode, /\{mediaMethod === "generate-ai" && \(/);
  // The media surfaces live inside the Media item of the Place workspace only.
  assert.match(workspaceCode, /\{tab === "media" && <PlaceMediaPanel place=\{place\} \/>\}/);
});

test("the user chooses a method before any media control is rendered", () => {
  // With no method chosen the surface only explains the choice: the 5-slot
  // grid is NOT the default Media UX.
  assert.match(formCode, /\{mediaMethod === null && \(/);
  assert.match(formCode, /Pilih salah satu metode/);
  // Both methods are described as alternatives in the UI copy.
  assert.match(formCode, /dua\s*\n?\s*metode alternatif|metode alternatif/);
});

// ===========================================================================
// METHOD A — MANUAL: unchanged, and not the other method
// ===========================================================================

test("Manual keeps the standard slots through the existing upload path", () => {
  assert.match(formCode, /PLACE_PHOTO_SLOTS\.map/);
  assert.match(formCode, /Foto Tempat \(\{PLACE_PHOTO_SLOTS\.length\} slot\)/);
  assert.match(formCode, /\/api\/producer\/places\/\$\{place\.id\}\/photos\/\$\{slotKey\}/);
  assert.match(workspaceCode, /\{tab === "media" && <PlaceMediaPanel place=\{place\} \/>\}/);
  assert.equal(PLACE_PHOTO_SLOTS.length, 5, "the standard 5 slots must remain");
});

test("Manual media stays independent of the AI vocabulary", () => {
  // The manual flow never imports or renders AI source slots, and the AI panel
  // never renders the standard photo slots: the two methods share no control.
  assert.equal(formCode.includes("AI_MEDIA_SOURCE_SLOTS"), false);
  assert.match(formCode, /\{mediaMethod === "generate-ai" && \(/);
  assert.match(formCode, /<PlaceAiMediaPanel key=\{place\.id\} placeId=\{place\.id\} \/>/);
  assert.equal(panelCode.includes("PLACE_PHOTO_SLOTS"), false);
  // The Method A section is a self-contained block, so switching methods
  // unmounts the other method's controls entirely.
  assert.match(formCode, /aria-label="Media manual Tempat"/);
  assert.match(formCode, /aria-label="Media Generate AI Tempat"/);
});

// ===========================================================================
// METHOD B — GENERATE AI: exactly 4 in, exactly 2 out
// ===========================================================================

test("Generate AI has exactly 4 source inputs and exactly 2 outputs", () => {
  assert.equal(AI_MEDIA_SOURCE_SLOTS.length, 4);
  assert.deepStrictEqual(AI_MEDIA_SOURCE_KEYS, [
    "place",
    "material",
    "process",
    "result",
  ]);
  assert.deepStrictEqual(
    AI_MEDIA_SOURCE_SLOTS.map((slot) => slot.label),
    ["Tempat", "Bahan", "Proses Produksi", "Hasil"],
  );
  assert.equal(AI_MEDIA_OUTPUT_SLOTS.length, 2);
  assert.deepStrictEqual(AI_MEDIA_OUTPUT_KEYS, ["hook", "place_story"]);
  assert.deepStrictEqual(
    AI_MEDIA_OUTPUT_SLOTS.map((slot) => slot.label),
    ["Cover", "Hook Horizontal"],
  );
  // No extra AI input or output slot exists anywhere in the contract.
  assert.equal(AI_MEDIA_SOURCE_SLOTS.length + AI_MEDIA_OUTPUT_SLOTS.length, 6);
});

test("the 4 source photos are the generation input and stay unchanged", () => {
  // The 4 sources are private inputs; they are never described as generated
  // media and never replace the Place photos.
  assert.match(panelCode, /bahan baku privat/);
  assert.match(panelCode, /tidak menggantikan foto Tempat/);
  // Sources are only ever written through the existing private source API.
  assert.match(
    panelCode,
    /\/api\/producer\/places\/\$\{placeId\}\/ai-media\/sources\/\$\{sourceKey\}/,
  );
});

test("generation stays server-gated and never faked", () => {
  assert.match(
    panelCode,
    /fetch\(`\/api\/producer\/places\/\$\{placeId\}\/ai-media\/generate`/,
  );
  assert.match(panelCode, /available: data\.available === true/);
  assert.match(panelCode, /sourcesComplete/);
  assert.match(panelCode, /generationAvailable/);
  assert.match(panelCode, /Gambar AI belum dapat dibuat/);
  // Generate Ulang stays locked: the client never calls its route.
  assert.equal(panelCode.includes("generate-ulg"), false);
  assert.match(panelCode, /Generate Ulang/);
});

test("a provider is never named and no image is faked", () => {
  const lower = panelCode.toLowerCase();
  for (const vendor of ["openai", "anthropic", "gemini", "dall-e", "dalle", "midjourney", "stability"]) {
    assert.equal(lower.includes(vendor), false, `no vendor ${vendor}`);
  }
  for (const fake of ["picsum", "placeholder.com", "placehold.co", "unsplash", "data:image"]) {
    assert.equal(lower.includes(fake), false, `no fake image (${fake})`);
  }
});

// ===========================================================================
// Approval, publishing and the canonical cover
// ===========================================================================

test("the 2 outputs are drafts until the Producer decides", () => {
  assert.match(panelCode, /output\.status === "draft"/);
  assert.match(panelCode, /draft: "Draft"/);
  assert.match(panelCode, /decideOutput\(slot\.key, "approved"\)/);
  assert.match(panelCode, /decideOutput\(slot\.key, "rejected"\)/);
  assert.match(
    panelCode,
    /\/api\/producer\/places\/\$\{placeId\}\/ai-media\/approve/,
  );
});

test("Cover is the canonical cover; Hook Horizontal can never overwrite it", () => {
  assert.equal(AI_MEDIA_COVER_OUTPUT_KEY, PLACE_COVER_SLOT_KEY);
  assert.notEqual(AI_MEDIA_HOOK_HORIZONTAL_OUTPUT_KEY, PLACE_COVER_SLOT_KEY);
  // The panel never writes the cover itself — approval does, server-side.
  assert.equal(panelCode.includes("cover_image_url"), false);
  assert.equal(panelCode.includes("coverImageUrl"), false);
  // The UI states the boundary in plain language.
  assert.match(
    panelCode,
    /Menyetujui Hook Horizontal tidak mengubah sampul Tempat/,
  );
});

test("no server-only helper reaches the client bundle", () => {
  for (const forbidden of [
    "ai-media-storage",
    "ai-media-audit",
    "ai-media-generation",
    "server-only",
  ]) {
    assert.equal(panel.includes(forbidden), false, `panel must not import ${forbidden}`);
  }
  // Only the client-safe contract module is imported.
  assert.match(panel, /from "@\/lib\/ai-media"/);
});
