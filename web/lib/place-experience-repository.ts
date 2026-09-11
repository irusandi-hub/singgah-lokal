import type { SupabaseClient } from "@supabase/supabase-js";
import { experiences, type Experience, type ExperienceSchedule, validateExperience } from "@/lib/experiences";
import { places, type Place, validatePlace } from "@/lib/places";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type PlaceExperienceRepository = {
  listPublishedPlaces(): Promise<Place[]>;
  getPublishedPlaceById(id: string): Promise<Place | undefined>;
  listPublishedExperiencesForPlace(placeId: string): Promise<Experience[]>;
  getPublishedExperienceById(id: string): Promise<Experience | undefined>;
};

function mapPlace(row: Record<string, unknown>): Place {
  const place: Place = {
    id: String(row.id),
    name: String(row.name),
    shortDescription: String(row.short_description),
    category: row.category as Place["category"],
    type: row.type as Place["type"],
    area: String(row.area),
    timezone: String(row.timezone),
    currency: String(row.currency),
    latitude: row.latitude as number | null,
    longitude: row.longitude as number | null,
    producer: row.producer_id
      ? { id: String(row.producer_id), displayName: String(row.producer_display_name ?? row.producer_id) }
      : null,
    claimStatus: row.claim_status as Place["claimStatus"],
    publicationStatus: row.publication_status as Place["publicationStatus"],
    address: String(row.address ?? ""),
    contactInformation: String(row.contact_information ?? ""),
  };
  validatePlace(place);
  return place;
}

function mapExperience(row: Record<string, unknown>, scheduleRows: Record<string, unknown>[], place: Place): Experience {
  const experience: Experience = {
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
  validateExperience(experience, place);
  return experience;
}

export class InMemoryPlaceExperienceRepository implements PlaceExperienceRepository {
  async listPublishedPlaces(): Promise<Place[]> {
    return places.filter((place) => {
      validatePlace(place);
      return place.publicationStatus === "published";
    });
  }

  async getPublishedPlaceById(id: string): Promise<Place | undefined> {
    const place = places.find((candidate) => candidate.id === id);
    if (place) validatePlace(place);
    return place?.publicationStatus === "published" ? place : undefined;
  }

  async listPublishedExperiencesForPlace(placeId: string): Promise<Experience[]> {
    const place = await this.getPublishedPlaceById(placeId);
    if (!place) return [];

    return experiences.filter((experience) => {
      if (experience.placeId !== placeId || experience.status !== "published" || experience.publicationStatus !== "published") {
        return false;
      }
      validateExperience(experience, place);
      return true;
    });
  }

  async getPublishedExperienceById(id: string): Promise<Experience | undefined> {
    const experience = experiences.find(
      (candidate) => candidate.id === id && candidate.status === "published" && candidate.publicationStatus === "published",
    );
    if (!experience) return undefined;

    const place = await this.getPublishedPlaceById(experience.placeId);
    if (!place) return undefined;
    validateExperience(experience, place);
    return experience;
  }
}

export class SupabasePlaceExperienceRepository implements PlaceExperienceRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listPublishedPlaces(): Promise<Place[]> {
    const { data, error } = await this.client
      .from("places")
      .select("*, producers(display_name)")
      .eq("publication_status", "published")
      .order("id");
    if (error) throw error;
    return (data ?? []).map((row) => mapPlace({ ...row, producer_display_name: row.producers?.display_name }));
  }

  async getPublishedPlaceById(id: string): Promise<Place | undefined> {
    const { data, error } = await this.client
      .from("places")
      .select("*, producers(display_name)")
      .eq("id", id)
      .eq("publication_status", "published")
      .maybeSingle();
    if (error) throw error;
    return data ? mapPlace({ ...data, producer_display_name: data.producers?.display_name }) : undefined;
  }

  async listPublishedExperiencesForPlace(placeId: string): Promise<Experience[]> {
    const place = await this.getPublishedPlaceById(placeId);
    if (!place) return [];

    const { data, error } = await this.client
      .from("experiences")
      .select("*")
      .eq("place_id", placeId)
      .eq("status", "published")
      .eq("publication_status", "published")
      .order("id");
    if (error) throw error;

    return Promise.all((data ?? []).map(async (row) => mapExperience(row, await this.getSchedules(String(row.id)), place)));
  }

  async getPublishedExperienceById(id: string): Promise<Experience | undefined> {
    const { data, error } = await this.client
      .from("experiences")
      .select("*")
      .eq("id", id)
      .eq("status", "published")
      .eq("publication_status", "published")
      .maybeSingle();
    if (error) throw error;
    if (!data) return undefined;

    const place = await this.getPublishedPlaceById(String(data.place_id));
    if (!place) return undefined;
    return mapExperience(data, await this.getSchedules(id), place);
  }

  private async getSchedules(experienceId: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.client
      .from("experience_schedules")
      .select("*")
      .eq("experience_id", experienceId)
      .order("id");
    if (error) throw error;
    return data ?? [];
  }
}

