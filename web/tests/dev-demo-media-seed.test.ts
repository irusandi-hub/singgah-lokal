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
  // Ownership is OBJECT-based: a `hook` row belongs to this seed only when it
  // points at the very object this seed stored as the Place's cover. A DEMO
  // title alone is not proof — an earlier run relabelled real Producer
  // uploads, so a title match would let `--force` overwrite them again.
  assert.match(seedCode, /const coverObject = place\.cover_image_url/);
  assert.match(seedCode, /place\.cover_image_url\.split\(`\/public\/\$\{PLACE_MEDIA_BUCKET\}\/`\)\[1\]/);
  assert.match(
    seedCode,
    /const seedOwnsRow =\s*coverObject !== null && hook\.storage_path === coverObject && hook\.title\.startsWith\(DEMO_TITLE_PREFIX\);/,
  );
  assert.match(
    seedCode,
    /if \(seedOwnsRow \|\| !\(await storedObjectExists\(supabase, hook\.storage_path\)\)\) \{/,
  );
  // `--force` must never be a way around the ownership check.
  assert.doesNotMatch(seedCode, /if \(force \|\| !\(await storedObjectExists/);
  // The dangling-repair loop skips every reference whose object still exists,
  // so a Producer upload is never repointed.
  assert.match(seedCode, /if \(await storedObjectExists\(supabase, legacy\.storage_path\)\) continue;/);
  // Nothing is ever deleted: the repair repoints, it does not remove.
  assert.doesNotMatch(seedCode, /\.delete\(\)/);
});

// ---------------------------------------------------------------------------
// 5. The artwork is unmistakably DEMO and motif-matched.
// ---------------------------------------------------------------------------

test("every generated cover is a FULL VISUAL COVER with only a DEMO badge as text", () => {
  const svg = buildDemoCoverSvg({ name: "Sari Tempe Makmur", motif: "leaf-wrapped", area: "Buahbatu" });
  // The DEMO badge stays: these are generated DEV assets and must never be
  // mistaken for Producer photography.
  assert.match(svg, /DEMO/);
  // Nothing else may be painted. The Home/Place card already renders the
  // Place name, short description, stars, distance, Live state and Direction,
  // so none of that may be baked into the picture.
  for (const forbidden of [
    "Sari Tempe Makmur",
    "Demo Place",
    "Buahbatu",
    "SINGGAH LOKAL",
    "Gambar demo",
    "Ilustrasi demo",
    "bukan foto Producer",
  ]) {
    assert.equal(svg.includes(forbidden), false, `the cover must not paint "${forbidden}"`);
  }
  // DEMO is the ONLY text element in the whole document.
  const texts = svg.match(/<text[\s\S]*?<\/text>/g) ?? [];
  assert.equal(texts.length, 1, "exactly one text element");
  assert.match(texts[0], />DEMO</);
  // No unresolved template can leak into the image again.
  assert.doesNotMatch(svg, /\{[A-Za-z_$][^}]*\}/);
  assert.doesNotMatch(svg, /\{|<\?/);
});

test("the cover fills the canvas and the motif owns the main visual area", () => {
  const svg = buildDemoCoverSvg({ name: "Bakso Migran", motif: "soup-bowl", area: null });
  // Full-bleed background: a rect covering the whole 1200x750 canvas plus a
  // horizon scene — the image is a cover, not a panel on a white field.
  assert.match(svg, /<rect width="1200" height="750" fill="#/);
  assert.match(svg, /<path d="M0 452/);
  assert.match(svg, /<path d="M0 566/);
  // The motif is scaled up and centred instead of being trapped in a disc.
  assert.match(svg, /<g transform="translate\(600 372\) scale\(1\.92\)">/);
  assert.doesNotMatch(svg, /r="212"/);
  // Scene texture exists, so the cover does not read as a flat placeholder.
  assert.ok((svg.match(/<circle/g) ?? []).length >= 20, "background texture dots");
});

test("a Place name can never reach the artwork through any motif", () => {
  const motifs = [
    "soup-bowl",
    "corn",
    "leaf-wrapped",
    "tofu",
    "bamboo",
    "batik",
    "weaving",
    "lantern",
    "herbs",
    "seedling",
    "palm-sugar",
    "coffee",
    "tea",
    "kitchen-pot",
    "clay",
    "timber",
    "tools",
    "honey",
    "grain",
    "spice",
    "seafood",
    "soap",
    "glassware",
    "leather",
    "wheel",
    "flower",
    "workshop",
  ] as const;
  for (const motif of motifs) {
    const svg = buildDemoCoverSvg({
      name: 'Sari <A & B> "Demo"',
      motif,
      area: "Kota Rahasia",
      kindLabel: "Demo Place • Produksi",
    });
    for (const forbidden of ["Sari", "Kota Rahasia", "Demo Place", "&lt;A", "&quot;Demo&quot;"]) {
      assert.equal(svg.includes(forbidden), false, `${motif} must not paint "${forbidden}"`);
    }
  }
});

test("REGRESSION: the artwork source can never bake an unresolved template or Place data", () => {
  // The original bug: a caption written as `Gambar demo untuk{someFn()}` in a
  // PLAIN string (not a template literal) rasterizes the raw expression into
  // the PNG, and every Discovery card then shows that raw text to users. The
  // artwork is rasterized ONCE and stored, so a broken source string can never
  // be fixed by editing the code alone — it has to be re-rendered.
  //
  // Guards, on the source itself:
  //  · a helper call may only appear inside a real interpolation (`${...}`),
  //    never bare inside the SVG markup;
  //  · the cover must not paint any Place data, and DEMO is its only text.
  assert.doesNotMatch(art, />[^<]*\{[A-Za-z_$][A-Za-z0-9_$]*\(\)\}/);
  for (const forbidden of ["Gambar demo", "Ilustrasi demo", "SINGGAH LOKAL</text>", "kindLabel ??", "wrap(", "esc("]) {
    assert.equal(art.includes(forbidden), false, `the artwork must not contain "${forbidden}"`);
  }
  // The renderer explicitly discards the Place metadata it is handed.
  assert.match(art, /void input\.name;/);
  assert.match(art, /void input\.area;/);
  assert.match(art, /void input\.kindLabel;/);
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