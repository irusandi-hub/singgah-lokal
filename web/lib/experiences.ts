import type { Place } from "@/lib/places";

export type ExperienceStatus = "draft" | "published" | "paused" | "archived";
export type PublicationStatus = "draft" | "published";

export type ExperienceSchedule = {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  timezone: string;
  status: "available" | "not_available" | "requires_confirmation";
};

export type Experience = {
  id: string;
  placeId: string;
  title: string;
  shortDescription: string;
  description: string;
  durationMinutes: number;
  capacity: number | null;
  minPartySize: number;
  maxPartySize: number;
  ageRequirement: string | null;
  prerequisites: string[];
  meetingPoint: string;
  highlights: string[];
  status: ExperienceStatus;
  publicationStatus: PublicationStatus;
  schedules: ExperienceSchedule[];
};

const experienceIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

export const experiences: Experience[] = [
  {
    id: "kunjungan-pengenalan-rumah-teh",
    placeId: "rumah-teh-lokal",
    title: "Kunjungan pengenalan Rumah Teh Lokal",
    shortDescription: "Kenali pengalaman yang tersedia di Rumah Teh Lokal sebelum menentukan niat berkunjung.",
    description:
      "Halaman pengenalan ini membantu calon pengunjung memahami bentuk kunjungan di Place ini. Detail operasional dan ketersediaan perlu dikonfirmasi kepada Producer.",
    durationMinutes: 60,
    capacity: null,
    minPartySize: 1,
    maxPartySize: 6,
    ageRequirement: null,
    prerequisites: [],
    meetingPoint: "Konfirmasi titik temu kepada Producer sebelum berkunjung.",
    highlights: ["Memahami alur kunjungan", "Menentukan waktu yang ingin diajukan", "Meneruskan niat berkunjung ke Producer"],
    status: "published",
    publicationStatus: "published",
    schedules: [
      {
        dayOfWeek: "Sunday",
        startTime: "09:00",
        endTime: "15:00",
        timezone: "Asia/Jakarta",
        status: "requires_confirmation",
      },
    ],
  },
];

function isValidTime(time: string): boolean {
  return timePattern.test(time);
}

export function validateExperience(experience: Experience, place: Place): void {
  if (!experienceIdPattern.test(experience.id)) {
    throw new Error(`Invalid Experience id: ${experience.id}`);
  }

  if (experience.placeId !== place.id) {
    throw new Error(`Experience ${experience.id} does not belong to Place ${place.id}`);
  }

  if (!experience.title.trim() || !experience.shortDescription.trim() || !experience.description.trim()) {
    throw new Error(`Experience ${experience.id} is missing required content`);
  }

  if (!Number.isInteger(experience.durationMinutes) || experience.durationMinutes <= 0) {
    throw new Error(`Invalid duration for Experience ${experience.id}`);
  }

  if (experience.capacity !== null && (!Number.isInteger(experience.capacity) || experience.capacity <= 0)) {
    throw new Error(`Invalid capacity for Experience ${experience.id}`);
  }

  if (
    !Number.isInteger(experience.minPartySize) ||
    !Number.isInteger(experience.maxPartySize) ||
    experience.minPartySize < 1 ||
    experience.minPartySize > experience.maxPartySize
  ) {
    throw new Error(`Invalid party size for Experience ${experience.id}`);
  }

  for (const schedule of experience.schedules) {
    if (
      schedule.timezone !== place.timezone ||
      !isValidTime(schedule.startTime) ||
      !isValidTime(schedule.endTime) ||
      schedule.startTime >= schedule.endTime
    ) {
      throw new Error(`Invalid schedule for Experience ${experience.id}`);
    }
  }
}

export function validateExperiences(experienceList: readonly Experience[], placeList: readonly Place[]): void {
  const ids = new Set<string>();

  for (const experience of experienceList) {
    const place = placeList.find((candidate) => candidate.id === experience.placeId);

    if (!place) {
      throw new Error(`Experience ${experience.id} references an unknown Place`);
    }

    validateExperience(experience, place);

    if (ids.has(experience.id)) {
      throw new Error(`Duplicate Experience id: ${experience.id}`);
    }

    ids.add(experience.id);
  }
}

export function getExperienceById(id: string): Experience | undefined {
  return experiences.find((experience) => experience.id === id);
}

export function getExperiencesForPlace(placeId: string): Experience[] {
  return experiences.filter(
    (experience) => experience.placeId === placeId && experience.status === "published" && experience.publicationStatus === "published",
  );
}