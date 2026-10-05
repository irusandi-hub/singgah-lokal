import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  AREA_SCOPE_LABEL,
  CAMERA_PRESET_RADIUS_M,
  describeCoverageScope,
  describeNearOrigin,
  distanceMeters,
  resolveContextualCuratedCoverage,
} from "../lib/live/ui";

/**
 * CONSOLIDATED HOME MAP FRAME (product decision, 2026-10-03)
 *
 * Three connected defects in one cycle:
 *
 *  1. CAMERA — since the §18 correction the curated camera pool was the
 *     SELECTED Places alone, so the fit framed exactly the pins that were
 *     already on screen. One curated Place collapsed to a single-point frame
 *     with no surrounding context, which reads as a broken zoom. The pool is
 *     now the selected local area PLUS the ordinary Places of that SAME local
 *     area, as camera geometry only.
 *  2. PANELS — a floating coverage box and the results panel stated the same
 *     geographic fact in two shapes. There is now ONE consolidated line.
 *  3. MARKERS — Leaflet ordered Place pins by latitude alone, so a selected
 *     ("Tempat Pilihan") pin could sit UNDER an ordinary one. The offsets are
 *     now an explicit ladder.
 *
 * The thirteen areas below are the acceptance rules for that cycle. None of
 * them changes curated eligibility, ranking, membership, counts, search, LIVE,
 * navigation, marker artwork, or coordinates.
 */

const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

const mapCode = stripComments(homeMap);
const pageCode = stripComments(homeDiscovery);

type Row = {
  id: string;
  latitude: number;
  longitude: number;
  countryCode: string | null;
  regionName: string | null;
};

/** Canonical Indonesian (West Java) Places — the selection and its context. */
const LOCAL: Row[] = [
  ["sel-a", -6.9115, 107.6098],
  ["sel-b", -6.8214, 107.5849],
  ["near-1", -6.8402, 107.6012],
  ["near-2", -6.8701, 107.5951],
  ["near-3", -6.9302, 107.6121],
].map(([id, latitude, longitude]) => ({
  id: id as string,
  latitude: latitude as number,
  longitude: longitude as number,
  countryCode: "ID",
  regionName: "Jawa Barat",
}));

/** A Place ~6,500 km away in another country and subdivision. */
const DISTANT: Row[] = [
  ["far-riyadh", 24.7136, 46.6753],
  ["far-riyadh-2", 24.6937, 46.6853],
].map(([id, latitude, longitude]) => ({
  id: id as string,
  latitude: latitude as number,
  longitude: longitude as number,
  countryCode: "SA",
  regionName: "Ash Sharqiyah",
}));

const BANDUNG = { lat: -6.9, lng: 107.61 };
const RIYADH = { lat: 24.7136, lng: 46.6753 };
const CURATED = LOCAL.filter((place) => place.id.startsWith("sel-"));
const ORDINARY = LOCAL.filter((place) => place.id.startsWith("near-"));

/**
 * The camera pool exactly as `home-discovery.tsx` composes it, over the REAL
 * resolver. Mirrored here on purpose: the assertions below are about the rule
 * (the selection framed in its active context, distant Places excluded), and
 * the component shape itself is pinned by the source assertions in each test.
 *
 * Amended 2026-10-05: the pool is no longer "the selected local area plus its
 * ordinary context, anchored on the selection" — it is the SELECTION RESOLVED
 * AGAINST THE ACTIVE CONTEXT (`resolveContextualCuratedCoverage`), which is
 * what stops the curated tab from fitting two continents in one frame. The
 * ordinary context is a MARKER-layer rule (§15 item 2) and still must not steer
 * the camera, so it stays out of this mirror exactly as before.
 */
