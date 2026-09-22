// Client-side visited-link bookkeeping. Persists in the user's browser
// localStorage only — never sent to the server, never stored as profile data.
const STORAGE_KEY = "singgah_visited_links";
const MAX_ENTRIES = 500;

function readVisited(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

function writeVisited(entries: Set<string>): void {
  try {
    const trimmed = [...entries].slice(-MAX_ENTRIES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage unavailable (private mode, quota) — visited tracking is
    // best-effort decoration and must never break navigation.
  }
}

// Canonicalizes any pathname to the list page whose link it marks: only
// top-level Place, Experience, and Live routes are tracked.
export function toVisitedKey(pathname: string): string | null {
  const clean = pathname.split(/[?#]/)[0] ?? "";
  const place = clean.match(/^\/places\/[^/]+$/);
  if (place) return clean;
  const experience = clean.match(/^\/places\/[^/]+\/experiences\/[^/]+$/);
  if (experience) return clean;
  const live = clean.match(/^\/live\/[^/]+$/);
  if (live) return clean;
  return null;
}

export function markVisited(pathname: string): void {
  const key = toVisitedKey(pathname);
  if (!key) return;
  const visited = readVisited();
  if (visited.has(key)) return;
  visited.add(key);
  writeVisited(visited);
}

// Optional detail argument: marking is tied to the exact entity URL/id, so
// opening Place A never marks Place B (keys are compared per pathname).
export function markVisitedExact(pathname: string, detail: string): void {
  const key = toVisitedKey(pathname);
  if (!key) return;
  const normalizedDetail = toVisitedKey(detail) ?? detail.split(/[?#]/)[0] ?? detail;
  if (key !== normalizedDetail) return;
  const visited = readVisited();
  if (visited.has(key)) return;
  visited.add(key);
  writeVisited(visited);
}

export function isVisited(pathname: string): boolean {
  const key = toVisitedKey(pathname);
  if (!key) return false;
  return readVisited().has(key);
}
