import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { canonicalPlaceSubdivisionKey } from "../lib/geo/countries";
import { resolveLocalAreaCoverage } from "../lib/live/ui";
import { buildDiscoveryViewModel } from "../lib/discovery/view-model";
import type { DiscoveryPlaceInput } from "../lib/discovery/scoring";

/**
 * RIYADH CURATED DATA + CAMERA ELIGIBILITY (audit of 2026-10-03).
 *
 * Two defects, one shared cause — `places.region_name` is free text in the
 * database, and the camera treated every string in it as a geographic
 * boundary.
 *
 * 1. THE GEOGRAPHIC SPLIT. The verified Supabase DEV/canonical dataset holds
 *    ten published curated Places with `region_name = 'Ar Riyad'` and
 *    twenty-five published non-curated ones with `region_name = 'Riyadh'` —
 *    all thirty-five inside the same real city. Only `Ar Riyad` is an ISO
 *    3166-2 subdivision of `SA` (SA-01); `Riyadh` is the CITY. The old
 *    locality key was `${country}|${region.toLowerCase()}`, so one city became
 *    two localities and the "Tempat Pilihan" camera, anchored in `Ar Riyad`,
 *    found no context among the `Riyadh` Places that surround it.
 *
 * 2. THE DUMMY QUESTION — settled here from the Masters, not guessed. Master
 *    Developer Authority & Dummy Place v1.0 §2 states, in the canonical-flag
 *    table: "Is it a Discovery input? No. The engine is dummy-blind; a Dummy
 *    Place is eligible on exactly the same canonical terms as any other
 *    Place." So the curated-id query selecting published + `is_curated` and
 *    NOT excluding `is_dummy` is CORRECT, and adding an `is_dummy` exclusion
 *    would invent an eligibility rule the Master forbids. §3 records that
 *    migration 0039 marked the ten migration-0037 fixtures as the sanctioned
 *    backfill; migration 0040 seeded the ten Riyadh fixtures; migration 0041
 *    corrected their subdivision from `Ash Sharqiyah` to `Ar Riyad` and left
 *    `is_curated` alone, awaiting the Creator's audited
 *    `markRiyadhDummyPlacesCurated` call. The ten curated Riyadh rows are
 *    therefore INTENTIONAL demo curation, not an accident — and the 25 real
 *    Places must NOT be promoted to make them unnecessary (that is an admin
 *    data decision, not an engineering one). These tests pin both halves.
 */

const repoSource = readFileSync(new URL("../lib/place-experience-repository.ts", import.meta.url), "utf8");
const migration0039 = readFileSync(
  new URL("../supabase/migrations/0039_dummy_place_developer_authority.sql", import.meta.url),
  "utf8",
);

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

// The canonical dataset as audited on 2026-10-03: ten curated Dummy Places on
// the ISO subdivision `Ar Riyad` (SA-01), twenty-five real Places on the bare
// city name `Riyadh`, all published, all with coordinates, all one city.
type RiyadhRow = { id: string; countryCode: string; regionName: string; isCurated: boolean; isDummy: boolean; latitude: number; longitude: number };

