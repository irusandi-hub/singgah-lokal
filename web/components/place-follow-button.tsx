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
/**
 * ONE follow-state read per page load (2026-10-25, Home hydration budget).
 *
 * Every Place Card mounts this control, so a per-card fetch turned a 70-card
 * Home into 70 identical `/api/place-follows` requests, 70 JSON parses and 70
 * state commits during hydration — all competing with the map's first tile for
 * the same main thread. The snapshot below is resolved once and shared; the
 * request, its 401 semantics and the server-derived state are unchanged.
 *
 * A failed read is not cached, so the next mount retries exactly as before.
 */
type FollowSnapshot = {
  sessionState: "out" | "in";
  followedPlaceIds: Set<string>;
};

let followSnapshot: Promise<FollowSnapshot> | null = null;

function loadFollowSnapshot(): Promise<FollowSnapshot> {
  if (!followSnapshot) {
    followSnapshot = fetch("/api/place-follows", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401) {
          return { sessionState: "out" as const, followedPlaceIds: new Set<string>() };
        }
        if (!response.ok) throw new Error("Follow state unavailable");
        const payload = (await response.json()) as { followedPlaceIds?: string[] };
        return {
          sessionState: "in" as const,
          followedPlaceIds: new Set(payload.followedPlaceIds ?? []),
        };
      })
      .catch(() => {
        // Same fallback as a per-card failure (signed-out UI), but no caching:
        // the next mount asks the server again.
        followSnapshot = null;
        return { sessionState: "out" as const, followedPlaceIds: new Set<string>() };
      });
  }
  return followSnapshot;
}

/** Keep the shared snapshot truthful after a confirmed follow/unfollow. */
function rememberFollow(placeId: string, followed: boolean): void {
  void followSnapshot?.then((snapshot) => {
    if (followed) snapshot.followedPlaceIds.add(placeId);
    else snapshot.followedPlaceIds.delete(placeId);
  });
}

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
  // Every Follow state is a real tappable control: `touch-manipulation` removes
  // the double-tap delay and the shared press feedback lands under 100ms.
  const baseClass = iconOnly
    ? "inline-flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-[12px] border transition duration-100 active:scale-95 disabled:opacity-60"
    : "inline-flex shrink-0 touch-manipulation items-center gap-1 rounded-full border px-3 py-1.5 text-[11px] font-bold transition duration-100 active:scale-95 disabled:opacity-60";

  // Resolve the signed-in user's follow state once from the server — shared by
  // every card on the page. A 401 means signed-out; the list endpoint returns
  // the user's own follow rows only (RLS), so nothing about other users'
  // follows can leak in here.
  useEffect(() => {
    let cancelled = false;
    loadFollowSnapshot().then((snapshot) => {
      if (cancelled) return;
      setSessionState(snapshot.sessionState);
      setFollowed(
        snapshot.sessionState === "in" && snapshot.followedPlaceIds.has(placeId),
      );
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
      if (result) {
        setFollowed(result.followed);
        rememberFollow(placeId, result.followed);
      }
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
