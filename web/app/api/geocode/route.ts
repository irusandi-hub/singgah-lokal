import { NextResponse } from "next/server";
import {
  MAX_GEOCODE_QUERY_LENGTH,
  geocodeLocation,
  normalizeGeocodeQuery,
} from "@/lib/live/photon";

/**
 * Home location search — the ONLY path from the browser to the geocoder.
 *
 * The client sends the typed text here and receives one canonical coordinate
 * pair; it never learns the provider endpoint (that lives behind the
 * server-only `geocodeLocation`) and never performs its own geocoding. Input
 * is validated here on the server before any outbound request, exactly as
 * AGENTS.md requires — a bad query is a 400, not a provider call.
 *
 * Unauthenticated by design: the Home discovery shell is public, and this route
 * reads no Place, Producer, Discovery, or user data — it resolves a string to
 * coordinates only.
 */

export async function GET(request: Request) {
  const query = normalizeGeocodeQuery(new URL(request.url).searchParams.get("q"));
  if (!query) {
    return NextResponse.json(
      { error: "location_query_invalid", maxLength: MAX_GEOCODE_QUERY_LENGTH },
      { status: 400 },
    );
  }

  // geocodeLocation returns null for an unreachable provider, a non-2xx answer,
  // no usable hit, or non-finite coordinates. All of those are one honest
  // client-visible outcome: "no center" — never a guessed position.
  const result = await geocodeLocation(query);
  if (!result) {
    return NextResponse.json({ error: "location_not_resolved" }, { status: 404 });
  }

  return NextResponse.json(result, {
    headers: {
      // Short shared cache only: repeated identical searches are cheap, but a
      // center is never stale for long.
      "Cache-Control": "public, max-age=60",
    },
  });
}