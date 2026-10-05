import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { narrowToViewport, type MapViewport } from "../lib/live/ui";

/**
 * HOME LOCATION SEARCH — server-only geocoding + viewport follow (PO 2026-10-02)
 *
 * What this suite locks shut:
 *
 * 1. The browser NEVER reaches a geocoder. The provider endpoint lives behind
 *    a `server-only` module that only the `/api/geocode` route imports; the
 *    client component calls our own route instead. This is the invariant that
 *    stops a public provider URL (and its rate limit) from leaking into the
 *    browser bundle.
 * 2. Input is validated SERVER-side before any outbound request, and an
 *    unresolvable query yields `null` — never a guessed coordinate.
 * 3. A resolved center becomes the coverage source for the markers and BOTH
 *    Place rows, so a search filters every layer to the newly centered area.
 * 4. The locked contract is preserved: the radius tabs stay camera-only
 *    presets (a search never rewrites the selected tab), the curated layer
 *    still reads only canonical `is_curated`, and the Discovery row is still
 *    built from canonical `discovery.discovery` ids and never re-sorted.
 * 5. No fallback coordinate is invented in any branch: without an answer the
 *    map keeps its real Leaflet viewport.
 */

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const homeDiscovery = readFileSync(
  new URL("../components/home-discovery.tsx", import.meta.url),
  "utf8",
);
const geocodeRoute = readFileSync(new URL("../app/api/geocode/route.ts", import.meta.url), "utf8");
const photon = readFileSync(new URL("../lib/live/photon.ts", import.meta.url), "utf8");
const geocodingCore = readFileSync(
  new URL("../lib/live/geocoding-core.ts", import.meta.url),
  "utf8",
);

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

const mapCode = stripComments(homeMap);
const discoveryCode = stripComments(homeDiscovery);

// A ±0.05° box, the same shape the component builds around a resolved center.
function boxAround(lat: number, lng: number, half = 0.05): MapViewport {
  return {
    north: lat + half,
    south: lat - half,
    east: lng + half,
    west: lng - half,
  };
}

// ---------------------------------------------------------------------------
// 1. The geocoder is server-only; the browser calls our route, not the provider.
// ---------------------------------------------------------------------------

