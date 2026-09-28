"use client";

import { PLACE_COUNTRIES, placeRegionsFor } from "@/lib/geo/countries";

/**
 * Negara + Provinsi / Wilayah — the two dependent geography selects, shared by
 * the Admin Place editor (create and edit) and the Producer Place form so both
 * offer exactly the same list.
 *
 * The labels are deliberately neutral: the same subdivision is a province in
 * one country, a state in another, a region in a third, and a wilayah in
 * Indonesia, so "Provinsi / Wilayah" is the only wording that is never wrong.
 * `places.area` is untouched and still carries the local area.
 *
 * Choosing a country REPLACES the region, because a subdivision only means
 * something inside its own country and keeping the old one would produce a
 * pair the server rejects.
 *
 * The selects are a convenience, not the authority: the server re-validates
 * both values against the same dataset on every create and update.
 */
type Props = {
  countryCode: string;
  regionName: string;
  onChange: (patch: { countryCode?: string; regionName?: string }) => void;
};

const FIELD_CLASS = "rounded-lg border border-black/10 px-3 py-2 text-sm font-normal";

export default function PlaceGeoFields({ countryCode, regionName, onChange }: Props) {
  const regions = placeRegionsFor(countryCode);

  return (
    // minmax(0,1fr) instead of an implicit auto track: a wide select option
    // (a long country/region name) must widen the ITEM, never the track —
    // otherwise one option pushes the whole form past the phone frame.
    // Desktop is unchanged: sm:grid-cols-2 keeps its two columns.
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
      <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm font-semibold">
        Negara
        <select
          className={FIELD_CLASS}
          required
          value={countryCode}
          onChange={(event) => {
            const next = event.target.value;
            const nextRegions = placeRegionsFor(next);
            onChange({ countryCode: next, regionName: nextRegions[0] ?? "" });
          }}
        >
          <option value="">Pilih negara</option>
          {PLACE_COUNTRIES.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1 text-sm font-semibold">
        Provinsi / Wilayah
        <select
          className={FIELD_CLASS}
          required
          disabled={regions.length === 0}
          value={regionName}
          onChange={(event) => onChange({ regionName: event.target.value })}
        >
          <option value="">{countryCode ? "Pilih provinsi / wilayah" : "Pilih negara dulu"}</option>
          {regions.map((region) => (
            <option key={region} value={region}>
              {region}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
