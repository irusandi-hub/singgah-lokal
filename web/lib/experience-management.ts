import {
  experienceDays,
  experienceScheduleStatuses,
  experienceStatuses,
  type Experience,
  type ExperienceSchedule,
  isExperiencePublicationReady,
  validateExperience,
} from "@/lib/experiences";
import type { Place } from "@/lib/places";
import type { ExperienceMutation } from "@/lib/place-experience-repository";

export class ExperienceInputError extends Error {}

function text(body: Record<string, unknown>, key: string, required = true): string {
  const value = body[key];
  if (!required && (value === null || value === undefined)) return "";
  if (typeof value !== "string" || (required && !value.trim())) throw new ExperienceInputError("experience_required_field_invalid");
  return value.trim();
}

function integer(body: Record<string, unknown>, key: string, nullable = false): number | null {
  const value = body[key];
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new ExperienceInputError("experience_number_invalid");
  return value;
}

export function parseExperienceMutation(raw: unknown, place: Place, id?: string): ExperienceMutation {
  if (!raw || typeof raw !== "object") throw new ExperienceInputError("experience_input_invalid");
  const body = raw as Record<string, unknown>;
  if ("placeId" in body) throw new ExperienceInputError("place_id_not_allowed");
  const rawSchedules = body.schedules;
  if (!Array.isArray(rawSchedules)) throw new ExperienceInputError("experience_schedule_invalid");
  const schedules: ExperienceSchedule[] = rawSchedules.map((rawSchedule) => {
    if (!rawSchedule || typeof rawSchedule !== "object") throw new ExperienceInputError("experience_schedule_invalid");
    const schedule = rawSchedule as Record<string, unknown>;
    const dayOfWeek = text(schedule, "dayOfWeek");
    const startTime = text(schedule, "startTime");
    const endTime = text(schedule, "endTime");
    const timezone = text(schedule, "timezone");
    const status = text(schedule, "status") as ExperienceSchedule["status"];
    if (!experienceDays.includes(dayOfWeek as typeof experienceDays[number]) || !experienceScheduleStatuses.includes(status) || timezone !== place.timezone) {
      throw new ExperienceInputError("experience_schedule_invalid");
    }
    return { dayOfWeek, startTime, endTime, timezone, status };
  });
  const mutation: ExperienceMutation = {
    id: id ?? text(body, "id"),
    title: text(body, "title"),
    shortDescription: text(body, "shortDescription"),
    description: text(body, "description"),
    durationMinutes: integer(body, "durationMinutes") as number,
    capacity: integer(body, "capacity", true),
    minPartySize: integer(body, "minPartySize") as number,
    maxPartySize: integer(body, "maxPartySize") as number,
    ageRequirement: text(body, "ageRequirement", false) || null,
    prerequisites: parseTextList(body.prerequisites),
    meetingPoint: text(body, "meetingPoint"),
    highlights: parseTextList(body.highlights),
    schedules,
  };
  const candidate: Experience = { ...mutation, placeId: place.id, status: "draft", publicationStatus: "draft" };
  try {
    validateExperience(candidate, place);
  } catch {
    throw new ExperienceInputError("experience_input_invalid");
  }
  return mutation;
}

function parseTextList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new ExperienceInputError("experience_list_invalid");
  return value.map((item) => (item as string).trim());
}

export function validateExperiencePublication(experience: Experience): void {
  if (!isExperiencePublicationReady(experience)) throw new ExperienceInputError("experience_publication_not_ready");
}

export function parseExperienceStatus(raw: unknown): Experience["status"] {
  if (typeof raw !== "string" || !experienceStatuses.includes(raw as Experience["status"])) throw new ExperienceInputError("experience_status_invalid");
  return raw as Experience["status"];
}