const RIYADH_ROWS: readonly RiyadhRow[] = [
  ["dummy-riyadh-01", "Riyadh", false, false, 24.7442, 46.6728],
  ["dummy-riyadh-02", "Riyadh", false, false, 24.8174, 46.6157],
  ["dummy-riyadh-03", "Riyadh", false, false, 24.8248, 46.6609],
  ["dummy-riyadh-04", "Riyadh", false, false, 24.7641, 46.6406],
  ["dummy-riyadh-05", "Riyadh", false, false, 24.7576, 46.6993],
  ["dummy-riyadh-06", "Riyadh", false, false, 24.6895, 46.6841],
  ["dummy-riyadh-07", "Riyadh", false, false, 24.7037, 46.7018],
  ["dummy-riyadh-08", "Riyadh", false, false, 24.7379, 46.7672],
  ["dummy-riyadh-09", "Riyadh", false, false, 24.7688, 46.7764],
  ["dummy-riyadh-10", "Riyadh", false, false, 24.5489, 46.7082],
  ["dummy-riyadh-11", "Riyadh", false, false, 24.6124, 46.7136],
  ["dummy-riyadh-12", "Riyadh", false, false, 24.6318, 46.7159],
  ["dummy-riyadh-13", "Riyadh", false, false, 24.7852, 46.6347],
  ["dummy-riyadh-14", "Riyadh", false, false, 24.8457, 46.6831],
  ["dummy-riyadh-15", "Riyadh", false, false, 24.7859, 46.7424],
  ["dummy-riyadh-16", "Riyadh", false, false, 24.7586, 46.6771],
  ["dummy-riyadh-17", "Riyadh", false, false, 24.7817, 46.7635],
  ["dummy-riyadh-18", "Riyadh", false, false, 24.7136, 46.7961],
  ["dummy-riyadh-19", "Riyadh", false, false, 24.8064, 46.7077],
  ["dummy-riyadh-20", "Riyadh", false, false, 24.7338, 46.8084],
  ["dummy-riyadh-21", "Riyadh", false, false, 24.6657, 46.6712],
  ["dummy-riyadh-22", "Riyadh", false, false, 24.7214, 46.7358],
  ["dummy-riyadh-23", "Riyadh", false, false, 24.6806, 46.7334],
  ["dummy-riyadh-24", "Riyadh", false, false, 24.7427, 46.5769],
  ["dummy-riyadh-25", "Riyadh", false, false, 24.8068, 46.6421],
  ["dummy-riyadh-al-izza", "Ar Riyad", true, true, 24.8241, 46.6432],
  ["dummy-riyadh-kafd", "Ar Riyad", true, true, 24.7152, 46.6801],
  ["dummy-riyadh-king-fahd", "Ar Riyad", true, true, 24.7136, 46.6753],
  ["dummy-riyadh-malaz", "Ar Riyad", true, true, 24.6895, 46.7211],
  ["dummy-riyadh-nakheel", "Ar Riyad", true, true, 24.8325, 46.64],
  ["dummy-riyadh-olaya", "Ar Riyad", true, true, 24.6937, 46.6853],
  ["dummy-riyadh-sulaymaniyah", "Ar Riyad", true, true, 24.7089, 46.679],
  ["dummy-riyadh-tahlia", "Ar Riyad", true, true, 24.7247, 46.6975],
  ["dummy-riyadh-umm-al-hamam", "Ar Riyad", true, true, 24.7355, 46.6899],
  ["dummy-riyadh-yasmin", "Ar Riyad", true, true, 24.7959, 46.6692],
].map(([id, regionName, isCurated, isDummy, latitude, longitude]) => ({
  id: id as string,
  countryCode: "SA",
  regionName: regionName as string,
  isCurated: isCurated as boolean,
  isDummy: isDummy as boolean,
  latitude: latitude as number,
  longitude: longitude as number,
}));

// The viewer's own "Riyadh" search centre (Nominatim), used as the local-area
// origin exactly as `home-discovery.tsx` passes `searchCenter`.
const RIYADH_CENTER = { lat: 24.7136, lng: 46.6753 };

const CURATED_ROWS = RIYADH_ROWS.filter((row) => row.isCurated);
const CONTEXT_ROWS = RIYADH_ROWS.filter((row) => !row.isCurated);
const CURATED_IDS = new Set(CURATED_ROWS.map((row) => row.id));

// The curated Places the canonical dataset ALSO holds in the Eastern Province
// (~380 km east of Riyadh). They are curated and REAL (`is_dummy = false`), and
// they carry a bare city name as their subdivision exactly like the Riyadh
// ones do. They are in the same context pool a real search sees, so they are
// the pool's far-outliers: the curated camera must never frame them together
// with a Riyadh selection.
const EASTERN_CURATED_ROWS: readonly RiyadhRow[] = [
  ["dummy-dammam-03", "Dammam", true, false, 26.4389, 50.1078],
  ["dummy-dammam-04", "Dammam", true, false, 26.4057, 50.1192],
  ["dummy-dammam-05", "Dammam", true, false, 26.3736, 50.0631],
  ["dummy-dammam-06", "Dammam", true, false, 26.4158, 50.0507],
  ["dummy-dammam-07", "Dammam", true, false, 26.4521, 50.0864],
  ["dummy-dammam-10", "Al Rakah", true, false, 26.3742, 50.1856],
  ["dummy-dammam-19", "Al Khobar", true, false, 26.2691, 50.1718],
  ["dummy-dammam-20", "Al Khobar", true, false, 26.2416, 50.2247],
  ["dummy-dammam-24", "Al Khobar", true, false, 26.1847, 50.2213],
  ["dummy-dammam-25", "Al Khobar", true, false, 26.3172, 50.2148],
].map(([id, regionName, isCurated, isDummy, latitude, longitude]) => ({
  id: id as string,
  countryCode: "SA",
  regionName: regionName as string,
  isCurated: isCurated as boolean,
  isDummy: isDummy as boolean,
  latitude: latitude as number,
  longitude: longitude as number,
}));