export type PlaceMutation = Pick<Place, "id" | "name" | "shortDescription" | "category" | "type" | "area" | "address" | "contactInformation" | "timezone" | "currency" | "latitude" | "longitude">;

export type ExperienceMutation = Omit<Experience, "placeId" | "status" | "publicationStatus">;

export class SupabasePlaceManagementRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listForProducer(producerId: string): Promise<Place[]> {
    const { data, error } = await this.client.from("places").select("*, producers(display_name)").eq("producer_id", producerId).order("id");
    if (error) throw error;
    return (data ?? []).map((row) => mapPlace({ ...row, producer_display_name: row.producers?.display_name }));
  }

  async listForUser(userId: string): Promise<Place[]> {
    const { data, error } = await this.client.from("producer_memberships").select("place_id").eq("user_id", userId).in("role", ["owner", "manager", "editor"]);
    if (error) throw error;
    const result = await Promise.all((data ?? []).map(({ place_id }) => this.getById(String(place_id))));
    return result.filter((place): place is Place => Boolean(place));
  }

  async getById(id: string): Promise<Place | undefined> {
    const { data, error } = await this.client.from("places").select("*, producers(display_name)").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? mapPlace({ ...data, producer_display_name: data.producers?.display_name }) : undefined;
  }

  async create(input: PlaceMutation, producerId: string): Promise<Place> {
    const { data, error } = await this.client.from("places").insert({
      id: input.id, name: input.name, short_description: input.shortDescription, category: input.category,
      type: input.type, area: input.area, address: input.address, contact_information: input.contactInformation,
      timezone: input.timezone, currency: input.currency, latitude: input.latitude, longitude: input.longitude,
      producer_id: producerId, publication_status: "draft",
    }).select("*, producers(display_name)").single();
    if (error) throw error;
    return mapPlace({ ...data, producer_display_name: data.producers?.display_name });
  }

  async update(id: string, input: Omit<PlaceMutation, "id">): Promise<Place> {
    const { data, error } = await this.client.from("places").update({
      name: input.name, short_description: input.shortDescription, category: input.category, type: input.type,
      area: input.area, address: input.address, contact_information: input.contactInformation,
      timezone: input.timezone, currency: input.currency, latitude: input.latitude, longitude: input.longitude,
      updated_at: new Date().toISOString(),
    }).eq("id", id).select("*, producers(display_name)").single();
    if (error) throw error;
    return mapPlace({ ...data, producer_display_name: data.producers?.display_name });
  }

  async updatePublicationStatus(id: string, publicationStatus: Place["publicationStatus"]): Promise<Place> {
    const { data, error } = await this.client.from("places").update({ publication_status: publicationStatus, updated_at: new Date().toISOString() }).eq("id", id).select("*, producers(display_name)").single();
    if (error) throw error;
    return mapPlace({ ...data, producer_display_name: data.producers?.display_name });
  }
}

export class SupabaseExperienceManagementRepository {
  constructor(private readonly client: SupabaseClient) {}

  async listForPlace(placeId: string): Promise<Experience[]> {
    const place = await this.getPlace(placeId);
    if (!place) return [];
    const { data, error } = await this.client.from("experiences").select("*").eq("place_id", placeId).order("id");
    if (error) throw error;
    return Promise.all((data ?? []).map(async (row) => mapExperience(row, await this.getSchedules(String(row.id)), place)));
  }

