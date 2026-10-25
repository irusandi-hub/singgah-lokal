import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  CAMERA_FIT_PADDING,
  DISTANCE_FILTERS,
  LIVE_FILTER_LABEL,
  activateCuratedFilter,
  resolveContextualCuratedCoverage,
  resolveContextualPlaceCoverage,
  pinLabelBudgetForZoom,
  selectVisiblePinLabelIds,
  toggleLiveFilter,
  type PinLabelBox,
} from "../lib/live/ui";

/**
 * HOME TAB ROW — the approved five-control row, and the tab that is GONE.
 *
 * This file replaces the former "Semua Tempat" all-Places tab suite. The tab
 * (its button, its `allPlacesOnly` mode, its own camera dataset, and its
 * "paint every name" pin-label rule) was REMOVED on 2026-10-04: the approved
 * Home/Map mockup has no such tab, and no other entry point for it is defined
 * by the approved product flow, so nothing replaced it.
 *
 * What is locked here now:
 *
 *  1. ABSENCE — no "Semua Tempat" tab, no replacement control, and no
 *     alternative entry point back into the removed mode.
 *  2. THE ROW THAT REMAINS — LIVE, "Tempat Pilihan", and the three distance
 *     tabs, in that order, on the same single row, with their own handlers.
 *  3. WHAT THE REMOVAL MUST NOT HAVE TOUCHED — the curated dataset, the shared
 *     contextual coverage rule, the pin-label density budget, Place selection,
 *     navigation, and the canonical data source.
 */

const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");
const homeMap = readFileSync(new URL("../components/home-map.tsx", import.meta.url), "utf8");
const curatedMapTab = readFileSync(new URL("../components/curated-map-tab.tsx", import.meta.url), "utf8");

