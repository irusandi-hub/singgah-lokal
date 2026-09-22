"use client";

import { useEffect } from "react";

// Marks the current detail route as visited in the user's browser
// (localStorage). Rendered once on the mounted detail page itself, so the
// visited state records pages actually opened — never clicks that failed.
// Purely cosmetic browser-side state; nothing is sent to the server and the
// canonical database is untouched.
export default function MarkVisited() {
  useEffect(() => {
    import("@/lib/visited-links").then(({ markVisited }) => {
      markVisited(window.location.pathname);
      // Let any VisitedLink instances on this page re-read visited state.
      window.dispatchEvent(new Event("singgah:visited-marked"));
    });
  }, []);

  return null;
}
