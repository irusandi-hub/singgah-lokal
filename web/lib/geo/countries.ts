import dataset from "country-region-data/data.json";

/**
 * PLACE GEOGRAPHY — the canonical country / subdivision vocabulary (PO,
 * 2026-09-28).
 *
 * Source: `country-region-data` (MIT), built on ISO 3166-1 (countries) and
 * ISO 3166-2 (subdivisions). It is the maintained option — the
 * `country-city-state` package that mirrors countrycitystatejson ships a
 * truncated tarball (4 countries) and is unusable, and `world-countries` v5
 * carries no subdivision list at all. The chosen package was last published
 * 2026-02-06.
 *
 * WHAT IS STORED, EXACTLY:
 * - `places.country_code`  = the ISO 3166-1 alpha-2 code, uppercase ("ID").
 * - `places.region_name`  = the ISO 3166-2 subdivision name, verbatim
 *   ("Jawa Barat", "Ash Sharqiyah"). Names are stored exactly as the dataset
 *   spells them so the value is reproducible from the dataset alone — no
 *   second naming table to drift.
 *
 * The UI labels are neutral ("Negara", "Provinsi / Wilayah") because the
 * same subdivision is a province, a state, a region, or a wilayah depending
 * on the country; the neutral word is the only term that is never wrong.
 *
 * This module is PURE and client-safe on purpose: the same list validates a
 * request on the server AND fills the two dependent dropdowns in the Admin
 * and Producer Place forms, so the two can never disagree about what is
 * selectable. `places.area` is untouched and remains the free local-area
 * field it always was.
 */

type DatasetRegion = { name: string; shortCode: string };
type DatasetCountry = { countryName: string; countryShortCode: string; regions: DatasetRegion[] };

const DATA = dataset as DatasetCountry[];

export type PlaceCountry = { code: string; name: string };

/** Every country in the world, alphabetically by its English name. */
export const PLACE_COUNTRIES: readonly PlaceCountry[] = DATA.map((country) => ({
  code: country.countryShortCode,
  name: country.countryName,
})).sort((a, b) => a.name.localeCompare(b.name, "en"));

const REGIONS_BY_COUNTRY = new Map<string, string[]>(
  DATA.map((country) => [
    country.countryShortCode,
    country.regions.map((region) => region.name).sort((a, b) => a.localeCompare(b, "en")),
  ]),
);

/**
 * The subdivisions of one country, alphabetically. An unknown or empty
 * country code yields an empty list rather than a throw: a select with no
 * options is the correct read-only answer for "no country chosen yet".
 */
export function placeRegionsFor(countryCode: string | null | undefined): string[] {
  if (!countryCode) return [];
  return REGIONS_BY_COUNTRY.get(countryCode.trim().toUpperCase()) ?? [];
}

/** The country's display name, or null when the code is not in the dataset. */
export function placeCountryName(countryCode: string | null | undefined): string | null {
  if (!countryCode) return null;
  const code = countryCode.trim().toUpperCase();
  return PLACE_COUNTRIES.find((country) => country.code === code)?.name ?? null;
}

/**
 * Server-side validation of the country + region pair (AGENTS.md: "Validate
 * inputs server-side"). The region is only ever accepted as a subdivision of
 * the country that was sent with it, so a region can never be paired with the
 * wrong country — in the form, in a direct API call, or in a crafted payload.
 */
export function isValidPlaceCountry(countryCode: unknown): countryCode is string {
  return typeof countryCode === "string" && REGIONS_BY_COUNTRY.has(countryCode.trim().toUpperCase());
}

export function isValidPlaceRegion(countryCode: string, regionName: unknown): regionName is string {
  if (typeof regionName !== "string") return false;
  return placeRegionsFor(countryCode).includes(regionName.trim());
}
