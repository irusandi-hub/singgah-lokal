"use client";

import { useEffect } from "react";

// Marks THIS detail page as visited in the user's browser (localStorage).
// Rendered on the mounted detail page itself with the server-verified entity
// id, so the visited state records pages that were actually opened — not
// clicks that may have failed. The key is the exact entity URL/id, so opening
// Place A never marks Place B. Purely cosmetic browser-side state; nothing is
// sent to the server and the canonical database is untouched.
export default function MarkVisited({ path }: { path: string }) {
  useEffect(() => {
    const visitedPath = path;
    import("@/lib/visited-links").then(({ markVisitedExact }) => {
      markVisitedExact(window.location.pathname, visitedPath);
      // Let any VisitedLink instances on this page re-read visited state.
      window.dispatchEvent(new Event("singgah:visited-marked"));
    });
  }, [path]);

  return null;
}