  async getById(id: string): Promise<Experience | undefined> {
    const { data, error } = await this.client.from("experiences").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    const place = await this.getPlace(String(data.place_id));
    if (!place) return undefined;
    return mapExperience(data, await this.getSchedules(id), place);
  }

  async create(input: ExperienceMutation, placeId: string): Promise<Experience> {
    const { data, error } = await this.client.from("experiences").insert({
      id: input.id, place_id: placeId, title: input.title, short_description: input.shortDescription,
      description: input.description, duration_minutes: input.durationMinutes, capacity: input.capacity,
      min_party_size: input.minPartySize, max_party_size: input.maxPartySize, age_requirement: input.ageRequirement,
      prerequisites: input.prerequisites, meeting_point: input.meetingPoint, highlights: input.highlights,
      status: "draft", publication_status: "draft",
    }).select("*").single();
    if (error) throw error;
    await this.replaceSchedules(input.id, input.schedules);
    const result = await this.getById(String(data.id));
    if (!result) throw new Error("Experience could not be loaded after creation");
    return result;
  }

  async update(id: string, input: ExperienceMutation, updateSchedules = true): Promise<Experience> {
    const { error } = await this.client.from("experiences").update({
      title: input.title, short_description: input.shortDescription, description: input.description,
      duration_minutes: input.durationMinutes, capacity: input.capacity, min_party_size: input.minPartySize,
      max_party_size: input.maxPartySize, age_requirement: input.ageRequirement, prerequisites: input.prerequisites,
      meeting_point: input.meetingPoint, highlights: input.highlights, updated_at: new Date().toISOString(),
    }).eq("id", id);
    if (error) throw error;
    if (updateSchedules) await this.replaceSchedules(id, input.schedules);
    const result = await this.getById(id);
    if (!result) throw new Error("Experience could not be loaded after update");
    return result;
  }

  async updateStatus(id: string, placeId: string, status: Experience["status"], publicationStatus: Experience["publicationStatus"]): Promise<Experience> {
    const { error } = await this.client.from("experiences").update({ status, publication_status: publicationStatus, updated_at: new Date().toISOString() }).eq("id", id).eq("place_id", placeId);
    if (error) throw error;
    const result = await this.getById(id);
    if (!result) throw new Error("Experience could not be loaded after status update");
    return result;
  }

  private async getPlace(placeId: string): Promise<Place | undefined> {
    const { data, error } = await this.client.from("places").select("*, producers(display_name)").eq("id", placeId).maybeSingle();
    if (error) throw error;
    return data ? mapPlace({ ...data, producer_display_name: data.producers?.display_name }) : undefined;
  }

  private async getSchedules(experienceId: string): Promise<Record<string, unknown>[]> {
    const { data, error } = await this.client.from("experience_schedules").select("*").eq("experience_id", experienceId).order("id");
    if (error) throw error;
    return data ?? [];
  }

  private async replaceSchedules(experienceId: string, schedules: readonly ExperienceSchedule[]): Promise<void> {
    const { error: deleteError } = await this.client.from("experience_schedules").delete().eq("experience_id", experienceId);
    if (deleteError) throw deleteError;
    if (schedules.length === 0) return;
    const { error } = await this.client.from("experience_schedules").insert(schedules.map((schedule) => ({
      experience_id: experienceId, day_of_week: schedule.dayOfWeek, start_time: schedule.startTime,
      end_time: schedule.endTime, timezone: schedule.timezone, status: schedule.status,
    })));
    if (error) throw error;
  }
}

export async function getServerPlaceExperienceRepository(): Promise<PlaceExperienceRepository> {
  return new SupabasePlaceExperienceRepository(await createSupabaseServerClient());
}

export async function getServerPlaceManagementRepository(): Promise<SupabasePlaceManagementRepository> {
  return new SupabasePlaceManagementRepository(await createSupabaseServerClient());
}

export async function getServerExperienceManagementRepository(): Promise<SupabaseExperienceManagementRepository> {
  return new SupabaseExperienceManagementRepository(await createSupabaseServerClient());
}
