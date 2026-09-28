import type { ExperienceStatus, ExperienceSchedule } from "./experiences";
import type { PublicationStatus } from "./places";
import type { ProductionStageStatus } from "./production-story";
import type { VisitIntentStatus } from "./visit-intents";

/**
 * USER-FACING ENUM LABELS.
 *
 * The database stores every lifecycle state as a technical English enum
 * ("published", "requires_confirmation", ...). Those values are correct in
 * code and in the API, but showing them raw in the Producer UI reads like a
 * system term, so each surface renders the label from here instead.
 *
 * This module is PRESENTATION ONLY: the stored values, the API payloads and
 * every comparison stay exactly as they are. "Dashboard", "Live", "Draft" and
 * "Status" are common product words and stay untranslated, and so do the
 * system/data terms a Producer types on purpose (Timezone, Currency, ID).
 */

const PUBLICATION_STATUS_LABEL: Record<PublicationStatus, string> = {
  draft: "Draft",
  published: "Tayang",
  paused: "Jeda",
  archived: "Diarsipkan",
};

const EXPERIENCE_STATUS_LABEL: Record<ExperienceStatus, string> = {
  draft: "Draft",
  published: "Tayang",
  paused: "Jeda",
  archived: "Diarsipkan",
};

const EXPERIENCE_SCHEDULE_STATUS_LABEL: Record<ExperienceSchedule["status"], string> = {
  available: "Tersedia",
  not_available: "Tidak tersedia",
  requires_confirmation: "Perlu konfirmasi",
};

const PRODUCTION_STAGE_STATUS_LABEL: Record<ProductionStageStatus, string> = {
  draft: "Draft",
  review: "Ditinjau",
  published: "Tayang",
  paused: "Jeda",
  archived: "Diarsipkan",
};

const VISIT_INTENT_STATUS_LABEL: Record<VisitIntentStatus, string> = {
  pending: "Menunggu",
  accepted: "Diterima",
  declined: "Ditolak",
  requires_confirmation: "Perlu konfirmasi",
  cancelled: "Dibatalkan",
  expired: "Kedaluwarsa",
};

/** The weekday enum stays English on the wire; the UI shows Indonesian. */
const WEEKDAY_LABEL: Record<string, string> = {
  Monday: "Senin",
  Tuesday: "Selasa",
  Wednesday: "Rabu",
  Thursday: "Kamis",
  Friday: "Jumat",
  Saturday: "Sabtu",
  Sunday: "Minggu",
};

export function publicationStatusLabel(status: PublicationStatus): string {
  return PUBLICATION_STATUS_LABEL[status] ?? status;
}

export function experienceStatusLabel(status: ExperienceStatus): string {
  return EXPERIENCE_STATUS_LABEL[status] ?? status;
}

export function experienceScheduleStatusLabel(status: ExperienceSchedule["status"]): string {
  return EXPERIENCE_SCHEDULE_STATUS_LABEL[status] ?? status;
}

export function productionStageStatusLabel(status: ProductionStageStatus): string {
  return PRODUCTION_STAGE_STATUS_LABEL[status] ?? status;
}

export function visitIntentStatusLabel(status: VisitIntentStatus): string {
  return VISIT_INTENT_STATUS_LABEL[status] ?? status;
}

export function weekdayLabel(day: string): string {
  return WEEKDAY_LABEL[day] ?? day;
}

const PLACE_TYPE_LABEL: Record<string, string> = {
  production: "Produksi",
  experience: "Kegiatan",
};

/** A Place type is a stored enum too, and the claim surface shows it raw. */
export function placeTypeLabel(type: string): string {
  return PLACE_TYPE_LABEL[type] ?? type;
}