// ---------------------------------------------------------------------------
// THE TRUSTED MAPPING — exact, canonical, and never a guess.
// ---------------------------------------------------------------------------

test("the Riyadh subdivision resolves to its ISO 3166-2 code", () => {
  // SA-01 is what `country-region-data` spells the Riyadh Region; the audit
  // that produced this fix started from the fact that the dataset contains
  // "Ar Riyad" and does NOT contain "Riyadh".
  assert.equal(canonicalPlaceSubdivisionKey("SA", "Ar Riyad"), "SA-01");
});

test("a bare city name is NOT silently accepted as its subdivision", () => {
  // "Riyadh" is the city, not the Riyadh Region. Mapping it onto SA-01 here
  // would be exactly the invented region mapping the audit forbids, and it
  // would silently "fix" the data instead of reporting it. It stays null.
  assert.equal(canonicalPlaceSubdivisionKey("SA", "Riyadh"), null);
  // The other three Saudi values the canonical dataset carries are cities too.
  assert.equal(canonicalPlaceSubdivisionKey("SA", "Dammam"), null);
  assert.equal(canonicalPlaceSubdivisionKey("SA", "Al Khobar"), null);
  assert.equal(canonicalPlaceSubdivisionKey("SA", "Al Rakah"), null);
  // ...while the real subdivisions still resolve, so this is not a blanket
  // refusal of Saudi geography.
  assert.equal(canonicalPlaceSubdivisionKey("SA", "Ash Sharqiyah"), "SA-04");
});

test("the lookup is an exact dataset match, never a fuzzy or case-folded one", () => {
  // Surrounding whitespace is trimmed (that is what `isValidPlaceRegion`
  // does too, so the two never disagree), but the NAME itself must be the
  // dataset's own spelling. Case folding would invent "AR RIYAD" as valid.
  assert.equal(canonicalPlaceSubdivisionKey("SA", "  Ar Riyad  "), "SA-01");
  assert.equal(canonicalPlaceSubdivisionKey("sa", "Ar Riyad"), "SA-01");
  assert.equal(canonicalPlaceSubdivisionKey("SA", "AR RIYAD"), null);
  assert.equal(canonicalPlaceSubdivisionKey("SA", "ar riyad"), null);
  assert.equal(canonicalPlaceSubdivisionKey("SA", "Ar-Riyad"), null);
  assert.equal(canonicalPlaceSubdivisionKey("SA", "Riyadh Region"), null);
});

test("anything that is not a subdivision of ITS OWN country resolves to null", () => {
  // Fail-closed on every axis: no country, blank region, wrong type, and a
  // real subdivision paired with the wrong country (a Place in Jeddah cannot
  // claim Jawa Barat and be trusted for grouping).
  assert.equal(canonicalPlaceSubdivisionKey(null, "Ar Riyad"), null);
  assert.equal(canonicalPlaceSubdivisionKey("SA", null), null);
  assert.equal(canonicalPlaceSubdivisionKey("SA", ""), null);
  assert.equal(canonicalPlaceSubdivisionKey("SA", 42), null);
  assert.equal(canonicalPlaceSubdivisionKey("ZZ", "Ar Riyad"), null);
  assert.equal(canonicalPlaceSubdivisionKey("ID", "Ar Riyad"), null);
  assert.equal(canonicalPlaceSubdivisionKey("ID", "Jawa Barat"), "ID-JB");
});

test("two Places of one subdivision always share a key, whatever their text", () => {
  // The property the camera actually depends on: identity comes from the ISO
  // code, so the grouping is stable even if display spelling changes.
  const canonical = canonicalPlaceSubdivisionKey("SA", "Ar Riyad");
  assert.ok(canonical);
  assert.equal(canonicalPlaceSubdivisionKey("SA", "Ar Riyad"), canonical);
  assert.notEqual(canonicalPlaceSubdivisionKey("SA", "Riyadh"), canonical);
});