/** The comment-free component source: comments describe, they never decide. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const discoveryCode = stripComments(homeDiscovery);
const mapCode = stripComments(homeMap);
const tabCode = stripComments(curatedMapTab);

type Row = { id: string; latitude: number; longitude: number; countryCode: string | null; regionName: string | null };

const BANDUNG: Row = { id: "anchor", latitude: -6.9175, longitude: 107.6191, countryCode: "ID", regionName: "Jawa Barat" };

const center = (place: Row) => ({ lat: place.latitude, lng: place.longitude });

function rows(...items: Array<Partial<Row> & { id: string }>): Row[] {
  return items.map((item) => ({
    latitude: item.latitude ?? -6.9,
    longitude: item.longitude ?? 107.6,
    countryCode: item.countryCode ?? "ID",
    regionName: item.regionName ?? "Jawa Barat",
    ...item,
  }));
}

// ---------------------------------------------------------------------------
// 1. The removed tab can never come back, by any route.
// ---------------------------------------------------------------------------

test("no 'Semua Tempat' tab is rendered anywhere in the Home surface", () => {
  // Comments are allowed to name the removed tab (that is how the removal is
  // documented); what must not survive is anything the browser can render or
  // anything the component can branch on. The ONLY surviving occurrence of the
  // words is the long-standing LIVE empty-state action, which clears LIVE and
  // predates the tab by several PRs — it is not an entry point into the mode.
  assert.equal(discoveryCode.includes(">{ALL_PLACES_FILTER_LABEL}"), false);
  assert.equal(discoveryCode.includes('data-home-tab="all-places"'), false, "no tab hook for the removed mode");
  const occurrences = discoveryCode.match(/Semua Tempat/g) ?? [];
  assert.deepEqual(occurrences, ["Semua Tempat"], "only the LIVE empty-state action may use the words");
  assert.match(discoveryCode, /Lihat Semua Tempat/);
});

test("the removed content mode leaves no state, handler, or prop behind", () => {
  // One unreachable flag would be a second, invisible way into a dataset that
  // the approved UI no longer offers, so the whole mode goes with the tab.
  for (const symbol of [
    "allPlacesOnly",
    "setAllPlacesOnly",
    "activateAllPlacesFilter",
    "ALL_PLACES_FILTER_LABEL",
    "leavePlaceSetTabs",
    "labelEveryPlaceName",
    "onScaleChange",
    "mapScale",
  ]) {
    assert.equal(discoveryCode.includes(symbol), false, `${symbol} must not remain in home-discovery.tsx`);
  }
  // The map's own all-Places label mode and scale measurement go with it.
  for (const symbol of [
    "labelEveryPlaceName",
    "resolveAllPlacesLabelLayout",
    "resolveMapScale",
    "onScaleChange",
    "labelAnchorStyle",
    "toViewportBounds",
  ]) {
    assert.equal(mapCode.includes(symbol), false, `${symbol} must not remain in home-map.tsx`);
  }
});

test("no alternative entry point for the removed mode was invented", () => {
  // The only Place-listing affordances that may exist are the ones the approved
  // mockup keeps: the tab row, the floating results panel, and the pre-existing
  // LIVE empty-state action (which clears LIVE, a long-standing control and not
  // a back door into the removed mode).
  assert.equal((discoveryCode.match(/data-home-tab=/g) ?? []).length, 0);
  assert.doesNotMatch(discoveryCode, /setAllPlacesOnly|activateAllPlacesFilter/);
  // The LIVE empty state keeps its own button and clears only LIVE.
  assert.match(discoveryCode, /onClick=\{\(\) => setLiveOnly\(false\)\}/);
  assert.doesNotMatch(discoveryCode, /onClick=\{\(\) => setCuratedOnly\(true\)\}/);
});

// ---------------------------------------------------------------------------
// 2. The row that remains: five controls, same order, same handlers.
// ---------------------------------------------------------------------------

test("the filter row is ONE row: LIVE, the three distance tabs, then Lokasi Saya", () => {
  // 2026-10-23: "Lokasi Saya" moved out of the removed map control column and
  // into the LAST cell of the same one-row group as LIVE and the radii.
  assert.match(
    discoveryCode,
    /<div className="pointer-events-auto mt-2\.5 grid w-full min-w-0 grid-cols-\[auto_repeat\(3,minmax\(0,1fr\)\)_44px\] gap-1\.5 rounded-\[16px\] bg-brand-cream ring-1 ring-black\/5">/,
    "the single five-control row is the current approved layout",
  );
  const live = discoveryCode.indexOf("aria-pressed={liveOnly}");
  const distances = discoveryCode.indexOf("DISTANCE_FILTERS.map");
  const locate = discoveryCode.indexOf("data-home-locate");
  assert.ok(live > -1, "LIVE stays leftmost");
  assert.ok(distances > live, "the distance tabs follow LIVE");
  assert.ok(locate > distances, "Lokasi Saya is the last control in the row");
  assert.ok(discoveryCode.includes(LIVE_FILTER_LABEL), "LIVE keeps its master label");
  assert.equal((discoveryCode.match(/DISTANCE_FILTERS\.map/g) ?? []).length, 1, "exactly one distance-tab loop");
  assert.deepEqual(DISTANCE_FILTERS, ["1 km", "5 km", "10 km+"]);
  // The curated tab is NOT in this row: it is the ONE floating CuratedMapTab
  // rendered over the map. The row itself carries no curated handler.
  const row = discoveryCode.slice(discoveryCode.indexOf('grid-cols-[auto_repeat(3,minmax(0,1fr))_44px]'));
  const rowEnd = row.indexOf("</div>");
  assert.equal((row.slice(0, rowEnd).match(/<button/g) ?? []).length, 1 + 1 + 1);
  assert.equal((row.slice(0, rowEnd).match(/DISTANCE_FILTERS\.map/g) ?? []).length, 1);
  assert.match(row.slice(0, rowEnd), /onClick=\{handleLocatePress\}/);
  assert.match(row.slice(0, rowEnd), /aria-label="Lokasi saya — pusatkan peta ke lokasi aktual"/);
  assert.doesNotMatch(row.slice(0, rowEnd), /activateCuratedFilter/);
  assert.equal((discoveryCode.match(/<CuratedMapTab/g) ?? []).length, 1);
});

test("the filter row paints an opaque surface so nothing behind it can leak", () => {
  // BUG (2026-10-20): the four chips floated straight on the map, so the 6px
  // gaps between them showed whatever sat behind — a truncated Place name chip
  // ("…al") could be read THROUGH the filter row. Measured on the previous
  // production build at 360px: the row's computed background was
  // rgba(0, 0, 0, 0) and a gap pixel sampled the map tile (170,211,223).
  const row = discoveryCode.slice(
    discoveryCode.indexOf("pointer-events-auto mt-2.5 grid"),
    discoveryCode.indexOf("DISTANCE_FILTERS.map"),
  );
  assert.match(row, /rounded-\[16px\] bg-brand-cream ring-1 ring-black\/5/, "the row paints the opaque brand surface");
  assert.doesNotMatch(row, /bg-white\/\d|bg-brand-cream\/\d|backdrop-blur/, "no translucency of any kind");
  // Zero padding/layout change: the row's height and the control column's
  // 190px start (measured from this chrome) are untouched, so the surface adds
  // colour only. The chips are the row's own children — no wrapper was added.
  const rowClass = /<div className="([^"]*pointer-events-auto mt-2\.5 grid[^"]*)">/.exec(discoveryCode)?.[1] ?? "";
  assert.ok(rowClass.length > 0, "the filter row keeps its own element");
  assert.doesNotMatch(rowClass, /\bp-|\bpt-|\bpb-|\bpy-|\bpx-/, "the surface adds no padding");
  assert.match(rowClass, /\bbg-brand-cream\b/);
});

test("the curated tab is ONE floating, draggable control over the map", () => {
  // 2026-10-21: the chip left the sheet header and became a floating tab.
  assert.match(discoveryCode, /<CuratedMapTab\s+pressed=\{curatedOnly\}\s+onToggle=\{handleCuratedToggle\}/);
  assert.equal((tabCode.match(/data-curated-map-tab/g) ?? []).length, 1, "one instance");
  assert.match(tabCode, /aria-pressed=\{pressed\}/);
  // 44px touch height, own pointer gestures, no page/map gesture leak.
  assert.match(tabCode, /\bh-11\b/);
  assert.match(tabCode, /touch-none/);
  assert.match(tabCode, /setPointerCapture/);
  assert.match(tabCode, /onPointerMove=\{moveDrag\}/);
  assert.match(tabCode, /CURATED_TAB_DRAG_THRESHOLD_PX/);
  // PRESENTATION (2026-10-22): ONE capsule — no divider, no ≡ glyph — with
  // opaque white + dark-green text when idle and a dark-green gradient +
  // white text when active. Both carry a soft LAYERED shadow, and the drag
  // lift is a 1.04 scale.
  assert.match(tabCode, /rounded-full/);
  assert.doesNotMatch(tabCode, /M1 2h6M1 7h6M1 12h6/, "the ≡ grip glyph is gone");
  assert.doesNotMatch(tabCode, /border-r\b/, "no divider inside the capsule");
  assert.match(tabCode, /is-active bg-\[linear-gradient\(135deg,#127a5a_0%,var\(--brand-primary\)_52%,var\(--brand-primary-deep\)_100%\)\] text-white/);
  assert.match(tabCode, /bg-white text-brand-primary shadow-\[0_1px_2px_rgb\(32_35_31\/0\.06\),0_5px_12px_rgb\(32_35_31\/0\.10\),0_12px_24px_rgb\(32_35_31\/0\.06\)\]/);
  assert.match(tabCode, /is-dragging scale-\[1\.04\]/);
  assert.match(tabCode, /<span aria-hidden className="singgah-curated-tab-star">/);
  // The grip is six faint dots inside the same surface, still the handle.
  assert.match(tabCode, /data-curated-tab-handle/);
  assert.equal((tabCode.match(/<circle /g) ?? []).length, 6);
  // Position is persisted per viewport and snapped/clamped; it is hidden at
  // `full` and the help panel can reset it.
  assert.match(tabCode, /CURATED_TAB_STORAGE_KEY/);
  assert.match(tabCode, /snapCuratedTabPlacement/);
  assert.match(tabCode, /resolveCuratedTabArea/);
  assert.match(tabCode, /sheetVisiblePx >= stageHeight\) return null/);
  assert.match(tabCode, /export function resetCuratedTabPlacement/);
  // The sheet header keeps ONLY the drag handle.
  const header = discoveryCode.slice(
    discoveryCode.indexOf('<h2 id="place-results-heading"'),
    discoveryCode.indexOf("ref={sheetListRef}"),
  );
  assert.equal((header.match(/<button/g) ?? []).length, 1, "only the handle remains in the band");
  assert.equal(discoveryCode.includes("CURATED_TAB_HANG_PX"), false);
  assert.equal((discoveryCode.match(/aria-pressed=\{curatedOnly\}/g) ?? []).length, 0);
  assert.doesNotMatch(discoveryCode, /block h-1 w-10 rounded-full bg-black\/10/);
});

test("LIVE, 'Tempat Pilihan', and the distance tabs keep their own transitions", () => {
  assert.deepEqual(activateCuratedFilter(), { liveOnly: false, curatedOnly: true });
  assert.deepEqual(toggleLiveFilter(true, false), { liveOnly: false, curatedOnly: false });
  assert.deepEqual(toggleLiveFilter(false, true), { liveOnly: true, curatedOnly: false });
  // The curated tab still only switches layers: it fits no frame, claims no
  // caption (that state was removed with the board on 2026-10-18), and bumps
  // no camera nonce.
  const curatedHandler = discoveryCode.slice(
    discoveryCode.indexOf("const next = curatedOnly ? deactivateCuratedFilter() : activateCuratedFilter();"),
    discoveryCode.indexOf("const next = curatedOnly ? deactivateCuratedFilter() : activateCuratedFilter();") + 500,
  );
  assert.doesNotMatch(curatedHandler, /setFitNonce\(\(nonce\) => nonce \+ 1\);/);
  assert.doesNotMatch(curatedHandler, /setCameraCoverage/);
  assert.doesNotMatch(curatedHandler, /setCameraRequestNonce/);
  // A distance tab sets its radius, leaves the curated layer, and releases the
  // camera latch — exactly the rules it had before.
  const distanceHandler = discoveryCode.slice(
    discoveryCode.indexOf("setDistanceFilter(filter);"),
    discoveryCode.indexOf("setDistanceFilter(filter);") + 400,
  );
  assert.match(distanceHandler, /setCuratedOnly\(false\);/);
  assert.doesNotMatch(distanceHandler, /setCameraCoverage/);
  assert.match(distanceHandler, /setCameraRequestNonce\(\(nonce\) => nonce \+ 1\);/);
});

test("selected state is unchanged: one active control, brand green or LIVE red", () => {
  assert.match(discoveryCode, /aria-pressed=\{liveOnly\}/);
  // The curated control carries the SAME boolean, through one prop.
  assert.match(discoveryCode, /<CuratedMapTab\s+pressed=\{curatedOnly\}/);
  assert.match(tabCode, /aria-pressed=\{pressed\}/);
  assert.equal((tabCode.match(/aria-pressed=/g) ?? []).length, 1);
  // Still exactly one pressed distance tab — and since 2026-10-25 it is only
  // pressed while the radius has an anchor to centre on (or while the first
  // location attempt is still settling, so it never blinks).
  assert.match(discoveryCode, /aria-pressed=\{selected\}/);
  // STRENGTHENED (2026-10-25): with the condition moved into a named value the
  // old single-line assertion could pass while the attribute read some other
  // boolean. Bind the pieces explicitly: ONE rule, computed before the tab and
  // read by that tab's aria-pressed, with no second inline copy of the old
  // expression anywhere in Home.
  assert.match(
    discoveryCode,
    /const selected =\s*distanceFilter === filter && !curatedOnly && \(activeCenter !== null \|\| !viewerSettled\);/,
  );
  const selectedRuleAt = discoveryCode.indexOf("const selected =");
  const pressedReadAt = discoveryCode.indexOf("aria-pressed={selected}", selectedRuleAt);
  assert.ok(
    selectedRuleAt > 0 && pressedReadAt > selectedRuleAt,
    "the distance tab's aria-pressed reads the anchored rule, in that order",
  );
  assert.doesNotMatch(discoveryCode, /aria-pressed=\{distanceFilter === filter/);
  const distanceTab = discoveryCode.slice(
    selectedRuleAt,
    discoveryCode.indexOf("data-home-locate", selectedRuleAt),
  );
  assert.equal(
    (distanceTab.match(/aria-pressed=/g) ?? []).length,
    1,
    "exactly one distance tab can claim the pressed state",
  );
});

// ---------------------------------------------------------------------------
// 3. What the removal must not have changed.
// ---------------------------------------------------------------------------

test("the curated dataset is untouched", () => {
  assert.match(
    discoveryCode,
    /if \(curatedOnly\) \{\s*return searchFiltered\.filter\(\(place\) => curatedIdSet\.has\(place\.id\)\);/,
  );
  // Only the two place-set rules remain, and they stay mutually exclusive.
  assert.doesNotMatch(discoveryCode, /const contextFramedTab = curatedOnly;/);
  assert.doesNotMatch(discoveryCode, /const contextFitPlaces = curatedFitPlaces;/);
});

test("the contextual coverage rule is still ONE shared implementation", () => {
  const curated = resolveContextualCuratedCoverage({
    curatedPlaces: rows(BANDUNG, { id: "a", latitude: -6.9, longitude: 107.6 }),
    origin: center(BANDUNG),
    searchViewport: null,
  });
  const generic = resolveContextualPlaceCoverage({
    places: rows(BANDUNG, { id: "a", latitude: -6.9, longitude: 107.6 }),
    origin: center(BANDUNG),
    searchViewport: null,
  });
  assert.deepEqual(curated, generic);
  // It still frames the viewer's context, never the whole world.
  const world = rows(
    BANDUNG,
    { id: "riyadh-1", latitude: 24.6937, longitude: 46.6853, countryCode: "SA", regionName: "Ash Sharqiyah" },
  );
  const frame = resolveContextualPlaceCoverage({ places: world, origin: center(BANDUNG), searchViewport: null });
  assert.equal(frame.basis, "area");
  assert.deepEqual(frame.places.map((place) => place.id), ["anchor"]);
  assert.equal(frame.consideredCount, 2);
});

test("the zoom-aware label declutter is still the only label rule", () => {
  // Every rendered pin keeps ONE placement — below the pin — and the
  // deterministic, PROJECTED pass decides which chips stay painted. No
  // clustering, no layout measurement, and no name can be dropped from the DOM.
  assert.match(mapCode, /const visible = selectVisiblePinLabelIds\(\{ boxes, zoom, pinnedId: selectedId \}\);/);
  assert.match(mapCode, /const labelState = "on-demand";/);
  assert.match(
    mapCode,
    /<span class="singgah-pin-label" \$\{PIN_LABEL_ON_DEMAND_ATTRIBUTE\}="\$\{labelState\}" style="\$\{PIN_LABEL_ANCHOR_STYLE\}">\$\{escapeHtml\(place\.name\)\}<\/span>/,
  );
  assert.match(mapCode, /applyPinLabelStates\(map, currentPlaces, liveByPlaceId, highlightedPlaceId\);/);
  assert.match(mapCode, /map\.on\("zoomend", refreshPinLabelsAtCurrentZoom\);/);
  assert.equal((mapCode.match(/getBoundingClientRect\(\)/g) ?? []).length, 1, "only the pre-existing pulse reflow");
  assert.doesNotMatch(mapCode, /offsetWidth|offsetHeight|clientWidth|clientHeight/);
  assert.equal((mapCode.match(/L\.marker\(/g) ?? []).length, 2, "one base marker plus the LIVE pin");
  assert.doesNotMatch(mapCode, /markerClusterGroup|L\.markerClusterGroup/);
  // The rules themselves still behave: a dense frame keeps at least one label
  // and never all, and a far frame is stricter than a close one.
  const dense: PinLabelBox[] = Array.from({ length: 40 }, (_, index) => ({
    id: `p-${index}`,
    x: 0,
    y: 0,
    width: 120,
    height: 18,
    tier: index < 2 ? 1 : 3,
  }));
  const crowded = selectVisiblePinLabelIds({ boxes: dense, zoom: 16 });
  assert.equal(crowded.size, 1, "colliding chips are held back even at a close zoom");
  // The density threshold itself widens with the zoom (the same marker set at
  // a closer camera can carry more names).
  assert.ok(pinLabelBudgetForZoom(8) < pinLabelBudgetForZoom(16));
  assert.ok(pinLabelBudgetForZoom(16) <= 12);
  // Spread-out boxes are collision-free, so only the density budget limits
  // them — and the far frame is stricter than the close one.
  const spacedAt = (gap: number): PinLabelBox[] =>
    Array.from({ length: 40 }, (_, index) => ({
      id: `s-${index}`,
      x: index * gap,
      y: 0,
      width: 120,
      height: 18,
      tier: 3,
    }));
  assert.equal(selectVisiblePinLabelIds({ boxes: spacedAt(200), zoom: 8 }).size, pinLabelBudgetForZoom(8));
  assert.equal(selectVisiblePinLabelIds({ boxes: spacedAt(200), zoom: 16 }).size, pinLabelBudgetForZoom(16));
  // A selected Place is labelled even inside the crowd, and it keeps its slot.
  const pinned = selectVisiblePinLabelIds({ boxes: dense, zoom: 8, pinnedId: "p-20" });
  assert.equal(pinned.has("p-20"), true);
});

test("Place selection, navigation, and the canonical data source are untouched", () => {
  // A base pin now SELECTS its card (2026-10-18); the card stays the only
  // navigation target. Without a selector the legacy direct route remains.
  assert.match(
    mapCode,
    /onSelectPlace\s*\?\s*onSelectPlace\(place\.id\)\s*:\s*router\.push\(`\/places\/\$\{place\.id\}`\)/,
  );
  assert.match(mapCode, /onSelectPlace\?: \(placeId: string\) => void;/);
  assert.match(discoveryCode, /<VisitedLink/);
  assert.equal(discoveryCode.includes('href={`/places/${'), false, "no new Place route");
  assert.match(discoveryCode, /const \[places\] = useState<Place\[\]>\(initialPlaces\);/);
  // Exactly ONE fetch exists in the whole Home surface (the LIVE poll that was
  // always there), so removing the tab removed no data path and added none.
  assert.equal((discoveryCode.match(/fetch\("/g) ?? []).length, 1);
  assert.equal(discoveryCode.match(/useQuery|supabase|createClient/g), null);
  assert.match(discoveryCode, /const seen = new Set<string>\(\);/);
});

test("the empty state, the dedupe, and the reserved camera padding still hold", () => {
  assert.match(discoveryCode, /Belum ada Tempat Terdaftar di sekitar area ini/);
  assert.match(discoveryCode, /Belum ada Tempat Pilihan di sekitar area ini/);
  assert.equal(CAMERA_FIT_PADDING.top, 190);
  assert.equal(CAMERA_FIT_PADDING.right, 76);
});