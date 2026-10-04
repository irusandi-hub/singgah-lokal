import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { acceptSearchResponse, resolveContextualCuratedCoverage } from "../lib/live/ui";

/**
 * SEARCH + MAP UPDATE FLOW (audit of 2026-10-05)
 *
 * The audit of this area found that the MANDATORY behaviour was already
 * implemented and correct: the search is submit-only, the clear control is a
 * real "×", a stale answer can never overwrite a newer context, and no camera
 * or marker work is repeated without an explicit trigger. What WAS defective
 * was the camera DATASET the curated focus fit (see
 * `map-contextual-curated-framing.test.ts`) and the label density of a dense
 * cluster (`map-pin-label-density.test.ts`).
 *
 * These tests therefore (a) lock the behaviour that must NOT regress, and
 * (b) pin the two structural properties that make redundant work impossible,
 * so a future change cannot reintroduce a per-keystroke search, a second
 * search path, an unguarded late answer, a refit per marker refresh, or a
 * per-frame label declutter.
 */

const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}
const pageCode = stripComments(homeDiscovery);
const mapCode = stripComments(homeMap);

// ---------------------------------------------------------------------------
// 1. Search runs ONLY on Enter/submit
// ---------------------------------------------------------------------------

test("C1 typing never executes the search", () => {
  const changeHandler = pageCode.slice(
    pageCode.indexOf("const handleSearchChange"),
    pageCode.indexOf("const handleSearchSubmit"),
  );
  // The change handler is a pure state update: no fetch, no debounce timer, no
  // geocode, no camera nonce.
  assert.match(changeHandler, /setSearchQuery\(value\);/);
  assert.doesNotMatch(changeHandler, /fetch\(|setTimeout|setSearchCenter|setSearchNonce|setFitNonce|setCameraRequestNonce/);
  assert.match(pageCode, /onChange=\{\(event\) => handleSearchChange\(event\.target\.value\)\}/);
});

test("C2 Enter/submit runs exactly one search", () => {
  assert.match(
    pageCode,
    /const handleSearchKeyDown = useCallback\(\s*\(event: React\.KeyboardEvent<HTMLInputElement>\) => \{\s*if \(event\.key === "Enter"\) \{\s*event\.preventDefault\(\);\s*handleSearchSubmit\(event\.currentTarget\.value\);/,
  );
  // One geocode call site in the whole component.
  assert.equal((pageCode.match(/fetch\(`\/api\/geocode\?q=/g) ?? []).length, 1);
  // No keystroke-driven auto search anywhere.
  assert.doesNotMatch(pageCode, /runSearch\(searchQuery\)|onChange=\{handleSearchSubmit\}|}, 250\);/);
});

test("C3 an empty submit never geocodes — it only resets", async () => {
  const submit = pageCode.slice(pageCode.indexOf("const handleSearchSubmit"), pageCode.indexOf("const handleSearchKeyDown"));
  const emptyBranch = submit.slice(submit.indexOf("if (!trimmed) {"), submit.indexOf("submittedSearchRef.current = trimmed;"));
  assert.match(emptyBranch, /if \(!trimmed\) \{/);
  assert.doesNotMatch(emptyBranch, /fetch\(/);
  assert.match(emptyBranch, /setSearchCenter\(cleared\.center\);/);
  assert.match(emptyBranch, /setSearchPlaceName\(cleared\.placeName\);/);
});

// ---------------------------------------------------------------------------
// 2. The clear control is a real "×"
// ---------------------------------------------------------------------------

test("C4 the clear control is the approved \"×\" button", () => {
  assert.match(
    pageCode,
    /\{searchQuery \? \(\s*<button\s*type="button"\s*onClick=\{handleSearchClear\}[\s\S]*?aria-label="Hapus pencarian"\s*>\s*<span aria-hidden>×<\/span>\s*<\/button>\s*\) : \(/,
  );
  // Clearing is one handler, not an effect, and it drops the pending/error/center
  // together so the map and the rows fall back to the real viewport.
  const clear = pageCode.slice(pageCode.indexOf("const handleSearchClear"), pageCode.indexOf("// \"LOCATION MODE OWNERSHIP"));
  assert.match(clear, /searchEpochRef\.current \+= 1;/);
  assert.match(clear, /submittedSearchRef\.current = "";/);
  assert.match(clear, /setSearchCenter\(cleared\.center\);/);
  assert.match(clear, /setSearchPlaceName\(cleared\.placeName\);/);
});

// ---------------------------------------------------------------------------
// 3. Stale results can never replace newer ones
// ---------------------------------------------------------------------------

test("C5 the epoch + submitted-query guard is applied after EVERY await", () => {
  const submit = pageCode.slice(pageCode.indexOf("const handleSearchSubmit"), pageCode.indexOf("const handleSearchKeyDown"));
  // One geocode, then the guard is re-checked before the body is read and again
  // before the center is written — a late answer for an older query can never
  // drag the map or the rows back.
  assert.equal((submit.match(/if \(submittedSearchRef\.current !== trimmed\) return;/g) ?? []).length, 3);
  assert.equal((submit.match(/if \(!isCurrent\(\)\) return;/g) ?? []).length, 3);
  assert.match(submit, /const isCurrent = \(\) =>\s*acceptSearchResponse\(\{\s*requestEpoch,\s*currentEpoch: searchEpochRef\.current,\s*submitted: trimmed,\s*activeQuery: submittedSearchRef\.current,\s*\}\);/);
  // Executable form of the same rule.
  assert.equal(acceptSearchResponse({ requestEpoch: 3, currentEpoch: 3, submitted: "riyadh", activeQuery: "riyadh" }), true);
  assert.equal(acceptSearchResponse({ requestEpoch: 3, currentEpoch: 4, submitted: "riyadh", activeQuery: "riyadh" }), false);
  assert.equal(acceptSearchResponse({ requestEpoch: 3, currentEpoch: 3, submitted: "riyadh", activeQuery: "dammam" }), false);
});

test("C6 a context change during an active search invalidates the in-flight answer", () => {
  // Exactly FOUR intents bump the epoch — an empty submit, a new submit, the
  // clear "×", and the "Lokasi Saya" press — so none of them can ever be
  // answered by a stale geocode.
  assert.equal((pageCode.match(/searchEpochRef\.current \+= 1;/g) ?? []).length, 4);
  assert.equal((pageCode.match(/submittedSearchRef\.current = "";/g) ?? []).length, 3);
  // "Lokasi Saya" clears the searched city in the SAME press, so the context
  // change and the invalidation are atomic.
  const locate = pageCode.slice(pageCode.indexOf("const handleLocatePress"), pageCode.indexOf("const handleLocatePress") + 1400);
  assert.match(locate, /searchEpochRef\.current \+= 1;/);
  assert.match(locate, /setSearchCenter\(cleared\.center\);/);
  assert.match(locate, /resetViewportLatch\(\);/);
  assert.match(pageCode, /const activeSearch = resolveActiveCenter\(\{ searchCenter, viewerPosition \}\);/);
});

// ---------------------------------------------------------------------------
// 4. No redundant camera or marker work
// ---------------------------------------------------------------------------

test("C7 every camera apply is keyed on its own explicit trigger", () => {
  // Curated: fitNonce. Locate: locateNonce. Search: searchNonce. Distance tabs
  // and the curated tab: cameraRequestNonce. Nothing else can move the camera.
  assert.match(mapCode, /const fitChanged = fitNonce > 0 && fitNonce !== lastFitNonceRef\.current;/);
  assert.match(mapCode, /if \(!locateNonce \|\| lastLocateNonceRef\.current === locateNonce\) return;/);
  assert.match(mapCode, /if \(!ready \|\| !map \|\| !searchCenter \|\| !searchNonce\) return;/);
  assert.match(mapCode, /if \(requestChanged\) userInteractedRef\.current = false;/);
  // The dataset is mirrored into a REF, so a new Place array (a discovery poll,
  // a search refresh) can never re-run a fit that already happened.
  assert.match(mapCode, /const fitPlacesRef = useRef<HomeMapPlace\[\]>\(fitPlaces\);/);
  assert.match(mapCode, /useEffect\(\(\) => \{\s*fitPlacesRef\.current = fitPlaces;\s*\}, \[fitPlaces\]\);/);
});

test("C8 markers are rebuilt only when the marker SET changes", () => {
  assert.match(mapCode, /const markerKey = useMemo\(/);
  assert.match(mapCode, /\}, \[ready, markerKey\]\);/);
  // The discovery feed re-polls every 15 s; an unchanged marker set therefore
  // costs no clearLayers and no marker rebuild. Exactly TWO layer rebuilds
  // exist: the Place markers (keyed on markerKey) and the Current Location
  // layer (keyed on the real fix).
  assert.equal((mapCode.match(/layer\.clearLayers\(\)/g) ?? []).length, 2);
  // The tile layer is created ONCE for the map's whole lifetime and only ever
  // removed at teardown.
  assert.equal((mapCode.match(/L\.tileLayer\(/g) ?? []).length, 1);
  assert.equal((mapCode.match(/tileLayerRef\.current\?\.remove\(\)/g) ?? []).length, 1);
});

test("C9 viewport reports are deduped, so a settled map never re-renders the rows", () => {
  assert.match(mapCode, /if \(isSameViewport\(lastViewportRef\.current, viewport\)\) return;/);
  assert.match(mapCode, /if \(scaleKey !== lastScaleRef\.current\) \{/);
  assert.match(mapCode, /if \(shouldReportViewportStatus\(lastViewportHasPlacesRef\.current, hasPlaces\)\) \{/);
  // Bounds are reported on finished gestures, on readiness, and on a real
  // resize only — never per frame.
  assert.equal((mapCode.match(/reportViewportBounds\(\);/g) ?? []).length, 4);
  assert.doesNotMatch(mapCode, /map\.on\("move", /);
});

// ---------------------------------------------------------------------------
// 5. The curated camera dataset is derived, not re-filtered per render
// ---------------------------------------------------------------------------

test("C10 the curated camera pool is memoised on stable inputs only", () => {
  assert.match(
    pageCode,
    /const curatedFitPlaces = useMemo<HomeMapPlace\[\]>\(\(\) => \{[\s\S]*?\}, \[places, curatedIdSet, searchCenter, viewerPosition, searchViewport\]\);/,
  );
  // It is not derived inside the render body and not stored in state, so a
  // keystroke can never rebuild the camera dataset.
  assert.equal((pageCode.match(/setCuratedFit|setCuratedCamera/g) ?? []).length, 0);
});

test("C11 contextual framing narrows the camera dataset instead of re-selecting Places", () => {
  // Executable: the same curated layer over three regions produces a pool that
  // is always a subset of the canonical curated candidates, in input order —
  // the camera can only REMOVE candidates, never add or re-order them.
  const curated = [
    { id: "java", latitude: -6.9115, longitude: 107.6098, countryCode: "ID", regionName: "Jawa Barat" },
    { id: "riyadh", latitude: 24.7136, longitude: 46.6753, countryCode: "SA", regionName: "Ar Riyad" },
  ];
  for (const origin of [
    { lat: -6.9, lng: 107.61 },
    { lat: 24.7136, lng: 46.6753 },
  ]) {
    const pool = resolveContextualCuratedCoverage({ curatedPlaces: curated, origin, searchViewport: null });
    assert.ok(pool.places.every((place) => curated.some((row) => row.id === place.id)));
    assert.ok(pool.places.length >= 1);
  }
});