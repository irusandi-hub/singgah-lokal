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
export default function PlaceFollowButton({ placeId }: { placeId: string }) {
  const [sessionState, setSessionState] = useState<"unknown" | "out" | "in">("unknown");
  const [followed, setFollowed] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

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
        className="inline-flex shrink-0 cursor-default items-center gap-1 rounded-full border border-black/10 px-3 py-1.5 text-[11px] font-bold text-black/40"
        aria-label={`Status Follow ${placeId}`}
      >
        Follow
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
        className="inline-flex shrink-0 items-center gap-1 rounded-full border border-brand-primary/40 px-3 py-1.5 text-[11px] font-bold text-brand-primary transition hover:bg-brand-primary/10"
        aria-label={`Masuk untuk mengikuti ${placeId}`}
      >
        Follow
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
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-[11px] font-bold transition disabled:opacity-60 ${
        followed
          ? "border-brand-primary bg-brand-primary text-white"
          : "border-brand-primary/40 text-brand-primary hover:bg-brand-primary/10"
      }`}
      aria-label={followed ? `Berhenti mengikuti ${placeId}` : `Ikuti ${placeId}`}
    >
      {followed ? "Following" : "Follow"}
    </button>
  );
}
