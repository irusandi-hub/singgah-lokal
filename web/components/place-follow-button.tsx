"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { requestFollowPlace, requestUnfollowPlace } from "@/lib/place-follows-client";

/**
 * Follow control for the Place Card (task foundation for MASTER 10
 * notifications). State comes from the database via /api/place-follows —
 * never invented client-side:
 * - signed-out (401) → renders "Follow" that routes to /auth?returnTo=/,
 *   no follow request is ever sent;
 * - signed-in → "Follow" ⇄ "Following" against the server's canonical rows;
 * - unknown/loading → plain "Follow" disabled until state resolves
 *   (fail-closed, no optimistic state flip).
 *
 * Navigation/design scope lock: the card's link, layout, and LIVE/Direction
 * controls are untouched — this adds one compact meta-row control only.
 */
const FOLLOW_ICON = (
  <svg aria-hidden viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
    <path d="M6.5 4.5h11a1 1 0 0 1 1 1v14l-6.5-4-6.5 4v-14a1 1 0 0 1 1-1Z" strokeLinejoin="round" />
  </svg>
);

/**
 * Follow control for the Place Card (task foundation for MASTER 10
 * notifications). State comes from the database via /api/place-follows —
 * never invented client-side:
 * - signed-out (401) → renders "Follow" that routes to /auth?returnTo=/,
 *   no follow request is ever sent;
 * - signed-in → "Follow" ⇄ "Following" against the server's canonical rows;
 * - unknown/loading → plain "Follow" disabled until state resolves
 *   (fail-closed, no optimistic state flip).
 *
 * `iconOnly` (2026-10-18) renders the same control as the compact 40×40
 * outline icon button the 2-column card's action row needs: bookmark outline
 * by default, filled green once followed. The accessible name always spells
 * out the state, and the text variant is unchanged for any other caller.
 *
 * Navigation/design scope lock: the card's link, layout, and Direction/LIVE
 * controls are untouched — this adds one compact meta-row control only.
 */
export default function PlaceFollowButton({
  placeId,
  iconOnly = false,
}: {
  placeId: string;
  iconOnly?: boolean;
}) {
  const [sessionState, setSessionState] = useState<"unknown" | "out" | "in">("unknown");
  const [followed, setFollowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const baseClass = iconOnly
    ? "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border transition disabled:opacity-60"
    : "inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-[11px] font-bold transition disabled:opacity-60";

  // Resolve the signed-in user's follow state once from the server. A 401
  // means signed-out; the list endpoint returns the user's own follow rows
  // only (RLS), so nothing about other users' follows can leak in here.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/place-follows", { cache: "no-store" })
      .then((response) => {
        if (cancelled) return null;
        if (response.status === 401) {
          setSessionState("out");
          return null;
        }
        if (!response.ok) throw new Error("Follow state unavailable");
        return response.json() as Promise<{ followedPlaceIds?: string[] }>;
      })
      .then((payload) => {
        if (cancelled || !payload) return;
        setSessionState("in");
        setFollowed((payload.followedPlaceIds ?? []).includes(placeId));
      })
      .catch(() => {
        if (!cancelled) setSessionState("out");
      });
    return () => {
      cancelled = true;
    };
  }, [placeId]);

  if (sessionState === "unknown") {
    return (
      <button
        type="button"
        disabled
        className={`${baseClass} cursor-default border-black/10 text-black/35`}
        aria-label={`Status Follow ${placeId}`}
      >
        {FOLLOW_ICON}
        {!iconOnly && "Follow"}
      </button>
    );
  }

  if (sessionState === "out") {
    // Signed-out: no follow request is ever created; direct the user to the
    // existing auth flow and preserve the intended destination.
    return (
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          router.push("/auth?returnTo=/");
        }}
        className={`${baseClass} border-brand-primary/40 text-brand-primary hover:bg-brand-primary/10`}
        aria-label={`Masuk untuk mengikuti ${placeId}`}
      >
        {FOLLOW_ICON}
        {!iconOnly && "Follow"}
      </button>
    );
  }

  async function toggleFollow() {
    if (busy) return;
    setBusy(true);
    try {
      const result = followed ? await requestUnfollowPlace(placeId) : await requestFollowPlace(placeId);
      // State flips only on server confirmation — never optimistically.
      if (result) setFollowed(result.followed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void toggleFollow();
      }}
      disabled={busy}
      aria-pressed={followed}
      className={`${baseClass} ${
        followed
          ? "border-brand-primary bg-brand-primary text-white"
          : "border-brand-primary/40 text-brand-primary hover:bg-brand-primary/10"
      }`}
      aria-label={followed ? `Berhenti mengikuti ${placeId}` : `Ikuti ${placeId}`}
    >
      {FOLLOW_ICON}
      {!iconOnly && (followed ? "Following" : "Follow")}
    </button>
  );
}
