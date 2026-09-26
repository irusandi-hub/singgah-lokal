/**
 * Browser-side helper for the Place Follow API (/api/place-follows).
 * Thin fetch wrapper only — authorization stays server-side; the client
 * never supplies a user identity, only the Place it wants to follow.
 */

export type FollowActionResult = {
  followed: boolean;
  outcome: "created" | "exists" | "unfollowed" | "not_followed";
};

export async function fetchFollowedPlaceIds(): Promise<string[] | null> {
  try {
    const response = await fetch("/api/place-follows", { cache: "no-store" });
    if (!response.ok) return null;
    const payload = (await response.json()) as { followedPlaceIds?: unknown };
    return Array.isArray(payload.followedPlaceIds) ? payload.followedPlaceIds.map(String) : null;
  } catch {
    return null;
  }
}

export async function requestFollowPlace(placeId: string): Promise<FollowActionResult | null> {
  try {
    const response = await fetch("/api/place-follows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ placeId }),
    });
    if (!response.ok) return null;
    return (await response.json()) as FollowActionResult;
  } catch {
    return null;
  }
}

export async function requestUnfollowPlace(placeId: string): Promise<FollowActionResult | null> {
  try {
    const response = await fetch("/api/place-follows", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ placeId }),
    });
    if (!response.ok) return null;
    return (await response.json()) as FollowActionResult;
  } catch {
    return null;
  }
}