// ---------------------------------------------------------------------------
// THE MISMATCH REGRESSION — the defect this change exists to prevent.
// ---------------------------------------------------------------------------

test("two Places 5.7 km apart in the SAME city are one local area, not two", () => {
  // `dummy-riyadh-olaya` (curated Dummy, `Ar Riyad`) and `dummy-riyadh-01`
  // (real, `Riyadh`) sit 5.7 km apart in central Riyadh. Before the fix the
  // anchor's subdivision key matched only itself and the second Place was
  // dropped: one real city split in two by a display-name inconsistency.
  const olaya = CURATED_ROWS.find((row) => row.id === "dummy-riyadh-olaya")!;
  const neighbour = CONTEXT_ROWS.find((row) => row.id === "dummy-riyadh-01")!;

  const area = resolveLocalAreaCoverage({
    origin: { lat: olaya.latitude, lng: olaya.longitude },
    places: [olaya, neighbour],
  });

  assert.deepEqual(
    area.places.map((row) => row.id).sort(),
    ["dummy-riyadh-01", "dummy-riyadh-olaya"],
    "both Places of one city belong to one local area",
  );
  assert.equal(area.basis, "region", "the anchor still supplies a verified boundary");
  assert.equal(area.anchorId, "dummy-riyadh-olaya", "the nearest Place stays the anchor");
});

test("the real Riyadh search frames all ten curated Places plus local context", () => {
  // Exactly the reported situation, reproduced from the canonical dataset.
  const selectedLocalArea = resolveLocalAreaCoverage({
    origin: RIYADH_CENTER,
    places: CURATED_ROWS,
  });

  assert.equal(selectedLocalArea.basis, "region");
  assert.equal(
    selectedLocalArea.places.length,
    CURATED_ROWS.length,
    "every curated Place of the subdivision is selected — none is dropped by spelling",
  );

  // The context step `cameraFitPlaces` performs: anchor on the SELECTED anchor
  // Place's own coordinate and resolve the ordinary Places around it. The pool
  // is MIXED — the whole non-curated dataset, exactly as the component builds
  // it — so this also proves the Eastern Province cannot ride in.
  const anchor = CURATED_ROWS.find((row) => row.id === selectedLocalArea.anchorId)!;
  const context = resolveLocalAreaCoverage({
    origin: { lat: anchor.latitude, lng: anchor.longitude },
    places: [...CONTEXT_ROWS, ...EASTERN_CURATED_ROWS],
  });

  assert.equal(
    context.places.length,
    CONTEXT_ROWS.length,
    "the curated camera is no longer starved of the surrounding Riyadh Places",
  );
  for (const row of context.places) {
    assert.equal(
      EASTERN_CURATED_ROWS.some((other) => other.id === row.id),
      false,
      `${row.id} is ~380 km away and must never be framed with a Riyadh selection`,
    );
  }
});

test("a viewer in the Eastern Province still gets that area, not Riyadh", () => {
  // The same rule has to work in the other direction: the bare city names are
  // not Riyadh-specific, so anchoring on an Eastern Province curated Place must
  // frame that cluster and must not reach across to Riyadh.
  const anchor = EASTERN_CURATED_ROWS.find((row) => row.id === "dummy-dammam-07")!;
  const area = resolveLocalAreaCoverage({
    origin: { lat: anchor.latitude, lng: anchor.longitude },
    places: [...EASTERN_CURATED_ROWS, ...CONTEXT_ROWS],
  });

  assert.equal(area.anchorId, "dummy-dammam-07");
  assert.equal(
    area.places.some((row) => row.regionName === "Riyadh"),
    false,
    "Riyadh is 380 km away and is never part of an Eastern Province frame",
  );
});

test("context markers never become curated membership", () => {
  // Task: keep context markers out of curated membership, the count, and the
  // result rows. The camera pool is a union; the curated layer is not.
  const context = resolveLocalAreaCoverage({
    origin: { lat: 24.7136, lng: 46.6753 },
    places: CONTEXT_ROWS,
  });

  for (const row of context.places) {
    assert.equal(CURATED_IDS.has(row.id), false, `${row.id} is not a curated Place`);
    assert.equal(row.isCurated, false, `${row.id} carries no curated flag`);
  }

  const cameraFitPlaces = [...CURATED_ROWS, ...context.places];
  assert.equal(
    cameraFitPlaces.filter((row) => CURATED_IDS.has(row.id)).length,
    CURATED_ROWS.length,
    "curated membership is unchanged by the context that was added around it",
  );
});

