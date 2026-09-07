import type { Experience } from "@/lib/experiences";
import type { Place } from "@/lib/places";
import { canManagePlace, canRespondToVisitIntent, type ProducerAccess } from "@/lib/producer";

export type VisitIntentStatus = "pending" | "accepted" | "declined" | "requires_confirmation" | "cancelled" | "expired";

export type VisitIntentInput = {
  userId: string;
  placeId: string;
  experienceId: string;
  requestedDate: string;
  requestedStartTime: string;
  requestedEndTime: string;
  partySize: number;
  optionalNote?: string;
};

export type VisitIntent = VisitIntentInput & {
  id: string;
  timezone: string;
  status: VisitIntentStatus;
  producerResponseNote: string | null;
  createdAt: string;
  updatedAt: string;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

function getTimezoneParts(date: Date, timezone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
}

function validateRequestedDateTime(input: VisitIntentInput, place: Place, now: Date): void {
  if (!datePattern.test(input.requestedDate)) {
    throw new Error("Invalid requested date");
  }

  const [year, month, day] = input.requestedDate.split("-").map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    throw new Error("Invalid requested date");
  }

  if (!timePattern.test(input.requestedStartTime) || !timePattern.test(input.requestedEndTime)) {
    throw new Error("Invalid requested time");
  }

  if (input.requestedStartTime >= input.requestedEndTime) {
    throw new Error("Requested start time must be before requested end time");
  }

  const nowParts = getTimezoneParts(now, place.timezone);
  const today = `${nowParts.year}-${nowParts.month}-${nowParts.day}`;
  if (input.requestedDate < today || (input.requestedDate === today && input.requestedStartTime <= `${nowParts.hour}:${nowParts.minute}`)) {
    throw new Error("Requested time must be in the future");
  }
}

export function validateVisitIntent(input: VisitIntentInput, place: Place, experience: Experience, now = new Date()): void {
  if (!input.userId.trim()) {
    throw new Error("Authenticated user is required");
  }

  if (input.placeId !== place.id || input.experienceId !== experience.id || experience.placeId !== place.id) {
    throw new Error("Visit Intent Place and Experience relationship is invalid");
  }

  if (experience.status !== "published" || experience.publicationStatus !== "published") {
    throw new Error("Visit Intent requires a published Experience");
  }

  validateRequestedDateTime(input, place, now);

  if (!Number.isInteger(input.partySize) || input.partySize < experience.minPartySize || input.partySize > experience.maxPartySize) {
    throw new Error("Party size is outside the Experience limits");
  }

  if (experience.capacity !== null && input.partySize > experience.capacity) {
    throw new Error("Party size exceeds Experience capacity");
  }

  const fitsSchedule = experience.schedules.some(
    (schedule) =>
      schedule.timezone === place.timezone &&
      schedule.status !== "not_available" &&
      input.requestedStartTime >= schedule.startTime &&
      input.requestedEndTime <= schedule.endTime,
  );
  if (!fitsSchedule) {
    throw new Error("Requested time is outside the Experience schedule");
  }

  if (input.optionalNote && input.optionalNote.length > 500) {
    throw new Error("Optional note must be 500 characters or fewer");
  }
}

export function createVisitIntent(input: VisitIntentInput, place: Place, experience: Experience, now = new Date()): VisitIntent {
  validateVisitIntent(input, place, experience, now);
  const timestamp = now.toISOString();

  return {
    ...input,
    optionalNote: input.optionalNote?.trim() || undefined,
    id: `visit-intent-${globalThis.crypto.randomUUID()}`,
    timezone: place.timezone,
    status: "pending",
    producerResponseNote: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function respondToVisitIntent(
  intent: VisitIntent,
  place: Place,
  access: ProducerAccess,
  nextStatus: Extract<VisitIntentStatus, "accepted" | "declined" | "requires_confirmation">,
  producerResponseNote: string,
  now = new Date(),
): VisitIntent {
  if (!canManagePlace(place, access)) {
    throw new Error("Producer is not authorized to manage this Place");
  }

  if (!canRespondToVisitIntent(intent.status, nextStatus)) {
    throw new Error(`Cannot change Visit Intent from ${intent.status} to ${nextStatus}`);
  }

  if (producerResponseNote.length > 1000) {
    throw new Error("Producer response note must be 1000 characters or fewer");
  }

  return {
    ...intent,
    status: nextStatus,
    producerResponseNote: producerResponseNote.trim() || null,
    updatedAt: now.toISOString(),
  };
}