export type NavSection = "home" | "live" | "producer" | "visit-intents";

// Order matters: the most specific section wins. Home is the fallback so any
// other route (Places, Experience, auth) keeps the Home tab active.
const sectionMatchers: ReadonlyArray<{
  section: NavSection;
  matches: (pathname: string) => boolean;
}> = [
  { section: "producer", matches: (p) => p === "/producer" || p.startsWith("/producer/") },
  { section: "visit-intents", matches: (p) => p === "/visit-intents" || p.startsWith("/visit-intents/") },
  { section: "live", matches: (p) => p === "/live" || p.startsWith("/live/") },
];

export function normalizeNavPathname(pathname: string): string {
  const withoutQueryOrHash = pathname.split(/[?#]/)[0] ?? "";
  return withoutQueryOrHash === "" ? "/" : withoutQueryOrHash;
}

export function getActiveNavSection(pathname: string): NavSection {
  const clean = normalizeNavPathname(pathname);
  for (const { section, matches } of sectionMatchers) {
    if (matches(clean)) return section;
  }
  return "home";
}

export function isActiveNavSection(pathname: string, section: NavSection): boolean {
  return getActiveNavSection(pathname) === section;
}
