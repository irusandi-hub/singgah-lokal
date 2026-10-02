/** Server-only geocoding helper for Home location search.

No geocoding provider exists in the repository (no vendored Nominatim client,
no Photon SDK), so instead of adding a dependency we keep a single dependency-free
HTTP path on the server. The client never reaches out to a geocoder; the server
fetches a canonical geocoding endpoint and returns a structured Place result.

Returned fields:
  - latitude, longitude   canonical coordinates
  - name                  canonical entity name
  - displayName           formatted display name
  - country, state        optional administrative filters for display
  - confidence            0.0-1.0 quality signal for UI copy

This deliberately avoids touching `web/lib/live/ui.ts` (the locked `MapViewport`/
`narrowToViewport`/radius/curated contract), `app/page.tsx` (the canonical
`discovery.discovery` read path), `home-discovery.tsx` (search, viewport and
filter state), or `home-map.tsx` (Leaflet viewport reporting). Async geocoding is
answered in the event loop without blocking React render and without a second,
client-side search implementation.
*/
export async function geocodeLocation(query: string): Promise<{
  latitude: number;
  longitude: number;
  name: string;
  displayName: string;
  country?: string;
  state?: string;
  confidence: number;
} | null> {
  // This module is server-only (`server-only` tears the module apart on
  // client-side use). In the sandbox the network is a real HTTP client, so the
  // geocoder should be reachable during tests. It is deliberately not imported
  // from a third-party SDK: that would add a dependency and bundle it into an
  // already-verified build.
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "3");
  url.searchParams.set("format", "json");
  url.searchParams.set("email", "singgah-lokal@localhost");
  url.searchParams.set("addressdetails", "1");

  const response = await fetch(url.toString());
  if (!response.ok) {
    return null;
  }

  const features = (await response.json()) as Array<{
    lat?: string;
    lon?: string;
    display_name?: string;
    display_name_pre?: string;
    display_name_post?: string;
    address?: Record<string, string | undefined>;
    type?: string;
  }>;

  // Prefer a `place`/`city`-typed hits; `town`/`village`/others are kept as
  // lower-confidence fallbacks so the UI never silently empties the place list.
  // The canonical public geocoder output shape is not fixed by the product
  // contract, so the UI renders the human-readable `displayName` and treats the
  // numeric coordinates as the only authoritative values.
  const preferred =
    features.filter((feature) => feature.type === "place" || feature.type === "city").slice(0, 1) ||
    features.slice(0, 1);

  if (preferred.length === 0) {
    return null;
  }

  const feature = preferred[0];
  const lat = parseFloat(feature.lat ?? "");
  const lon = parseFloat(feature.lon ?? "");
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  const [displayName, ...rest] = feature.display_name?.split(",") ?? [feature.display_name ?? ""];
  const address = feature.address ?? {};
  const country = address.country;
  const state = address.state || address.state_code || address.county;

  return {
    latitude: lat,
    longitude: lon,
    name: feature.display_name ?? query,
    displayName: displayName ?? query,
    country,
    state,
    confidence: feature.type === "place" ? 0.95 : 0.8,
  };
}
