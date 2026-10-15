import type { Experience } from "@/lib/experiences";
import type { Place } from "@/lib/places";
import type { VisitIntent, VisitIntentStatus } from "@/lib/visit-intents";

export type ProducerRole = "owner" | "manager" | "editor";

/**
 * Locked Indonesian label per Producer membership role
 * (docs/UI_TERMINOLOGY_STANDARD.md §2 — "Pengelola" is the Producer management
 * role term and is never translated or reinvented). Used by Admin surfaces and
 * notification copy; the stored value stays the canonical `owner|manager|editor`.
 */
export const PRODUCER_ROLE_LABEL: Record<ProducerRole, string> = {
  owner: "Pemilik",
  manager: "Pengelola",
  editor: "Editor",
};

export function producerRoleLabel(role: string | null | undefined): string {
  if (role === "owner" || role === "manager" || role === "editor") {
    return PRODUCER_ROLE_LABEL[role];
  }
  return role ?? "—";
}

export type ProducerAccess = {
  producerId: string;
  role: ProducerRole;
  placeId?: string;
};

export function canEditPlace(role: ProducerRole): boolean {
  return ["owner", "manager", "editor"].includes(role);
}

export function canPublishPlace(role: ProducerRole): boolean {
  return role === "owner" || role === "manager";
}

export function canPublishExperience(
  access: ProducerAccess | null | undefined,
  placeId: string,
  experiencePlaceId: string,
  placeProducerId: string | undefined,
): boolean {
  return Boolean(
    access &&
      canPublishPlace(access.role) &&
      access.placeId === placeId &&
      experiencePlaceId === placeId &&
      placeProducerId &&
      access.producerId === placeProducerId,
  );
}

export type ProducerVisitIntent = {
  intent: VisitIntent;
  place: Place;
  experience: Experience | null;
};

export function canManagePlace(place: Place, access: ProducerAccess): boolean {
  // Management authority is MEMBERSHIP-scoped: the access must have been
  // resolved from a membership and must carry that membership's placeId, and
  // it must be THIS Place. `places.producer_id` deliberately carries NO
  // management authority — a revoked membership does not clear it, so
  // authorizing on it would let an account whose access was revoked keep
  // managing the Place. This is firewall-consistent with every RLS policy and
  // every server gate (which all key on `producer_memberships.place_id`); see
  // docs/audits/ADMIN_PLACE_DETAIL_REVOKE_AUDIT.md (§6, G-AUTH-1).
  if (!access.producerId.trim() || access.role === "editor") {
    return false;
  }

  return access.placeId === place.id;
}

export function getProducerPlaces(places: readonly Place[], access: ProducerAccess): Place[] {
  return places.filter((place) => canManagePlace(place, access));
}

export function getProducerVisitIntents(
  intents: readonly VisitIntent[],
  places: readonly Place[],
  experiences: readonly Experience[],
  access: ProducerAccess,
): ProducerVisitIntent[] {
  const authorizedPlaceIds = new Set(getProducerPlaces(places, access).map((place) => place.id));

  return intents.flatMap((intent) => {
    if (!authorizedPlaceIds.has(intent.placeId)) {
      return [];
    }

    const place = places.find((candidate) => candidate.id === intent.placeId);
    if (!place) {
      return [];
    }

    const experience = experiences.find((candidate) => candidate.id === intent.experienceId && candidate.placeId === place.id);
    if (!experience) {
      return [];
    }

    return [{
      intent,
      place,
      experience,
    }];
  });
}

export function canRespondToVisitIntent(status: VisitIntentStatus, nextStatus: VisitIntentStatus): boolean {
  if (status === "pending" || status === "requires_confirmation") {
    return nextStatus === "accepted" || nextStatus === "declined" || nextStatus === "requires_confirmation";
  }

  return false;
}