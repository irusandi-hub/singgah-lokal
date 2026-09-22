"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { isVisited, markVisited } from "@/lib/visited-links";

type VisitedLinkProps = Omit<React.ComponentProps<typeof Link>, "className" | "onClick"> & {
  className?: string;
  visitedClassName?: string;
};

// Wraps Next Link with a browser-local visited state: after the user actually
// opens the destination, the link renders with visitedClassName (subtle by
// design — never disabled-looking). State persists via localStorage across
// refreshes and is distinct from the URL-derived active tab state.
export default function VisitedLink({ className = "", visitedClassName = "", children, ...rest }: VisitedLinkProps) {
  const href = typeof rest.href === "string" ? rest.href : String(rest.href);
  const [visited, setVisited] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      if (!cancelled) setVisited(isVisited(href));
    };
    // Deferred microtask read avoids cascading renders during the effect;
    // the mark-event listener keeps the state fresh on the same page.
    queueMicrotask(refresh);
    window.addEventListener("singgah:visited-marked", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("singgah:visited-marked", refresh);
    };
  }, [href]);

  return (
    <Link
      {...rest}
      className={`${className} ${visited ? visitedClassName : ""}`}
      onClick={() => markVisited(href)}
    >
      {children}
    </Link>
  );
}