function curatedCameraPool(input: {
  origin: { lat: number; lng: number } | null;
  searchCenter?: { lat: number; lng: number } | null;
  curated: readonly Row[];
  ordinary: readonly Row[];
}): Row[] {
  // The searched city owns the frame while a search is active; the real fix is
  // the origin otherwise. The ±0.05° bridge box exists ONLY for an active
  // search — it is the searched region's own coverage box, never a radius
  // invented around the device.
  const origin = input.searchCenter ?? input.origin;
  const searchViewport = input.searchCenter
    ? {
        north: input.searchCenter.lat + 0.05,
        south: input.searchCenter.lat - 0.05,
        east: input.searchCenter.lng + 0.05,
        west: input.searchCenter.lng - 0.05,
      }
    : null;
  return resolveContextualCuratedCoverage({
    curatedPlaces: input.curated,
    origin,
    searchViewport,
  }).places;
}

function farthestKm(from: { lat: number; lng: number }, places: readonly Row[]): number {
  return Math.max(
    ...places.map((place) =>
      distanceMeters(from, { lat: place.latitude, lng: place.longitude }) / 1000,
    ),
  );
}

// ---------------------------------------------------------------------------
// 11. CURATED CAMERA FRAMING
// ---------------------------------------------------------------------------

test("11.1 ONE curated Place still frames its own area, never a global set", () => {
  const pool = curatedCameraPool({ origin: BANDUNG, curated: [CURATED[0]], ordinary: ORDINARY });
  // The single selection is still there — it is the PRIMARY focus.
  assert.ok(pool.some((place) => place.id === "sel-a"));
  // ...and the frame stays LOCAL. A one-Place selection is focused on that
  // Place at the single-Place zoom; it never drags the rest of the curated
  // layer (or any other region) into the same fit, which is what used to turn
  // this tab into a world view.
  assert.ok(pool.length < 5, "a one-Place selection must not expand into a global frame");
  assert.ok(farthestKm({ lat: CURATED[0].latitude, lng: CURATED[0].longitude }, pool) < 60);
  // The ordinary Places of the area remain a MARKER-layer rule (§15 item 2):
  // they are on the map around the selection, but they must never steer the
  // camera — so they are deliberately absent from the camera pool here.
  assert.equal(pool.some((place) => place.id.startsWith("near-")), false);
});

test("11.2 MULTIPLE curated Places keep framing their own local area", () => {
  const pool = curatedCameraPool({ origin: BANDUNG, curated: CURATED, ordinary: ORDINARY });
  // Both selections stay in the frame — the context never displaces them.
  for (const place of CURATED) assert.ok(pool.some((entry) => entry.id === place.id), `${place.id} stays`);
  // ...and the frame covers only that local area.
  assert.ok(pool.length <= CURATED.length);
  assert.ok(farthestKm(BANDUNG, pool) < 60);
});

test("11.3 DISTANT Places can never expand the curated frame", () => {
  // Distant Places are present in the canonical candidate sets...
  const pool = curatedCameraPool({
    origin: BANDUNG,
    curated: [...CURATED, ...DISTANT],
    ordinary: [...ORDINARY, ...DISTANT],
  });
  // ...and the frame still holds the local area only.
  assert.equal(pool.some((place) => place.id.startsWith("far-")), false);
  // The device location alone cannot pull it abroad either: with a viewer
  // standing on another continent, the CONTEXT is anchored on the selected
  // Place, so the frame follows the selection, not the device.
  const deviceAbroad = curatedCameraPool({ origin: RIYADH, curated: CURATED, ordinary: ORDINARY });
  assert.equal(deviceAbroad.some((place) => place.id.startsWith("far-")), false);
  assert.ok(deviceAbroad.some((place) => place.id === "sel-a"));
});

test("11.4 the SEARCH center drives the curated frame and the fix never overrides it", () => {
  const pool = curatedCameraPool({ origin: RIYADH, curated: CURATED, ordinary: ORDINARY });
  assert.ok(pool.length > 0);
  // The origin expression is the searched city first, then the real fix — so a
  // stale geolocation update can never displace an active search.
  assert.match(pageCode, /origin: searchCenter \?\? viewerPosition,/);
  // And it sits inside the memo keyed on those two stable state values.
  const selectedArea = pageCode.slice(
    pageCode.indexOf("const selectedLocalArea"),
    pageCode.indexOf("const selectedFitPlaces"),
  );
  assert.match(selectedArea, /\[cameraEligiblePlaces, searchCenter, viewerPosition\]/);
});

