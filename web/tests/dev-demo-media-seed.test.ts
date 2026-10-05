import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolveDemoMotif, buildDemoCoverSvg } from "@/lib/dev/demo-cover-art";

/**
 * DEV DEMO MEDIA SEED — contracts (2026-10-05).
 *
 * The seed is a DEV-ONLY DATA operation. It exists because manual upload
 * cannot reach the demo Places (they have no Producer membership, by design),
 * so it must populate demo media WITHOUT bypassing the media model. These
 * tests lock the properties that make it safe:
 *
 *  1. it writes through the EXISTING media model (bucket, path layout, the
 *     standard `hook` slot, the production validators) — never a private
 *     bucket, never a private path, never a raw URL;
 *  2. it changes NOTHING about a Place except its canonical cover reference —
 *     no name, description, category, coordinate, publication or discovery
 *     field is ever written;
 *  3. it is DEMV-scoped (refuses production) and idempotent;
 *  4. it never overwrites Producer-owned media that still exists;
 *  5. the artwork is unmistakably DEMO, and each demo Place's motif follows its
 *     OWN name/description.
 */

const seed = readFileSync(new URL("../scripts/seed-dev-demo-media.ts", import.meta.url), "utf8");
const art = readFileSync(new URL("../lib/dev/demo-cover-art.ts", import.meta.url), "utf8");
const verify = readFileSync(new URL("../scripts/verify-dev-demo-media.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*");
    })
    .join("\n");
}

const seedCode = stripComments(seed);

// ---------------------------------------------------------------------------
// 1. It writes through the existing media model.
// ---------------------------------------------------------------------------