test("a Place in another subdivision is still refused, however near it is", () => {
  // The fix must not become "admit everything nearby". A Place that declares
  // its own DIFFERENT verified subdivision is governed by its boundary and is
  // excluded, even at a few hundred metres.
  const anchor = CURATED_ROWS.find((row) => row.id === "dummy-riyadh-olaya")!;
  const jeddah: RiyadhRow = {
    id: "other-subdivision",
    countryCode: "SA",
    regionName: "Makkah al Mukarramah",
    isCurated: false,
    isDummy: false,
    latitude: anchor.latitude + 0.0001,
    longitude: anchor.longitude,
  };

  const area = resolveLocalAreaCoverage({
    origin: { lat: anchor.latitude, lng: anchor.longitude },
    places: [anchor, jeddah],
  });

  assert.deepEqual(area.places.map((row) => row.id), ["dummy-riyadh-olaya"]);
  assert.equal(area.basis, "region");
});

test("a compact cluster far from the origin cannot ride in on an unverifiable row", () => {
  // Regression guard for the second-order effect of admitting unverifiable
  // Places by proximity. `compactCluster` compares SUCCESSIVE distances, so it
  // is scale-free: a set of Places all ~380 km away is internally "compact" and
  // never trips the separation. Without a bound, the Eastern Province curated
  // set was pulled into a Riyadh frame. Only ONE Place carries the verified
  // subdivision here, so the reach is measurable from the two Ar Riyad rows and
  // the far cluster must not appear.
  const anchor = CURATED_ROWS.find((row) => row.id === "dummy-riyadh-olaya")!;
  const secondSameSubdivision = CURATED_ROWS.find((row) => row.id === "dummy-riyadh-malaz")!;
  const near = CONTEXT_ROWS.find((row) => row.id === "dummy-riyadh-07")!;
  const far: RiyadhRow = {
    id: "far-unverifiable",
    countryCode: "SA",
    regionName: "Riyadh",
    isCurated: false,
    isDummy: false,
    latitude: 26.4521,
    longitude: 50.0078,
  };

  const area = resolveLocalAreaCoverage({
    origin: { lat: anchor.latitude, lng: anchor.longitude },
    places: [anchor, secondSameSubdivision, near, far],
  });

  const ids = area.places.map((row) => row.id);
  assert.ok(ids.includes("dummy-riyadh-olaya"));
  assert.ok(ids.includes("dummy-riyadh-malaz"));
  assert.ok(ids.includes("dummy-riyadh-07"), "a genuinely near unverifiable Place is still context");
  assert.equal(ids.includes("far-unverifiable"), false, "a far unverifiable Place is never pulled in");
});

test("the local area stays fail-closed — no usable origin frames nothing", () => {
  const area = resolveLocalAreaCoverage({ origin: null, places: RIYADH_ROWS });
  assert.equal(area.basis, "none");
  assert.deepEqual(area.places, []);
});

test("a Place without canonical coordinates can never define or join an area", () => {
  const anchor = CURATED_ROWS.find((row) => row.id === "dummy-riyadh-olaya")!;
  const area = resolveLocalAreaCoverage({
    origin: { lat: anchor.latitude, lng: anchor.longitude },
    places: [
      anchor,
      { ...CONTEXT_ROWS[0], latitude: null as unknown as number },
    ],
  });
  assert.deepEqual(area.places.map((row) => row.id), ["dummy-riyadh-olaya"]);
  assert.equal(area.consideredCount, 1);
});

// ---------------------------------------------------------------------------
// DUMMY ELIGIBILITY — pinned from the Master, in both directions.
// ---------------------------------------------------------------------------

const ZERO_ENGAGEMENT = { followers: 0, visitIntents: 0, publishedExperiences: 0, photos: 0 };

function makeInput(row: RiyadhRow): DiscoveryPlaceInput {
  return {
    place: {
      id: row.id,
      name: `Place ${row.id}`,
      shortDescription: "Deskripsi singkat.",
      area: "Riyadh",
      address: "Jl. Contoh 123",
      latitude: row.latitude,
      longitude: row.longitude,
      claimStatus: "unverified",
      publicationStatus: "published",
    },
    signals: {
      live: null,
      engagement: { ...ZERO_ENGAGEMENT },
    },
  } as unknown as DiscoveryPlaceInput;
}