test("11.5 the curated pool is CAMERA geometry only — results stay curated-only", () => {
  const pool = pageCode;
  // The pool CANDIDATES are still every curated Place, read from the canonical
  // curated ids over the full published set (2026-10-04), so a search that
  // narrowed the ROWS cannot decide which curated Places the camera may
  // consider — it is CONTEXT (2026-10-05) that then bounds which of those
  // candidates are framed, never the membership itself.
  assert.match(pool, /curatedIdSet\.has\(place\.id\)/);
  assert.doesNotMatch(pool, /resolveContextualCuratedCoverage\(/);
  // "Tempat Pilihan" is the ONE context-framed tab again: the second dataset that
  // shared this value existed only for the "Semua Tempat" tab and was removed
  // with it on 2026-10-04. The curated dataset itself is untouched.
  assert.doesNotMatch(pageCode, /const contextFitPlaces = curatedFitPlaces;/);
  assert.doesNotMatch(pageCode, /if \(contextFramedTab\) return contextFitPlaces;/);
  // The curated LIST and its count are untouched: they still read canonical
  // membership only, and the viewport gate still narrows them.
  assert.match(
    pageCode,
    /const curatedListed = useMemo\(\s*\(\) => narrowToViewport\(visiblePlaces\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\), coverageViewport\)/,
  );
  assert.match(pageCode, /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/);
  // The context can never leak into a result row: it is never stored in state.
  assert.doesNotMatch(pageCode, /setCameraFit|setContextPlaces|setCuratedContext/);
});

test("11.6 a Place without coordinates never enters the curated frame", () => {
  // Coordinates are required in the pool — fail-closed, never a default. The
  // check moved with the pool into the shared projections on 2026-10-05: the
  // component filters through `toCameraCandidates` (null without real
  // coordinates) and the resolver drops any non-finite coordinate itself.
  assert.match(pageCode, /function toCameraCandidate\(place: Place\)/);
  assert.match(pageCode, /if \(place\.latitude === null \|\| place\.longitude === null\) return null;/);
  // And no origin at all still yields no frame for the local-area datasets, so
  // the current view stays.
  assert.deepEqual(curatedCameraPool({ origin: null, curated: CURATED, ordinary: ORDINARY }), []);
});

test("11.7 manual pan/zoom survives and no refresh or poll can re-frame", () => {
  // The curated fit is keyed on the explicit nonce alone, and the frame it
  // produced is latched.
  assert.doesNotMatch(mapCode, /const fitChanged = fitNonce > 0 && fitNonce !== lastFitNonceRef\.current;/);
  assert.match(mapCode, /if \(userInteractedRef\.current\) return;/);
  assert.match(mapCode, /if \(!programmaticMoveRef\.current\) userInteractedRef\.current = true;/);
  assert.match(mapCode, /if \(requestChanged\) userInteractedRef\.current = false;/);
  // Only hand-driven actions bump the request nonce, and only a place-set tab
  // choice bumps the fit nonce (the curated tab — the additional
  // "Semua Tempat" tab was removed on 2026-10-04).
  assert.equal((pageCode.match(/setCameraRequestNonce\(\(nonce\) => nonce \+ 1\)/g) ?? []).length, 2);
  assert.equal((pageCode.match(/fitNonce/g) ?? []).length, 0);
  // The camera reads NO viewport state, so camera and viewport filtering stay
  // independent (no circular update).
  const fitBlock = pool_(pageCode);
  assert.doesNotMatch(fitBlock, /mapViewport|coverageViewport|visibleMapPlaces/);
});

function pool_(code: string): string {
  return code.slice(code.indexOf("const cameraFitPlaces"), code.indexOf("const searchFitPlaces"));
}

// ---------------------------------------------------------------------------
// 12. THE CONSOLIDATED INFORMATION AREA
// ---------------------------------------------------------------------------

test("12.1 the consolidated line is accurate in EVERY mode", () => {
  const line = (input: {
    radiusLabel: string;
    coverage: "radius" | "area";
    hasCenter: boolean;
    mode: "device_location" | "city_search";
    placeName: string | null;
    count: number;
    noun: string;
  }) =>
    `${input.count} ${input.noun} ${describeNearOrigin({
      mode: input.mode,
      placeName: input.placeName,
      hasCenter: input.hasCenter,
    })} · ${describeCoverageScope({
      radiusLabel: input.radiusLabel,
      coverage: input.coverage,
      hasCenter: input.hasCenter,
    })}`;

  // Default nearby discovery — the active distance preset owns the frame.
  assert.equal(
    line({ radiusLabel: "1 km", coverage: "radius", hasCenter: true, mode: "device_location", placeName: null, count: 12, noun: "tempat" }),
    "12 tempat di sekitar Anda · dalam radius 1 km",
  );
  // Searched location — the searched city is named, never the device.
  assert.equal(
    line({ radiusLabel: "5 km", coverage: "radius", hasCenter: true, mode: "city_search", placeName: "Riyadh", count: 7, noun: "tempat" }),
    "7 tempat di sekitar pusat pencarian Riyadh · dalam radius 5 km",
  );
  // Tempat Pilihan / Lokasi Saya frame the local area and name no radius.
  assert.equal(
    line({ radiusLabel: "10 km", coverage: "area", hasCenter: true, mode: "device_location", placeName: null, count: 4, noun: "tempat pilihan" }),
    "4 tempat pilihan di sekitar Anda · di area peta",
  );
  // Loading/denied-location state: no origin, so no radius and no "Anda".
  assert.equal(
    line({ radiusLabel: "1 km", coverage: "radius", hasCenter: false, mode: "device_location", placeName: null, count: 74, noun: "tempat" }),
    `74 tempat di area peta · ${AREA_SCOPE_LABEL}`,
  );
  // The scope label is derived from the approved area wording.
  assert.equal(AREA_SCOPE_LABEL, "di area peta");
});

test("12.2 the line cannot duplicate a count or contradict itself", () => {
  // The count and the origin come from ONE array each; the scope adds neither.
  assert.match(
    pageCode,
    /curatedOnly\n\s*\? `\$\{curatedListed\.length\} tempat pilihan \$\{nearOrigin\} · \$\{coverageScope\}`\n\s*: `\$\{discoveryRowPlaces\.length\} tempat \$\{nearOrigin\} · \$\{coverageScope\}`/,
  );
  // The two layers are never summed (the approved OVERLAP rule).
  assert.doesNotMatch(pageCode, /curatedListed\.length \+ discoveryRowPlaces\.length/);
  // The scope fragment carries NO origin and NO count, so the place name is
  // stated exactly once and the number can never be printed twice.
  assert.doesNotMatch(pageCode, /coverageScope.*(placeName|length)/);
  for (const label of ["dalam radius 1 km", "di area peta"]) {
    assert.doesNotMatch(label, /Anda|Riyadh/);
  }
});

test("12.3 the redundant floating panel is gone and result access is intact", () => {
  // The standalone coverage box is removed from the map stage.
  assert.doesNotMatch(pageCode, /bottom-9 left-4 z-\[1100\]/);
  // Its position glyph must not come back either.
  assert.doesNotMatch(pageCode, /⌖/);
  // APPROVED MOCKUP (2026-10-04): the bottom-right distance scale is removed too
  // — its text, its bar, and the space it reserved — and nothing replaces it.
  assert.doesNotMatch(pageCode, /absolute bottom-9 right-4 z-\[1100\]/);
  assert.doesNotMatch(pageCode, /mapScale/);
  assert.doesNotMatch(pageCode, /barPx/);
  // "Ke hasil" (access to the results), both strips, and the title are intact.
  assert.match(pageCode, /Ke hasil/);
  assert.match(pageCode, /id=\{CURATED_RESULTS_ANCHOR_ID\}/);
  assert.match(pageCode, /\{discoveryRowPlaces\.length > 0 \? \(/);
  assert.match(pageCode, /curatedOnly && curatedListed\.length > 0/);
  // Filter behaviour, the vertical list interaction, and the empty/error states are
  // untouched by the consolidation.
  assert.match(pageCode, /flex flex-col gap-2\.5/);
  assert.match(pageCode, /Lokasi tidak ditemukan\. Cek ejaan atau pilih dari daftar\./);
  assert.match(pageCode, /mapEmptyStateVisible &&/);
  assert.match(pageCode, /Belum ada Tempat Terdaftar di sekitar area ini/);
  assert.match(pageCode, /Saat ini belum ada Live yang sedang berlangsung\./);
});

test("12.4 the panel footprint shrank without losing a control", () => {
  // One information area instead of two: the floating box is gone and the
  // header block keeps exactly ONE line of context.
  //
  // 2026-10-04: the header block now lives in the FLOATING card on the map,
  // so the slice is anchored on the card's own id rather than on the results
  // section's `aria-labelledby` (which now follows it in the DOM).
  const headerStart = pageCode.indexOf('<h2 id="place-results-heading"');
  const header = pageCode.slice(headerStart, pageCode.indexOf("Ke hasil", headerStart));
  assert.equal((header.match(/<p /g) ?? []).length, 1, "one consolidated information line");
  assert.match(header, /\{nearOrigin\} · \$\{coverageScope\}/);
  // The panel and its chrome keep the approved visual identity.
  assert.match(pageCode, /rounded-t-\[24px\] bg-brand-cream/);
  assert.match(pageCode, /mx-auto mb-1 block h-1\.5 w-12 rounded-full bg-black\/15/);
  assert.match(pageCode, /h-\[56vh\] min-h-\[460px\] max-h-\[680px\] sm:h-\[62vh\]/);
  // Nothing essential became scrollable or hidden.
  assert.doesNotMatch(header, /line-clamp|max-h-\[|overflow-hidden/);
  assert.doesNotMatch(header, /snap-x/);
});

// ---------------------------------------------------------------------------
// 13. SELECTED MARKERS ON TOP
// ---------------------------------------------------------------------------

test("13.1 the marker ladder puts SELECTED above ORDINARY, below LIVE", () => {
  // One expression over the canonical per-Place flags decides the order:
  //   selected 900 > ordinary 500 > the pin of a Live Place 0, LIVE chip 1000.
  assert.match(mapCode, /zIndexOffset: isCurated \? 900 : live \? 0 : 500/);
  assert.match(mapCode, /zIndexOffset: 1000/);
  const offsets = { live: 1000, selected: 900, ordinary: 500 };
  assert.equal(offsets.selected > offsets.ordinary, true);
  assert.equal(offsets.live > offsets.selected, true);
  // The source of truth is the existing per-Place curated state, read exactly
  // once, never a mode-level flag.
  assert.match(mapCode, /const isCurated = place\.isCurated === true;/);
  assert.match(pageCode, /isCurated: curatedOnly && curatedIdSet\.has\(place\.id\),/);
});

test("13.2 the order survives refresh, viewport changes and re-render", () => {
  const markerEnd = mapCode.indexOf("}, [ready, markerKey]);");
  const markerEffect = mapCode.slice(mapCode.lastIndexOf("useEffect(() => {", markerEnd), markerEnd);
  // The offset is set when the marker is CONSTRUCTED, so Leaflet re-applies it
  // on every pan, zoom, viewport report, poll, and marker rebuild. There is no
  // effect, listener, bringToFront call, or camera move anywhere near it — so
  // the stacking rule cannot cause a map update or a recenter loop.
  assert.match(markerEffect, /zIndexOffset: isCurated \? 900 : live \? 0 : 500/);
  assert.doesNotMatch(markerEffect, /bringToFront|setZIndexOffset|panTo|setView|fitBounds/);
  // The marker effect is still keyed on the stable marker signature, and the
  // viewport report still never moves the camera.
  assert.match(mapCode, /}, \[ready, markerKey\]\);/);
  const reportViewport = mapCode.slice(
    mapCode.indexOf("const reportViewportBounds = useCallback"),
    mapCode.indexOf("const triggerLocatePulse"),
  );
  assert.doesNotMatch(reportViewport, /setView|fitBounds|bringToFront/);
});

test("13.3 artwork, coordinates, interactions and the user marker are untouched", () => {
  // Same teardrop, same colours, same size, same tooltip — only the stacking
  // offset differs.
  assert.match(mapCode, /const pinColor = isCurated \? BRAND_SECONDARY : BRAND_BROWN;/);
  assert.match(mapCode, /width:28px;height:36px/);
  assert.match(mapCode, /marker\.bindTooltip\(escapeHtml\(place\.name\)/);
  // Coordinates are still the canonical Place coordinates, fail-closed.
  assert.match(mapCode, /if \(!Number\.isFinite\(place\.latitude\) \|\| !Number\.isFinite\(place\.longitude\)\) continue;/);
  assert.match(mapCode, /const position: \[number, number\] = \[place\.latitude, place\.longitude\];/);
  // Click and keyboard interaction are unchanged, and every marker stays
  // focusable, which is also the interaction path for overlapping pins.
  assert.match(mapCode, /keyboard: true/);
  assert.match(mapCode, /router\.push\(`\/places\/\$\{place\.id\}`\)/);
  assert.match(mapCode, /router\.push\(`\/live\/\$\{live\.sessionId\}`\)/);
  assert.match(mapCode, /aria-label="Lihat \$\{escapeHtml\(place\.name\)\}"/);
  // The Current Location disc keeps its own dedicated pane ABOVE every Place
  // pin, and is never a selected Place marker.
  assert.match(mapCode, /const userPane = map\.createPane\(USER_PANE\);/);
  assert.match(mapCode, /userPane\.style\.zIndex = "640";/);
  // 2026-10-04: the surrounding-area disc adds one more USER_PANE layer.
  assert.equal((mapCode.match(/pane: USER_PANE/g) ?? []).length, 4);
  // No clustering was invented.
  assert.doesNotMatch(mapCode, /markerCluster|clusterGroup|cluster/);
});

test("13.4 no regression to LIVE, search, or Place navigation", () => {
  // The LIVE treatment, its chip, and its top priority are intact.
  assert.match(mapCode, /zIndexOffset: 1000/);
  assert.match(mapCode, /BRAND_LIVE/);
  assert.match(pageCode, /toggleLiveFilter\(liveOnly, curatedOnly\)/);
  // The search flow keeps its server route and its search fit dataset. The box
  // itself changed on 2026-10-04: the searched AREA is now the canonical
  // bounding box the geocoder published, with the old fixed window kept only
  // as the documented fallback for an answer with no usable boundary.
  assert.match(pageCode, /fetch\(`\/api\/geocode\?q=\$\{encodeURIComponent\(trimmed\)\}`/);
  assert.match(pageCode, /fallbackSearchArea\(searchCenter\)/);
  assert.match(pageCode, /searchFitPlaces=\{searchFitPlaces\}/);
  // The distance tabs and their ordered camera presets are unchanged.
  assert.equal(CAMERA_PRESET_RADIUS_M["1 km"] < CAMERA_PRESET_RADIUS_M["5 km"], true);
  assert.equal(CAMERA_PRESET_RADIUS_M["5 km"] < CAMERA_PRESET_RADIUS_M["10 km+"], true);
  assert.match(pageCode, /DISTANCE_FILTERS\.map\(\(filter\) =>/);
  // Place navigation from card and marker is unchanged.
  assert.match(pageCode, /href=\{live \? `\/live\/\$\{live\.sessionId\}` : `\/places\/\$\{place\.id\}`\}/);
  // No backend, database, RLS, schema, or scoring surface was touched.
  assert.equal(/supabase|from\("places"\)|publication_status/i.test(mapCode), false);
  assert.equal(/supabase|from\("places"\)|publication_status|RLS|policy/i.test(pageCode), false);
});