import HomeDiscovery from "@/components/home-discovery";
import { loadDiscoveryViewModel } from "@/lib/discovery/home-service";
import { getPublicPlaceExperienceRepository } from "@/lib/place-experience-repository";

// The Home shell must render per request: the header's session state
// (account menu vs Daftar/Masuk) comes from the live session probe. As a
// statically prerendered shell it was served with a year-long s-maxage, so a
// logged-in account could still see "Daftar" after login + refresh (the
// stale shell — never the auth flow itself — was the bug). The route segment
// config only takes effect in a server file, so the client UI lives in
// components/home-discovery.tsx and this server wrapper forces dynamic
// rendering.
export const dynamic = "force-dynamic";

export default async function Home() {
  // Performance (PO 2026-09-26): public discovery data (sessionless client,
  // published-only RLS) is prefetched server-side so Places render on the
  // first paint — the client no longer pays a post-hydration /api/places
  // roundtrip. The sessionless client never touches cookies(), so the auth
  // shell stays fully dynamic and correct.
  //
  // Stage 3: the Discovery view model (canonical engine output — stars +
  // rank only, numeric score never leaves the server) is built on the same
  // server pass. The client NEVER recomputes it (no second scoring path).
  const [initialPlaces, discovery] = await Promise.all([
    getPublicPlaceExperienceRepository().then((repository) => repository.listPublishedPlaces()),
    loadDiscoveryViewModel(),
  ]);
  return <HomeDiscovery initialPlaces={initialPlaces} discovery={discovery} />;
}
