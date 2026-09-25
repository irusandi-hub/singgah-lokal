import HomeDiscovery from "@/components/home-discovery";

// The Home shell must render per request: the header's session state
// (account menu vs Daftar/Masuk) comes from the live session probe. As a
// statically prerendered shell it was served with a year-long s-maxage, so a
// logged-in account could still see "Daftar" after login + refresh (the
// stale shell — never the auth flow itself — was the bug). The route segment
// config only takes effect in a server file, so the client UI lives in
// components/home-discovery.tsx and this server wrapper forces dynamic
// rendering.
export const dynamic = "force-dynamic";

export default function Home() {
  return <HomeDiscovery />;
}
