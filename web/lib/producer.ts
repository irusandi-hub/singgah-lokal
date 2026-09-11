import type { Experience } from "@/lib/experiences";
import type { Place } from "@/lib/places";
import type { VisitIntent, VisitIntentStatus } from "@/lib/visit-intents";

export type ProducerRole = "owner" | "manager" | "editor";

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
  if (!access.producerId.trim() || access.role === "editor" || (access.placeId && access.placeId !== place.id)) {
    return false;
  }

  return access.placeId === place.id || place.producer?.id === access.producerId;
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