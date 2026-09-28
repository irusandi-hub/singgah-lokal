"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { PLACE_COUNTRIES, placeRegionsFor } from "@/lib/geo/countries";

/**
 * Country → Region filter for the Admin Place list (PO, 2026-09-28).
 *
 * Both values live in the URL, so the narrowing is shareable, survives a
 * refresh, and is applied by the server query against the database — the
 * select is not a client-side filter over an already-fetched page. Changing
 * the country clears the region, because a subdivision only means something
 * inside its own country.
 *
 * The neutral labels are intentional: the same subdivision is a province, a
 * state, a region, or a wilayah depending on the country.
 */
export default function PlaceGeoFilter() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const countryCode = searchParams.get("country") ?? "";
  const regionName = searchParams.get("region") ?? "";
  const regions = placeRegionsFor(countryCode);

  function apply(patch: { country?: string; region?: string }) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    router.push(`/admin/places${next.toString() ? `?${next.toString()}` : ""}`);
  }

  return (
    <section aria-label="Filter geografis" className="grid gap-2 sm:grid-cols-3">
      <label className="grid gap-1 text-sm font-semibold">
        Negara
        <select
          className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm font-normal"
          value={countryCode}
          onChange={(event) => apply({ country: event.target.value, region: "" })}
        >
          <option value="">Semua negara</option>
          {PLACE_COUNTRIES.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-semibold">
        Provinsi / Wilayah
        <select
          className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm font-normal"
          disabled={regions.length === 0}
          value={regionName}
          onChange={(event) => apply({ region: event.target.value })}
        >
          <option value="">{countryCode ? "Semua provinsi / wilayah" : "Pilih negara dulu"}</option>
          {regions.map((region) => (
            <option key={region} value={region}>
              {region}
            </option>
          ))}
        </select>
      </label>
      {countryCode || regionName ? (
        <button
          type="button"
          onClick={() => router.push("/admin/places")}
          className="self-end rounded-lg border border-black/10 px-4 py-2 text-sm font-bold text-black/60 transition hover:bg-black/5"
        >
          Reset filter
        </button>
      ) : null}
    </section>
  );
}