test("the seed uses the canonical bucket, path layout, slot, and validators", () => {
  // The bucket and the slot contract come from the shared media module, not from
  // a private constant, so the seed can never drift onto another bucket.
  assert.match(seedCode, /PLACE_MEDIA_BUCKET/);
  assert.match(seedCode, /from "@\/lib\/place-media"/);
  assert.match(seedCode, /isPlacePhotoSlotKey/);
  assert.match(seedCode, /validatePlaceMediaFile\(/);
  assert.match(seedCode, /validatePlacePhotoMeta\(/);
  assert.match(seedCode, /PLACE_MEDIA_MAX_BYTES/);
  // The EXISTING object layout: places/<placeId>/<slotKey>-<random>.<ext>.
  assert.match(seedCode, /`places\/\$\{placeId\}\/\$\{slotKey\}-\$\{suffix\}\.png`/);
  // The public URL is derived from the stored object, never hardcoded.
  assert.match(seedCode, /storage\/v1\/object\/public\/\$\{PLACE_MEDIA_BUCKET\}/);
  assert.match(seedCode, /cover_image_url: url/);
  // The canonical reference table is the existing one.
  assert.match(seedCode, /from\("place_photos"\)/);
  assert.match(seedCode, /slot_key: DEMO_SLOT_KEY/);
  assert.equal(DEMO_SLOT_KEY_IS_STANDARD(), true);
});

function DEMO_SLOT_KEY_IS_STANDARD(): boolean {
  return seedCode.includes('const DEMO_SLOT_KEY = "hook";');
}

// ---------------------------------------------------------------------------
// 2. Nothing but the canonical cover reference is written.
// ---------------------------------------------------------------------------

test("the seed never rewrites Place identity, geography, publication, or discovery data", () => {
  // The ONLY place-level write is the cover reference.
  const placeWrites = seedCode.match(/\.from\("places"\)\s*\n?\s*\.update\([^)]*\)/g) ?? [];
  assert.equal(placeWrites.length, 1, "exactly one place-level write");
  assert.match(placeWrites[0], /cover_image_url: url/);
  for (const forbidden of [
    "short_description",
    "category",
    "latitude",
    "longitude",
    "publication_status",
    "claim_status",
    "name:",
    "is_dummy",
  ]) {
    assert.equal(placeWrites[0].includes(forbidden), false, `${forbidden} must never be written`);
  }
  // No insert/update/delete against Places at all: the demo Places already exist
  // (0037/0040/0019/0001 seeds); this seed only attaches media to them.
  assert.doesNotMatch(seedCode, /\.from\("places"\)\s*\n?\s*\.(insert|upsert|delete)/);
  // Discovery, experience, production-story, and claim tables are untouched.
  for (const table of ["discovery", "experiences", "production_stories", "place_claims", "users"]) {
    assert.equal(seedCode.includes(`"${table}"`), false, `${table} is never written`);
  }
});

// ---------------------------------------------------------------------------
// 3. DEV-scoped and idempotent.
// ---------------------------------------------------------------------------

test("the seed refuses to run in production", () => {
  assert.match(seedCode, /process\.env\.NODE_ENV === "production"/);
  assert.match(seedCode, /dev_demo_media_seed_refused_in_production/);
  assert.match(seed, /DEV ONLY/);
});

test("the seed is idempotent and dry-run by default", () => {
  assert.match(seedCode, /process\.argv\.includes\("--apply"\)/);
  assert.match(seedCode, /const apply = process\.argv\.includes\("--apply"\);/);
  // A Place that already has its canonical reference AND a cover is skipped...
  assert.match(seedCode, /if \(hook && place\.cover_image_url && !force\) \{\s*skipped \+= 1;/);
  // ...unless an explicit DEV refresh is asked for, and even then only for the
  // demo Places named by `--only` (the demo set itself is never widened).
  assert.match(seedCode, /const force = process\.argv\.includes\("--force"\);/);
  assert.match(seedCode, /const onlyArg = process\.argv\.find\(\(argument\) => argument\.startsWith\("--only="\)\);/);
  assert.match(seedCode, /if \(onlyIds && !onlyIds\.includes\(place\.id\)\) continue;/);
  assert.match(seedCode, /if \(!apply\) \{/);
  // Repeatability is exposed through package scripts, not tribal knowledge.
  assert.equal(packageJson.scripts["demo-media:seed"], "tsx scripts/seed-dev-demo-media.ts");
  assert.equal(packageJson.scripts["demo-media:verify"], "tsx scripts/verify-dev-demo-media.ts");
});

// ---------------------------------------------------------------------------
// 4. Producer-owned media is never overwritten.
// ---------------------------------------------------------------------------

test("an existing stored object is left alone, even when its row is repaired", () => {
  assert.match(seedCode, /storedObjectExists/);
  // The `hook` row is rewritten ONLY when its object is gone, or on an explicit
  // DEV refresh of that Place.
  assert.match(
    seedCode,
    /if \(force \|\| !\(await storedObjectExists\(supabase, hook\.storage_path\)\)\) \{/,
  );
  // The dangling-repair loop skips every reference whose object still exists,
  // so a Producer upload is never repointed.
  assert.match(seedCode, /if \(await storedObjectExists\(supabase, legacy\.storage_path\)\) continue;/);
  // Nothing is ever deleted: the repair repoints, it does not remove.
  assert.doesNotMatch(seedCode, /\.delete\(\)/);
});

// ---------------------------------------------------------------------------
// 5. The artwork is unmistakably DEMO and motif-matched.
// ---------------------------------------------------------------------------

test("every generated cover carries a DEMO badge and an explicit disclaimer", () => {
  const svg = buildDemoCoverSvg({ name: "Sari Tempe Makmur", motif: "leaf-wrapped", area: "Buahbatu" });
  assert.match(svg, /DEMO/);
  assert.match(svg, /SINGGAH LOKAL/);
  // The caption states, in Indonesian, that this is not a Producer photo.
  assert.match(svg, /Ilustrasi demo/);
  assert.match(svg, /bukan foto Producer/);
  // XML-escaped text: a Place name can never break the document.
  const escaped = buildDemoCoverSvg({ name: 'Sari <A & B> "Demo"', motif: "bamboo", area: null });
  assert.match(escaped, /Sari &lt;A &amp; B&gt; &quot;Demo&quot;/);
  assert.doesNotMatch(escaped, /<A & B>/);
});

test("each demo Place's motif follows its own name and description", () => {
  // The requested craft → artwork mapping, locked per demo Place.
  const cases: Array<[string, string | null, string]> = [
    ["Bakso Migran", "bakso asli cita rasa indonesia", "soup-bowl"],
    ["Sari Jagung Sejahtera", "pengolahan jagung lokal", "corn"],
    ["Sari Tempe Makmur", "produksi tempe kedelai rumahan", "leaf-wrapped"],
    ["Sari Tahu Pakis", "pembuatan tahu segar setiap pagi", "tofu"],
    ["Sari Kerajinan Bambu", "kerajinan bambu dari petani lokal", "bamboo"],
    ["Sari Batik Pancarsari", "studio batik tulis", "batik"],
    ["Sari Tenun Klasik", "galeri tenun ikat", "weaving"],
    ["Sari Anyaman Lentera", "anyaman bambu dan lentera kertas", "lantern"],
    ["Sari Kebun Obat", "kebun tanaman obat keluarga", "herbs"],
    ["Sari Taman Bibit", "kebibitan bibit buah dan sayuran", "seedling"],
    ["Sari Gula Aren", "gula aren tradisional", "palm-sugar"],
    ["Kopi dari Kebun", "kopi lokal", "coffee"],
    ["Rumah Teh Lokal", "teh lokal", "tea"],
    ["Dapur Rasa", "dapur Arraysi", "kitchen-pot"],
  ];
  for (const [name, description, motif] of cases) {
    assert.equal(resolveDemoMotif({ name, shortDescription: description }), motif, `${name} → ${motif}`);
  }
  // Unknown Places still get real artwork, never a blank cover.
  assert.equal(typeof resolveDemoMotif({ name: "Tempat Tanpa Keterangan" }), "string");
});

test("the verifier re-checks the real project instead of trusting the seed log", () => {
  assert.match(verify, /fetch\(/);
  assert.match(verify, /content-type/);
  assert.match(verify, /cover_image_url is null/);
  assert.match(verify, /NON-DEMO place has a cover/);
  assert.match(verify, /dangling reference/);
  // The artwork generator is DEV-only and says so.
  assert.match(art, /DEV ONLY/);
  assert.match(art, /DO NOT USE IN PRODUCTION/);
});