import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  DISTANCE_FILTERS,
  clearCitySearch,
  describeRadiusOrigin,
  resolveActiveCenter,
  type ActiveCenter,
} from "../lib/live/ui";

/**
 * HOME SEARCH CLARITY (bug fix 2026-10-03)
 *
 * A device screenshot showed three separate complaints on the Home map:
 *   1. the radius caption read "dari lokasi Anda" while the map and the
 *      results were centered on a SEARCHED city, so a Riyadh result set was
 *      captioned as if it were measured from the device;
 *   2. the map empty state was a full-width panel that covered a large part
 *      of the map;
 *   3. the "Tempat Pilihan" filter appeared TWICE — once in the main filter
 *      bar and again as a chip floating over the map area.
 *
 * None of these changed product concepts, discovery logic, ranking, or the
 * filter itself. This suite locks the clarity rules shut so the caption can
 * never describe an origin the results are not actually using, and so the
 * duplicate control cannot quietly return.
 */

/** The two real coordinates from the device report. */
const RIYADH: ActiveCenter = { lat: 24.6389, lng: 46.716 };
const DAMMAM: ActiveCenter = { lat: 26.4207, lng: 50.0888 };

const homeDiscovery = readFileSync(new URL("../components/home-discovery.tsx", import.meta.url), "utf8");

function stripComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") && !line.trim().startsWith("/*"))
    .join("\n");
}

const discoveryCode = stripComments(homeDiscovery);

// ---------------------------------------------------------------------------
// Requirement A — the caption names the center that is really measuring
// ---------------------------------------------------------------------------

test("R-A: a searched city is named in the caption for every radius tab", () => {
  for (const tab of DISTANCE_FILTERS) {
    const caption = describeRadiusOrigin({
      radiusLabel: tab.replace("+", ""),
      mode: "city_search",
      placeName: "Riyadh",
    });
    // Riyadh + 1 km / 5 km / 10 km must all point at the search center.
    assert.match(caption, /dari pusat pencarian Riyadh$/);
    assert.ok(caption.includes(tab.replace("+", "")), `${tab} must appear in the caption`);
  }
});

test("R-A: the user-location caption keeps its original wording", () => {
  assert.equal(
    describeRadiusOrigin({ radiusLabel: "1 km", mode: "device_location", placeName: null }),
    "Menampilkan tempat dalam radius 1 km dari lokasi Anda",
  );
  // A device caption must never mention a city, even if a stale name is around.
  assert.doesNotMatch(
    describeRadiusOrigin({ radiusLabel: "5 km", mode: "device_location", placeName: "Riyadh" }),
    /Riyadh/,
  );
});

test("R-A: an unresolved city name falls back to a neutral phrase, never a guess", () => {
  // No resolved name available -> an accurate, non-committal phrase. It must
  // NOT echo the typed text ("bangu") and must NOT invent a city.
  for (const unknown of [null, "", "   "]) {
    const caption = describeRadiusOrigin({ radiusLabel: "1 km", mode: "city_search", placeName: unknown });
    assert.match(caption, /dari pusat area pencarian$/);
    assert.doesNotMatch(caption, /bangu/);
  }
});

test("R-A: the caption follows the SAME active center the results use", () => {
  // The whole point: caption origin === the center the coverage filter used.
  const { mode, center } = resolveActiveCenter({ searchCenter: RIYADH, viewerPosition: DAMMAM });
  assert.equal(mode, "city_search");
  assert.deepEqual(center, RIYADH);
  assert.match(
    describeRadiusOrigin({ radiusLabel: "1 km", mode, placeName: "Riyadh" }),
    /pusat pencarian Riyadh/,
  );

  // After "Lokasi Saya" the same derivation must produce the device caption —
  // no path can leave a Riyadh caption above Dammam results.
  const cleared = clearCitySearch();
  const after = resolveActiveCenter({ searchCenter: cleared.center, viewerPosition: DAMMAM });
  assert.equal(after.mode, "device_location");
  assert.equal(
    describeRadiusOrigin({ radiusLabel: "1 km", mode: after.mode, placeName: cleared.placeName }),
    "Menampilkan tempat dalam radius 1 km dari lokasi Anda",
  );
});

test("R-A: the removed caption left no resolved-name state behind", () => {
  // 2026-10-18: the caption that named the resolved city was removed with the
  // "Tempat Pilihan" board, so the client no longer keeps or renders a place
  // name at all — there is nothing left that could name a city the search did
  // not resolve.
  assert.doesNotMatch(discoveryCode, /displayName\?: string;/);
  assert.doesNotMatch(discoveryCode, /setSearchPlaceName|searchPlaceName/);
  // The status dot in the search-status line must still be a plain dot.
  assert.doesNotMatch(discoveryCode, /placeName: searchQuery/);

  // Every reset path still clears the CENTER the caption used to travel with.
  const resets = discoveryCode.match(/setSearchCenter\(cleared\.center\);/g) ?? [];
  assert.ok(resets.length >= 3, `all reset paths must clear the center, found ${resets.length}`);
});

test("R-A: no caption remains that could misname an origin", () => {
  // The bug in one assertion: a fixed "dari lokasi Anda" in the JSX. The whole
  // caption was removed on 2026-10-18 (together with the information board),
  // so neither the hardcoded text nor a derived origin/scope line can return.
  assert.doesNotMatch(discoveryCode, /dari lokasi Anda/);
  assert.doesNotMatch(discoveryCode, /\$\{nearOrigin\} · \$\{coverageScope\}/);
  assert.doesNotMatch(discoveryCode, /const coverageScope = describeCoverageScope\(\{/);
  assert.doesNotMatch(discoveryCode, /describeNearOrigin\(/);
  assert.doesNotMatch(discoveryCode, /hasActiveCenter/);
  // 2026-10-18: the result strips are a 2-column grid on a vertical scroll,
  // not horizontal carousels.
  assert.match(discoveryCode, /grid grid-cols-2 items-stretch gap-x-3 gap-y-4/);
  assert.doesNotMatch(discoveryCode, /snap-x snap-mandatory/);
});

// ---------------------------------------------------------------------------
// Requirement B — a compact map empty state
// ---------------------------------------------------------------------------

test("R-B: the empty state is content-sized, not a full-width panel", () => {
  // Centered flex line, and a card that hugs its own content and caps out.
  assert.match(
    discoveryCode,
    /absolute inset-x-0 bottom-32 z-\[1100\] flex justify-center px-4/,
    "overlay must be a centered line, not a full-width panel",
  );
  assert.match(discoveryCode, /w-fit max-w-\[min\(20rem,100%\)\]/);
  // Reduced padding and text scale versus the old panel.
  assert.doesNotMatch(discoveryCode, /absolute inset-x-6 bottom-32/);
  assert.match(discoveryCode, /rounded-\[14px\] bg-white\/95 px-3 py-1\.5/);
  assert.match(discoveryCode, /text-\[11px\] font-semibold leading-4/);
  assert.match(discoveryCode, /text-\[10px\] leading-3\.5/);
});

test("R-B: the empty state is still an honest, readable empty state", () => {
  // Requirement: never remove the empty state or make it misleading. Both
  // copy variants and the gesture hint survive verbatim.
  assert.match(discoveryCode, /Belum ada Tempat Pilihan di sekitar area ini/);
  assert.match(discoveryCode, /Belum ada Tempat Terdaftar di sekitar area ini/);
  assert.match(discoveryCode, /Geser peta dengan dua jari untuk melihat area lain\./);
  // The visibility rule itself is untouched: it still keys off the dataset and
  // the real viewport report, not on styling.
  assert.match(
    discoveryCode,
    /const mapEmptyStateVisible =\n\s*mapPlaces\.length === 0 \|\| \(viewportReported && !viewportHasPlaces\);/,
  );
});

test("R-B: the overlay stays clear of the coverage box and the Leaflet controls", () => {
  // Still strictly above the Leaflet z-index ceiling, and above the coverage
  // box (bottom-9) so the two never stack on top of each other.
  //
  // 2026-10-04: raised from bottom-24 to bottom-32. The floating RESULTS card
  // now occupies the map's bottom-left corner and its height is not fixed — a
  // long search query wraps the panel title to a second line. At bottom-24 the
  // empty state and that card could touch on a no-results search, since both
  // are centered and overlap horizontally. bottom-32 clears a two-line title.
  assert.match(discoveryCode, /bottom-32 z-\[1100\]/);
  // The redundant floating coverage box is gone: its information is now on the
  // consolidated panel line, so nothing floats over the map's bottom-left.
  assert.doesNotMatch(discoveryCode, /bottom-9 left-4 z-\[1100\]/);
  // Click-through: the overlay can never swallow a pan or a pinch.
  assert.match(discoveryCode, /pointer-events-none absolute inset-x-0 bottom-32/);
});

// ---------------------------------------------------------------------------
// Requirement C — only ONE filter control per function
// ---------------------------------------------------------------------------

test("R-C: the duplicate map-area filter chip is gone", () => {
  // The removed element was a status/filter chip floating over the map that
  // repeated the filter bar's own "Tempat Pilihan" / radius / LIVE state.
  assert.doesNotMatch(discoveryCode, /top-\[152px\]/);
  assert.doesNotMatch(discoveryCode, /absolute left-4 top-\[\d+px\] z-\[1100\] rounded-full bg-brand-primary/);
});

test("R-C: one control per filter — LIVE stays in the bar, curated renders once below the map", () => {
  // 2026-10-18: the curated tab MOVED to the results transition band. It was
  // not duplicated: LIVE stays in the top bar, the curated control exists once
  // in the whole component, and both keep their own handlers/state.
  const bar = discoveryCode.slice(
    discoveryCode.indexOf("pointer-events-auto mt-2.5 grid"),
    discoveryCode.indexOf("DISTANCE_FILTERS.map"),
  );
  assert.ok(bar.length > 0, "the main filter bar must still exist");
  assert.match(bar, /toggleLiveFilter\(liveOnly, curatedOnly\)/);
  assert.match(bar, /aria-pressed=\{liveOnly\}/);
  assert.doesNotMatch(bar, /activateCuratedFilter\(\)/);

  // Exactly ONE curated control in the whole Home surface, and it lives in the
  // results sheet (after the map stage's closing tag).
  assert.equal((discoveryCode.match(/aria-pressed=\{curatedOnly\}/g) ?? []).length, 1);
  assert.equal((discoveryCode.match(/activateCuratedFilter\(\)/g) ?? []).length, 1);
  assert.ok(
    discoveryCode.indexOf("activateCuratedFilter()") > discoveryCode.indexOf("rounded-t-[24px] bg-brand-cream"),
    "the curated tab lives in the results band, not the top filter row",
  );
  assert.equal(DISTANCE_FILTERS.length, 3);
  assert.deepEqual(DISTANCE_FILTERS, ["1 km", "5 km", "10 km+"]);
});

test("R-C: the single filter bar stays one row with no mobile wrapping", () => {
  // Four controls in one grid row (LIVE + three radius tabs): no wrap, no
  // second row, no horizontal overflow at the smallest supported viewport.
  assert.match(
    discoveryCode,
    /pointer-events-auto mt-2\.5 grid w-full min-w-0 grid-cols-\[auto_repeat\(3,minmax\(0,1fr\)\)\] gap-1\.5/,
  );
  // Every control in the bar is nowrap, so no control can wrap or clip on a
  // narrow phone.
  const bar = discoveryCode.slice(
    discoveryCode.indexOf("pointer-events-auto mt-2.5 grid"),
    discoveryCode.indexOf("{/* MAP AREA"),
  );
  assert.ok(bar.length > 0, "the filter bar region must exist");
  // One literal LIVE control plus the shared class inside the radius mapper.
  assert.equal((bar.match(/whitespace-nowrap/g) ?? []).length, 2);
  assert.match(bar, /grid w-full min-w-0 grid-cols-\[auto_repeat\(3,minmax\(0,1fr\)\)\] gap-1\.5/);
  assert.doesNotMatch(bar, /data-home-tab=/);
  assert.equal((bar.match(/<button/g) ?? []).length, 2, "one literal button plus the one distance-tab mapper");
  assert.equal(bar.includes("overflow-x-auto"), false, "no horizontal scroller anywhere in the bar");
  // The moved curated control is a single tab in the results sheet, and it is
  // also nowrap so it cannot wrap on a 360px screen where it now lives.
  const tabStart = discoveryCode.indexOf("aria-pressed={curatedOnly}");
  assert.match(discoveryCode.slice(tabStart, tabStart + 700), /whitespace-nowrap/);
});