test("the geocoder module is server-only and no provider endpoint is client-reachable", () => {
  assert.match(photon, /^import "server-only";/);
  // The pure core deliberately has NO server-only import, so its logic is
  // executable in unit tests (mirrors comment-moderation-core.ts). Check the
  // actual import, not the word, which appears in its explanatory comment.
  assert.doesNotMatch(geocodingCore, /^import "server-only";/m);
  // The route is the ONLY importer of the server-only module.
  assert.match(geocodeRoute, /from "@\/lib\/live\/photon"/);
  // The client component must NOT import it, and must not name the provider.
  assert.doesNotMatch(homeDiscovery, /@\/lib\/live\/photon/);
  assert.doesNotMatch(homeDiscovery, /nominatim|openstreetmap/i);
  // It talks to our own route instead.
  assert.match(homeDiscovery, /fetch\(`\/api\/geocode\?q=\$\{encodeURIComponent\(trimmed\)\}`/);
});

test("the client never performs its own geocoding — one search path only", () => {
  const fetchCalls = discoveryCode.match(/\/api\/geocode/g) ?? [];
  assert.equal(fetchCalls.length, 1, "exactly one geocode call site");
  assert.equal(
    (discoveryCode.match(/const handleSearchSubmit = useCallback\(async/gi) ?? []).length,
    1,
    "one search runner only — no second, competing implementation",
  );
});

// ---------------------------------------------------------------------------
// 2. Server-side validation, and null instead of a guessed coordinate.
// ---------------------------------------------------------------------------

test("query validation happens on the server, before any outbound request", () => {
  // The route rejects a missing/blank query with 400 and never calls the
  // geocoder for it.
  assert.match(
    geocodeRoute,
    /normalizeGeocodeQuery\(new URL\(request\.url\)\.searchParams\.get\("q"\)\)/,
  );
  assert.match(geocodeRoute, /status: 400/);
  // A too-long query is rejected, never truncated into a provider call.
  assert.match(geocodingCore, /MAX_GEOCODE_QUERY_LENGTH/);
  assert.match(geocodingCore, /if \(trimmed\.length > MAX_GEOCODE_QUERY_LENGTH\) return null;/);
  // The route imports the validation through the server-only boundary.
  assert.match(photon, /MAX_GEOCODE_QUERY_LENGTH/);
  // An unresolvable query is an honest 404, not a fabricated center.
  assert.match(geocodeRoute, /location_not_resolved/);
  assert.match(geocodeRoute, /status: 404/);
});

test("the geocoder returns null — never a guess — on every failure path", () => {
  const body = photon.slice(photon.indexOf("export async function geocodeLocation"));
  // Network error / timeout.
  assert.match(body, /catch \{\s*\n\s*\/\/ Network failure[\s\S]*?return null;/);
  // Non-2xx answer.
  assert.match(body, /if \(!response\.ok\) return null;/);
  // Unparseable body, or a payload the parser rejects.
  assert.match(body, /payload = await response\.json\(\)/);
  assert.match(body, /catch \{\s*\n\s*return null;/);
  assert.match(geocodingCore, /if \(!Array\.isArray\(payload\)\) return null;/);
  // No usable hit.
  assert.match(geocodingCore, /if \(hits\.length === 0\) return null;/);
  // Non-finite coordinates — the only case that could otherwise smuggle a
  // bogus center into the camera.
  assert.match(
    geocodingCore,
    /if \(!Number\.isFinite\(latitude\) \|\| !Number\.isFinite\(longitude\)\) return null;/,
  );
  // A hung provider can never hold a socket open.
  assert.match(photon, /AbortSignal\.timeout/);
  // No invented fallback center anywhere in the helper.
  assert.doesNotMatch(photon, /latitude:\s*0\b|longitude:\s*0\b/);
  assert.doesNotMatch(geocodingCore, /latitude:\s*0\b|longitude:\s*0\b/);
});

// ---------------------------------------------------------------------------
// 3. A resolved center becomes the coverage source for every layer.
// ---------------------------------------------------------------------------

test("a resolved search center becomes the coverage viewport for markers and both rows", () => {
  // One shared coverage value for every consumer, so the markers and the two
  // rows can never disagree about the visible area.
  //
  // PRECEDENCE CORRECTED (bug fix 2026-10-02): the REAL Leaflet viewport wins,
  // and the searched box is only the stand-in for the one gap before Leaflet
  // reports bounds for the recentered camera. The box used to win FOREVER, so
  // a searched city permanently overrode manual panning — the map moved and the
  // list refused to follow. A new search answer releases the latch, so the box
  // returns for that gap only.
  assert.match(discoveryCode, /const coverageViewport = mapViewport \?\? searchViewport;/);
  // THE SEARCHED AREA IS NOW THE GEOCODER'S OWN BOX (2026-10-04). It used to be
  // a fixed ±0.05° window around the centre POINT, which excluded every
  // eligible Place outside a few kilometres of that point — the reported
  // defect. The canonical bounding box the geocoder published for the resolved
  // hit is now the primary source; the fixed window survives only as the
  // documented fallback for an answer that carries no usable boundary. It is
  // still derived through useMemo, so the search camera's bounds dataset keeps
  // a stable identity.
  assert.match(discoveryCode, /const searchViewport = useMemo<MapViewport \| null>\(/);
  assert.match(
    discoveryCode,
    /\(searchArea \? searchArea : searchCenter \? fallbackSearchArea\(searchCenter\) : null\)/,
  );
  // A null center AND no area (no answer) leaves the map viewport in charge.
  assert.match(discoveryCode, /\(searchArea \? searchArea : searchCenter \? fallbackSearchArea\(searchCenter\) : null\),\n\s*\[searchArea, searchCenter\],/);
  // The latch that keeps the two from disagreeing across the handoff.
  assert.match(discoveryCode, /const resetViewportLatch = useCallback/);
  // All three consumers use it.
  assert.match(discoveryCode, /narrowToViewport\(visiblePlaces, coverageViewport\)/);
  assert.match(discoveryCode, /narrowToViewport\(canonical, coverageViewport\)/);
  assert.match(
    discoveryCode,
    /narrowToViewport\(visiblePlaces\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\), coverageViewport\)/,
  );
  assert.match(discoveryCode, /narrowToViewport\(mapPlaces, coverageViewport\)/);
  // 2026-10-04: the result strips are now vertical lists, not horizontal carousels.
  assert.match(discoveryCode, /flex flex-col gap-2\.5/);
  assert.doesNotMatch(discoveryCode, /snap-x snap-mandatory/);
});

test("searching narrows every layer to the centered area (executable)", () => {
  const jakarta = { id: "jakarta", latitude: -6.2, longitude: 106.8 };
  const bandung = { id: "bandung", latitude: -6.9, longitude: 107.6 };
  const places = [jakarta, bandung];

  // Before a search: the map viewport decides.
  const jakartaViewport = boxAround(-6.2, 106.8);
  assert.deepEqual(
    narrowToViewport(places, jakartaViewport).map((item) => item.id),
    ["jakarta"],
  );

  // After searching "Bandung": the SAME function, the SAME list, a different
  // center — Bandung is now in, Jakarta is out.
  const bandungViewport = boxAround(-6.9, 107.6);
  assert.deepEqual(
    narrowToViewport(places, bandungViewport).map((item) => item.id),
    ["bandung"],
  );
});

// ---------------------------------------------------------------------------
// 4. The locked contract survives the search.
// ---------------------------------------------------------------------------

test("a search is CAMERA-ONLY: it never rewrites the radius tab or the filter mode", () => {
  const searchBlock = discoveryCode.slice(
    discoveryCode.indexOf("const handleSearchSubmit"),
    discoveryCode.indexOf("const liveByPlaceId"),
  );
  // A search may move the camera and set the center, nothing else.
  assert.doesNotMatch(searchBlock, /setDistanceFilter|setCuratedOnly|setLiveOnly/);
  // The camera radius passed to the map is still the preset, untouched.
  assert.match(
    discoveryCode,
    /cameraRadiusMeters=\{\s*CAMERA_PRESET_RADIUS_M\[distanceFilter\]/,
  );
});

test("searching never re-sorts or re-sources the Discovery row", () => {
  const row = discoveryCode.slice(
    discoveryCode.indexOf("const discoveryRowPlaces"),
    discoveryCode.indexOf("const curatedListed"),
  );
  // Still built from the canonical engine output, in engine order.
  assert.match(row, /const canonical = \(discovery\?\.discovery \?\? \[\]\)\.flatMap/);
  // Narrowing is filter-only — no sort, no wider source.
  assert.doesNotMatch(row, /\.sort\(|places\.filter|listedPlaces/);
});

test("the curated layer still reads ONLY canonical is_curated (search adds no membership)", () => {
  const curatedRow = discoveryCode.slice(
    discoveryCode.indexOf("const curatedListed"),
    discoveryCode.indexOf("const curatedCoverageSource"),
  );
  assert.match(curatedRow, /curatedIdSet\.has\(place\.id\)/);
  // A search can only REMOVE a Place from the curated row, never add one.
  assert.doesNotMatch(curatedRow, /searchCenter|searchFiltered\.filter\(.*curatedIdSet/);
});

// ---------------------------------------------------------------------------
// 5. Camera behavior and honest UI state.
// ---------------------------------------------------------------------------

test("the map frames the searched region's Place spread once per new server answer", () => {
  assert.match(homeMap, /searchCenter\?: \{ lat: number; lng: number \} \| null;/);
  assert.match(homeMap, /searchNonce\?: number;/);
  const effect = mapCode.slice(
    mapCode.indexOf("if (!ready || !map || !searchCenter || !searchNonce) return;"),
    mapCode.indexOf("if (!ready || !map || !searchCenter || !searchNonce) return;") + 700,
  );
  // Keyed on the nonce (one re-frame per answer), never per keystroke.
  assert.match(effect, /fitCamera\(map, searchFitPlacesRef\.current\)/);
  // Smooth, through the ONE shared camera-transition helper (2026-10-04).
  assert.match(effect, /\.\.\.cameraAnimationOptions\(\)/);
  // No marker is invented for the search center and no radius preset is
  // consulted. AUTO-FIT (product decision, 2026-10-03): the search now frames
  // the SPREAD of the Places relevant to the searched region instead of only
  // centering on the geocoder's city point — so `fitBounds` is now EXPECTED
  // here, but only through the shared auto-fit mechanism and only over the
  // canonical `searchFitPlaces` dataset (never the markers, never a radius).
  assert.doesNotMatch(effect, /circleMarker|L\.marker|radiusZoom/);
  assert.doesNotMatch(effect, /fitBounds/);
  assert.match(mapCode, /const fitCamera = useCallback/);
  assert.match(mapCode, /map\.fitBounds\(L\.latLngBounds\(corners\)/);
  // A null center (query cleared) never moves the camera, and the geocoding
  // center is KEPT whenever the region holds no Place with coordinates.
  assert.match(effect, /!searchCenter/);
  assert.match(effect, /if \(cancelled \|\| applied\) return;/);
});

test("the search status line reports server state without becoming a second search path", () => {
  assert.match(homeDiscovery, /aria-live="polite"/);
  assert.match(homeDiscovery, /role="status"/);
  // 2026-10-04: the banner is gated on a search actually running or having
  // failed, not on a non-empty query — so a RESOLVED search leaves no strip
  // and no reserved gap behind it. The status line therefore reports only the
  // two states a user can act on.
  assert.equal(
    homeDiscovery.includes("{(searchPending || searchError) && ("),
    true,
    "banner is gated on an in-flight or failed search",
  );
  assert.match(homeDiscovery, /Mencari lokasi…/);
  assert.match(homeDiscovery, /\{searchError\}/);
  // The coordinate readout this line used to print is gone from the Home UI,
  // so no raw coordinate can be rendered here. The center itself is still
  // resolved and still consumed by the camera and the search box.
  assert.doesNotMatch(homeDiscovery, /\{searchCenter\.lat\.toFixed\(4\)\}, \{searchCenter\.lng\.toFixed\(4\)\}/);
  assert.match(homeDiscovery, /cameraCenter=\{activeCenter\}/);
  // No state is persisted, and no credentials/tokens are touched.
  assert.doesNotMatch(homeDiscovery, /localStorage|sessionStorage/);
});

test("submit-only search: typed text does not trigger a geocode, Enter/submit does", () => {
  // The input handler must NOT contain the search runner or any timer.
  const handler = discoveryCode.slice(
    discoveryCode.indexOf("const handleSearchChange"),
    discoveryCode.indexOf("const handleSearchSubmit"),
  );
  assert.match(handler, /setSearchQuery\(value\);/);
  assert.doesNotMatch(handler, /runSearch|fetch\(`\/api\/geocode|setTimeout|searchEpochRef/);
  // There must be an explicit Enter/submit path with an epoch bump.
  const submitBlock = discoveryCode.slice(
    discoveryCode.indexOf("const handleSearchSubmit"),
    discoveryCode.indexOf("const handleSearchKeyDown"),
  );
  assert.match(submitBlock, /searchEpochRef\.current \+= 1;/);
  assert.match(submitBlock, /submittedSearchRef\.current = trimmed;/);
  assert.match(submitBlock, /fetch\(`\/api\/geocode\?q=\$\{encodeURIComponent\(trimmed\)\}`/);
  // The input must wire the Enter key handler.
  assert.match(discoveryCode, /onKeyDown=\{handleSearchKeyDown\}/);
  // There is still exactly one search runner.
  assert.equal(
    (discoveryCode.match(/const handleSearchSubmit = useCallback\(async/gi) ?? []).length,
    1,
    "one search runner only — no second, competing implementation",
  );
});

test("clearing the search resets the state in the clear handler, not in an effect", () => {
  const clearBlock = discoveryCode.slice(
    discoveryCode.indexOf("const handleSearchClear"),
    discoveryCode.indexOf("const handleLocatePress"),
  );
  // Clearing is a real intent change: it must invalidate a response still in
  // flight, or the old city would land right after the user cleared it.
  assert.match(clearBlock, /searchEpochRef\.current \+= 1;/);
  assert.match(clearBlock, /submittedSearchRef\.current = "";/);
  assert.match(clearBlock, /setSearchPlaceName\(cleared\.placeName\);/);
});

test("no View Intent, payment, or transaction wording leaked into the search flow", () => {
  const searchSurface = homeDiscovery.slice(
    homeDiscovery.indexOf("LOCATION SEARCH"),
    homeDiscovery.indexOf("// Home filter bar"),
  );
  for (const forbidden of [
    /checkout/i,
    /payment/i,
    /cart/i,
    /wallet/i,
    /escrow/i,
    /settlement/i,
    /transaction/i,
    /beli|checkout|bayar/i,
  ]) {
    assert.doesNotMatch(searchSurface, forbidden);
  }
});
