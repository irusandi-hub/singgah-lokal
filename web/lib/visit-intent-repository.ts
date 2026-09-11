import type { SupabaseClient } from "@supabase/supabase-js";
import { experiences, type Experience } from "@/lib/experiences";
import { places, type Place } from "@/lib/places";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { VisitIntent } from "@/lib/visit-intents";

export type VisitIntentRepository = {
  findById(id: string): Promise<VisitIntent | undefined>;
  findByIdempotencyKey(userId: string, key: string): Promise<VisitIntent | undefined>;
  findActiveDuplicate(userId: string, placeId: string, experienceId: string, requestedDate: string, startTime: string, endTime: string): Promise<VisitIntent | undefined>;
  insert(intent: VisitIntent, idempotencyKey: string): Promise<VisitIntent>;
  update(intent: VisitIntent): Promise<VisitIntent>;
  listForPlace(placeId: string): Promise<VisitIntent[]>;
  listForPlaces(placeIds: readonly string[], status?: VisitIntent["status"]): Promise<VisitIntent[]>;
  getPlaceById(id: string): Promise<Place | undefined>;
  getExperienceById(id: string): Promise<Experience | undefined>;
};

export class InMemoryVisitIntentRepository implements VisitIntentRepository {
  private readonly intents = new Map<string, VisitIntent>();
  private readonly idempotencyKeys = new Map<string, string>();