test("a curated Dummy Place IS a member of the curated layer (the engine is dummy-blind)", () => {
  // Master Dummy Place v1.0 §2: "Is it a Discovery input? No. The engine is
  // dummy-blind; a Dummy Place is eligible on exactly the same canonical terms
  // as any other Place." So the ten curated Riyadh Dummies are legitimate
  // curated members, and excluding them would be inventing an eligibility rule
  // the Master explicitly denies.
  const ids = new Set(CURATED_ROWS.map((row) => row.id));
  const vm = buildDiscoveryViewModel(CURATED_ROWS.map(makeInput), ids, new Date("2026-10-03T00:00:00Z"));
  assert.deepEqual([...vm.curatedPlaceIds].sort(), [...ids].sort());
  assert.ok([...ids].every((id) => CURATED_ROWS.find((row) => row.id === id)!.isDummy));
});

test("a real Place is NOT promoted to curated by proximity, popularity, or the camera", () => {
  // Master v1.0 §6 gives only two tiers the power to change `is_curated`, and
  // both are audited, explicit operations. Nothing in the read path may infer
  // membership. The 25 real Riyadh Places are therefore NOT curated, and the
  // curated camera that now frames them as CONTEXT does not make them members.
  const curatedIds = new Set(CURATED_ROWS.map((row) => row.id));
  const allInputs = RIYADH_ROWS.map(makeInput);
  const vm = buildDiscoveryViewModel(allInputs, curatedIds, new Date("2026-10-03T00:00:00Z"));

  for (const row of CONTEXT_ROWS) {
    assert.equal(
      vm.curatedPlaceIds.includes(row.id),
      false,
      `${row.id} (a real Place) must stay out of the curated layer`,
    );
  }
  assert.equal(vm.curatedPlaceIds.length, CURATED_ROWS.length, "membership still comes only from is_curated");
  assert.equal(
    vm.discovery.length,
    RIYADH_ROWS.length,
    "Discovery still ranks every published Place — curated and ordinary alike",
  );
});

test("the server curated-id query keys on publication + is_curated only, never on is_dummy", () => {
  // The predicate the production repository actually runs. Pinning it stops a
  // later change from quietly excluding Dummies from Tempat Pilihan (forbidden
  // by §2) or, worse, from widening it: there is no `is_dummy` write anywhere
  // in the read path.
  const code = stripComments(repoSource);
  const body = code.slice(code.indexOf("async listCuratedPublishedPlaceIds", code.indexOf("class SupabasePlaceExperienceRepository")));
  const query = body.slice(0, body.indexOf("return new Set"));

  assert.match(query, /\.from\("places"\)/);
  assert.match(query, /\.eq\("publication_status", "published"\)/);
  assert.match(query, /\.eq\("is_curated", true\)/);
  assert.equal(
    /is_dummy/.test(query),
    false,
    "the curated layer must stay dummy-blind (Master Dummy Place v1.0 §2)",
  );
  assert.equal(
    /\.update\(/.test(query) || /\.insert\(/.test(query),
    false,
    "reading the curated layer must never write a Place flag",
  );
});

test("the in-memory repository applies the same dummy-blind predicate", () => {
  const code = stripComments(repoSource);
  const body = code.slice(code.indexOf("class InMemoryPlaceExperienceRepository"));
  const method = body.slice(body.indexOf("async listCuratedPublishedPlaceIds"), body.indexOf("async listDiscoveryInputs"));
  assert.match(method, /place\.publicationStatus === "published" && place\.isCurated/);
  assert.equal(/isDummy/.test(method), false, "dummy-blind in the test double as well");
});

test("migration 0039 keeps the Dummy flag orthogonal to the curated layer", () => {
  // The schema half of the rule: `is_dummy` is its own guarded column and does
  // not constrain or imply `is_curated`.
  assert.match(migration0039, /ADD COLUMN IF NOT EXISTS is_dummy boolean/i);
  assert.equal(
    /DEFAULT true/i.test(migration0039.split("ADD COLUMN IF NOT EXISTS is_dummy boolean")[1]?.split(/\n\s*\);/)[0] ?? ""),
    false,
    "is_dummy defaults to false — no Place is ever born a Dummy",
  );
});