  async findById(id: string): Promise<VisitIntent | undefined> {
    return this.intents.get(id);
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<VisitIntent | undefined> {
    const intentId = this.idempotencyKeys.get(`${userId}:${key}`);
    return intentId ? this.intents.get(intentId) : undefined;
  }

  async findActiveDuplicate(userId: string, placeId: string, experienceId: string, requestedDate: string, startTime: string, endTime: string): Promise<VisitIntent | undefined> {
    return [...this.intents.values()].find(
      (intent) =>
        intent.userId === userId &&
        intent.placeId === placeId &&
        intent.experienceId === experienceId &&
        intent.requestedDate === requestedDate &&
        intent.requestedStartTime === startTime &&
        intent.requestedEndTime === endTime &&
        ["pending", "requires_confirmation", "accepted"].includes(intent.status),
    );
  }

  async insert(intent: VisitIntent, idempotencyKey: string): Promise<VisitIntent> {
    const key = `${intent.userId}:${idempotencyKey}`;
    const existingId = this.idempotencyKeys.get(key);
    if (existingId) {
      return this.intents.get(existingId) as VisitIntent;
    }

    this.intents.set(intent.id, intent);
    this.idempotencyKeys.set(key, intent.id);
    return intent;
  }

  async update(intent: VisitIntent): Promise<VisitIntent> {
    if (!this.intents.has(intent.id)) {
      throw new Error("Visit Intent was not found");
    }
    this.intents.set(intent.id, intent);
    return intent;
  }

  async listForPlace(placeId: string): Promise<VisitIntent[]> {
    return this.listForPlaces([placeId]);
  }

  async listForPlaces(placeIds: readonly string[], status?: VisitIntent["status"]): Promise<VisitIntent[]> {
    const authorizedPlaceIds = new Set(placeIds);
    return [...this.intents.values()].filter((intent) => authorizedPlaceIds.has(intent.placeId) && (!status || intent.status === status));
  }

  async listForUser(userId: string): Promise<VisitIntent[]> {
    return [...this.intents.values()].filter((intent) => intent.userId === userId);
  }

  async getPlaceById(id: string): Promise<Place | undefined> {
    return places.find((place) => place.id === id);
  }

  async getExperienceById(id: string): Promise<Experience | undefined> {
    return experiences.find((experience) => experience.id === id);
  }
}

function mapPlace(row: Record<string, unknown>): Place {
  return {
    id: String(row.id),
    name: String(row.name),
    shortDescription: String(row.short_description),
    category: row.category as Place["category"],
    type: row.type as Place["type"],
    area: String(row.area),
    address: String(row.address ?? ""),
    contactInformation: String(row.contact_information ?? ""),
    timezone: String(row.timezone),
    currency: String(row.currency),
    latitude: row.latitude as number | null,
    longitude: row.longitude as number | null,
    producer: row.producer_id ? { id: String(row.producer_id), displayName: String(row.producer_display_name ?? row.producer_id) } : null,
    claimStatus: row.claim_status as Place["claimStatus"],
    publicationStatus: row.publication_status as Place["publicationStatus"],
  };
}

function mapExperience(row: Record<string, unknown>, scheduleRows: Record<string, unknown>[]): Experience {
  return {
    id: String(row.id),
    placeId: String(row.place_id),
    title: String(row.title),
    shortDescription: String(row.short_description),
    description: String(row.description),
    durationMinutes: Number(row.duration_minutes),
    capacity: row.capacity as number | null,
    minPartySize: Number(row.min_party_size),
    maxPartySize: Number(row.max_party_size),
    ageRequirement: row.age_requirement as string | null,
    prerequisites: (row.prerequisites as string[]) ?? [],
    meetingPoint: String(row.meeting_point),
    highlights: (row.highlights as string[]) ?? [],
    status: row.status as Experience["status"],
    publicationStatus: row.publication_status as Experience["publicationStatus"],
    schedules: scheduleRows.map((schedule) => ({
      dayOfWeek: String(schedule.day_of_week),
      startTime: String(schedule.start_time).slice(0, 5),
      endTime: String(schedule.end_time).slice(0, 5),
      timezone: String(schedule.timezone),
      status: schedule.status as Experience["schedules"][number]["status"],
    })),
  };
}

function mapIntent(row: Record<string, unknown>): VisitIntent {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    placeId: String(row.place_id),
    experienceId: String(row.experience_id),
    requestedDate: String(row.requested_date),
    requestedStartTime: String(row.requested_start_time).slice(0, 5),
    requestedEndTime: String(row.requested_end_time).slice(0, 5),
    partySize: Number(row.party_size),
    optionalNote: row.optional_note as string | undefined,
    timezone: String(row.timezone),
    status: row.status as VisitIntent["status"],
    producerResponseNote: row.producer_response_note as string | null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SupabaseVisitIntentRepository implements VisitIntentRepository {
  constructor(private readonly client: SupabaseClient) {}

  async findById(id: string): Promise<VisitIntent | undefined> {
    const { data, error } = await this.client.from("visit_intents").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? mapIntent(data) : undefined;
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<VisitIntent | undefined> {
    const { data, error } = await this.client.from("visit_intents").select("*").eq("user_id", userId).eq("idempotency_key", key).maybeSingle();
    if (error) throw error;
    return data ? mapIntent(data) : undefined;
  }

  async findActiveDuplicate(userId: string, placeId: string, experienceId: string, requestedDate: string, startTime: string, endTime: string): Promise<VisitIntent | undefined> {
    const { data, error } = await this.client
      .from("visit_intents")
      .select("*")
      .eq("user_id", userId)
      .eq("place_id", placeId)
      .eq("experience_id", experienceId)
      .eq("requested_date", requestedDate)
      .eq("requested_start_time", startTime)
      .eq("requested_end_time", endTime)
      .in("status", ["pending", "requires_confirmation", "accepted"])
      .maybeSingle();
    if (error) throw error;
    return data ? mapIntent(data) : undefined;
  }

  async insert(intent: VisitIntent, idempotencyKey: string): Promise<VisitIntent> {
    const { data, error } = await this.client.from("visit_intents").insert({
      id: intent.id,
      user_id: intent.userId,
      place_id: intent.placeId,
      experience_id: intent.experienceId,
      requested_date: intent.requestedDate,
      requested_start_time: intent.requestedStartTime,
      requested_end_time: intent.requestedEndTime,
      party_size: intent.partySize,
      optional_note: intent.optionalNote,
      timezone: intent.timezone,
      idempotency_key: idempotencyKey,
    }).select("*").single();

    if (!error && data) return mapIntent(data);
    if (error?.code === "23505") {
      const replay = await this.findByIdempotencyKey(intent.userId, idempotencyKey);
      if (replay) return replay;
    }
    throw error ?? new Error("Visit Intent could not be persisted");
  }

  async update(intent: VisitIntent): Promise<VisitIntent> {
    const { data, error } = await this.client.from("visit_intents").update({
      status: intent.status,
      producer_response_note: intent.producerResponseNote,
      updated_at: intent.updatedAt,
    }).eq("id", intent.id).select("*").single();
    if (error) throw error;
    return mapIntent(data);
  }

  async listForPlace(placeId: string): Promise<VisitIntent[]> {
    return this.listForPlaces([placeId]);
  }

  async listForPlaces(placeIds: readonly string[], status?: VisitIntent["status"]): Promise<VisitIntent[]> {
    if (placeIds.length === 0) return [];
    let query = this.client.from("visit_intents").select("*").in("place_id", placeIds).order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []).map(mapIntent);
  }

  async getPlaceById(id: string): Promise<Place | undefined> {
    const { data, error } = await this.client.from("places").select("*, producers(display_name)").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    return mapPlace({ ...data, producer_display_name: data.producers?.display_name });
  }

  async getExperienceById(id: string): Promise<Experience | undefined> {
    const { data, error } = await this.client.from("experiences").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    const schedules = await this.client.from("experience_schedules").select("*").eq("experience_id", id);
    if (schedules.error) throw schedules.error;
    return mapExperience(data, schedules.data ?? []);
  }
}

let repository: VisitIntentRepository = new InMemoryVisitIntentRepository();

export function getVisitIntentRepository(): VisitIntentRepository {
  return repository;
}

export async function getServerVisitIntentRepository(): Promise<VisitIntentRepository> {
  const client = await createSupabaseServerClient();
  return new SupabaseVisitIntentRepository(client);
}

export function setVisitIntentRepository(nextRepository: VisitIntentRepository): void {
  repository = nextRepository;
}
