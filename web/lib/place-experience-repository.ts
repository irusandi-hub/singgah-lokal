import type { SupabaseClient } from "@supabase/supabase-js";
import type { DiscoveryPlaceInput } from "@/lib/discovery/scoring";
import { experiences, type Experience, type ExperienceSchedule, validateExperience } from "@/lib/experiences";
import { places, type Place, validatePlace } from "@/lib/places";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getPublicSupabaseClient } from "@/lib/supabase/public-client";

/** Discovery signal assembly reads the locked engine's own input types. */
export type { DiscoveryPlaceInput };

export type PlaceExperienceRepository = {
  listPublishedPlaces(): Promise<Place[]>;
  getPublishedPlaceById(id: string): Promise<Place | undefined>;
  listPublishedExperiencesForPlace(placeId: string): Promise<Experience[]>;
  getPublishedExperienceById(id: string): Promise<Experience | undefined>;
  /**
   * Ids of PUBLISHED Places carrying the Tempat Pilihan flag (migration
   * 0035). The ONLY curated read path; Discovery never consumes it.
   */
  listCuratedPublishedPlaceIds(): Promise<Set<string>>;
  /**
   * Canonical signal assembly for the Discovery engine (contract v1.0 §1):
   * published Places with their canonical live/follow/visit/experience/media
   * signals. Server-side (service role) because the engagement aggregates
   * live behind self-only RLS.
   */
  listDiscoveryInputs(now: Date): Promise<DiscoveryPlaceInput[]>;
};

function mapPlace(row: Record<string, unknown>): Place {
  const place: Place = {
    id: String(row.id),
    name: String(row.name),
    shortDescription: String(row.short_description),
    category: row.category as Place["category"],
    type: row.type as Place["type"],
    area: String(row.area),
    countryCode: (row.country_code as string | null | undefined) ?? null,
    regionName: (row.region_name as string | null | undefined) ?? null,
    timezone: String(row.timezone),
    currency: String(row.currency),
    latitude: row.latitude as number | null,
    longitude: row.longitude as number | null,
    coverImageUrl: (row.cover_image_url as string | null | undefined) ?? null,
    producer: row.producer_id
      ? { id: String(row.producer_id), displayName: String(row.producer_display_name ?? row.producer_id) }
      : null,
    claimStatus: row.claim_status as Place["claimStatus"],
    publicationStatus: row.publication_status as Place["publicationStatus"],
    isCurated: row.is_curated === true,
    address: String(row.address ?? ""),
    contactInformation: String(row.contact_information ?? ""),
  };
  validatePlace(place);
  return place;
}

/**
 * Canonical signal counts for ONE Place (contract §1) — pure assembly, no
 * scoring. Missing/optional signals stay zero, never crash.
 */
function toDiscoveryInput(
  place: Place,
  signals: {
    live: { status: string; started_at: string | null } | null;
    followers: number;
    visitIntents: number;
    publishedExperiences: number;
    photos: number;
  },
): DiscoveryPlaceInput {
  const liveStatus = signals.live?.status;
  const live: DiscoveryPlaceInput["signals"]["live"] =
    liveStatus === "live" || liveStatus === "scheduled"
      ? { status: liveStatus, startedAt: signals.live?.started_at ?? null }
      : signals.live?.started_at
        ? { status: "ended", startedAt: signals.live.started_at }
        : null;
  return {
    place: {
      id: place.id,
      name: place.name,
      shortDescription: place.shortDescription,
      area: place.area,
      address: place.address,
      latitude: place.latitude,
      longitude: place.longitude,
      claimStatus: place.claimStatus,
      publicationStatus: place.publicationStatus,
    },
    signals: {
      live,
      engagement: {
        followers: Number.isFinite(signals.followers) ? signals.followers : 0,
        visitIntents: Number.isFinite(signals.visitIntents) ? signals.visitIntents : 0,
        publishedExperiences: Number.isFinite(signals.publishedExperiences) ? signals.publishedExperiences : 0,
        hasCoverImage: place.coverImageUrl !== null,
        photoCount: Number.isFinite(signals.photos) ? signals.photos : 0,
      },
    },
  };
}

/**
 * One row of the 0038 aggregate RPC (`list_discovery_signal_aggregates`):
 * the canonical per-Place discovery signals in a single server round trip.
 * Carries NO identity data — place id, counts, and the live fact only.
 */
type DiscoverySignalAggregateRow = {
  place_id: string;
  live_status: string | null;
  live_started_at: string | null;
  followers: number;
  visit_intents: number;
  published_experiences: number;
  photos: number;
};

/** Canonical live-session fact for one Place, read with the service role. */
async function fetchLiveSignal(
  admin: SupabaseClient,
  placeId: string,
): Promise<{ status: string; started_at: string | null } | null> {
  const { data, error } = await admin
    .from("live_sessions")
    .select("status, started_at")
    .eq("place_id", placeId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data ? { status: String(data.status), started_at: data.started_at as string | null } : null;
}

async function countRows(admin: SupabaseClient, table: string, placeId: string): Promise<{ count: number | null; error: boolean }> {
  const { count, error } = await admin
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq("place_id", placeId);
  if (error) return { count: null, error: true };
  return { count, error: false };
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

  async listCuratedPublishedPlaceIds(): Promise<Set<string>> {
    return new Set(
      places
        .filter((place) => place.publicationStatus === "published" && place.isCurated)
        .map((place) => place.id),
    );
  }

  async listDiscoveryInputs(now: Date): Promise<DiscoveryPlaceInput[]> {
    void now;
    const published = places.filter((place) => place.publicationStatus === "published");
    return published.map((place) =>
      toDiscoveryInput(place, {
        live: null,
        followers: 0,
        visitIntents: 0,
        publishedExperiences: experiences.filter(
          (experience) =>
            experience.placeId === place.id &&
            experience.status === "published" &&
            experience.publicationStatus === "published",
        ).length,
        photos: 0,
      }),
    );
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

  async listCuratedPublishedPlaceIds(): Promise<Set<string>> {
    // Public (anon) read — the flag is visible with the Place row itself
    // (published Places are public; the flag is layer metadata, not a secret).
    const { data, error } = await this.client
      .from("places")
      .select("id")
      .eq("publication_status", "published")
      .eq("is_curated", true);
    if (error) {
      // Before migration 0035 lands on an environment the column does not
      // exist; degrade to the locked PRE-0035 layer semantics (the UI's
      // empty-set fallback shows the full published set) instead of breaking
      // Home. Logged server-side — never silently swallowed.
      console.error("listCuratedPublishedPlaceIds failed:", error.message);
      return new Set();
    }
    return new Set((data ?? []).map((row) => String(row.id)));
  }

  async listDiscoveryInputs(now: Date): Promise<DiscoveryPlaceInput[]> {
    // Engagement aggregates (place_follows 0023, visit_intents 0001) sit
    // behind self-only RLS, so signal assembly uses the service role
    // (same pattern as the create() ownership grant). The returned inputs
    // carry no identity data — only published Places and their counts.
    const { createSupabaseServiceClient } = await import("@/lib/supabase/admin");
    const admin = createSupabaseServiceClient();

    const { data: placeRows, error: placesError } = await admin
      .from("places")
      .select("*, producers(display_name)")
      .eq("publication_status", "published")
      .order("id");
    if (placesError) throw placesError;

    const places = placeRows ?? [];
    if (places.length === 0) return [];

    // ONE aggregate round trip for ALL published Places (migration 0038)
    // instead of five queries per Place (the ~321-round-trip N+1 on the
    // 64-Place DEV dataset). The RPC is locked to the same canonical signals
    // the per-Place queries computed, so scoring stays bit-identical; the
    // per-Place path below stays as the fail-closed fallback whenever the
    // RPC is missing (pre-0038 environment) or errors — same numbers either
    // way. Logged server-side, never silently swallowed.
    const { data: aggregates, error: aggregateError } = await admin.rpc(
      "list_discovery_signal_aggregates",
    );
    if (aggregateError) {
      console.error("list_discovery_signal_aggregates failed:", aggregateError.message);
    }

    const signalsByPlaceId = new Map<string, DiscoverySignalAggregateRow>();
    if (!aggregateError && aggregates) {
      for (const raw of aggregates as unknown[]) {
        const row = raw as DiscoverySignalAggregateRow;
        signalsByPlaceId.set(String(row.place_id), row);
      }
    }

    const result: DiscoveryPlaceInput[] = [];
    for (const row of places) {
      const place = mapPlace({ ...row, producer_display_name: row.producers?.display_name });
      const aggregate = signalsByPlaceId.get(place.id);
      let live: { status: string; started_at: string | null } | null;
      let followers: number;
      let intents: number;
      let photos: number;
      let publishedExperiences: number;
      if (aggregate) {
        live = aggregate.live_status
          ? { status: String(aggregate.live_status), started_at: (aggregate.live_started_at as string | null) ?? null }
          : null;
        followers = Number(aggregate.followers);
        intents = Number(aggregate.visit_intents);
        photos = Number(aggregate.photos);
        publishedExperiences = Number(aggregate.published_experiences);
      } else {
        // Fallback: the exact per-Place queries this aggregate replaced
        // (identical semantics — see fetchLiveSignal/countRows).
        [live, followers, intents, photos] = await Promise.all([
          fetchLiveSignal(admin, place.id),
          countRows(admin, "place_follows", place.id).then(({ count }) => count ?? 0),
          countRows(admin, "visit_intents", place.id).then(({ count }) => count ?? 0),
          countRows(admin, "place_photos", place.id).then(({ count }) => count ?? 0),
        ]);
        // Experiences contribute only when BOTH status fields are 'published'
        // (the locked contract §1 definition).
        const { count } = await admin
          .from("experiences")
          .select("*", { count: "exact", head: true })
          .eq("place_id", place.id)
          .eq("status", "published")
          .eq("publication_status", "published");
        publishedExperiences = count ?? 0;
      }
      result.push(
        toDiscoveryInput(place, {
          live,
          followers,
          visitIntents: intents,
          publishedExperiences,
          photos,
        }),
      );
    }
    void now;
    return result;
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

export type PlaceMutation = Pick<Place, "id" | "name" | "shortDescription" | "category" | "type" | "area" | "countryCode" | "regionName" | "address" | "contactInformation" | "timezone" | "currency" | "latitude" | "longitude" | "coverImageUrl">;

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

  async create(input: PlaceMutation, producerId: string, creatorUserId?: string): Promise<Place> {
    // The RLS insert check stays on the caller's client: only a session whose
    // user holds an owner membership for `producerId` may create a Place.
    const { error: insertError } = await this.client.from("places").insert({
      id: input.id, name: input.name, short_description: input.shortDescription, category: input.category,
      type: input.type, area: input.area, address: input.address, contact_information: input.contactInformation,
      country_code: input.countryCode, region_name: input.regionName,
      timezone: input.timezone, currency: input.currency, latitude: input.latitude, longitude: input.longitude,
      cover_image_url: input.coverImageUrl,
      producer_id: producerId, publication_status: "draft",
    });
    if (insertError) throw insertError;

    // PO fix (browser verification, 2026-09-26): the SELECT/UPDATE policies
    // key on producer_memberships (place_id) and memberships carry NO client
    // insert policy, so a freshly created Place was invisible to its own
    // creator — the read-back (new → edit), the roster, and Upload all failed
    // for a NEW Place. Grant the creator the owner membership for the Place
    // they just created (the canonical ownership rule) via the service
    // client, then read the row back server-side. Idempotent on re-submit.
    if (creatorUserId) {
      // Lazy import: the service client is server-only and only needed on
      // this creator path (keeps the module loadable in the test harness).
      const { createSupabaseServiceClient } = await import("@/lib/supabase/admin");
      const admin = createSupabaseServiceClient();
      const { error: membershipError } = await admin.from("producer_memberships").upsert(
        { user_id: creatorUserId, producer_id: producerId, place_id: input.id, role: "owner" },
        { onConflict: "user_id,place_id" },
      );
      if (membershipError) {
        // No partial state: the place row is removed again whenever the
        // ownership grant fails — a half-created Place must never linger.
        // (An account may hold memberships for multiple Places; the
        // rollback is a safety net for any grant failure, not a cap.)
        await admin.from("places").delete().eq("id", input.id);
        throw membershipError;
      }
      const { data: savedRow, error: readError } = await admin
        .from("places")
        .select("*, producers(display_name)")
        .eq("id", input.id)
        .single();
      if (readError) throw readError;
      return mapPlace({ ...savedRow, producer_display_name: savedRow.producers?.display_name });
    }

    const { data, error } = await this.client.from("places").select("*, producers(display_name)").eq("id", input.id).single();
    if (error) throw error;
    return mapPlace({ ...data, producer_display_name: data.producers?.display_name });
  }

  async update(id: string, input: Omit<PlaceMutation, "id">): Promise<Place> {
    const { data, error } = await this.client.from("places").update({
      name: input.name, short_description: input.shortDescription, category: input.category, type: input.type,
      area: input.area, address: input.address, contact_information: input.contactInformation,
      country_code: input.countryCode, region_name: input.regionName,
      timezone: input.timezone, currency: input.currency, latitude: input.latitude, longitude: input.longitude,
      cover_image_url: input.coverImageUrl,
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

/**
 * Sessionless repository for PUBLIC discovery reads (published Places,
 * published Experiences) — backed by the shared public (anon) Supabase
 * client, which never touches `cookies()`. This keeps callers cache-safe:
 * a route handler using it can use Next.js ISR route caching without the
 * handler opting out via dynamic APIs. Never use it for reads that depend
 * on the viewer's identity (RLS still enforces authorization on the DB).
 */
export async function getPublicPlaceExperienceRepository(): Promise<PlaceExperienceRepository> {
  return new SupabasePlaceExperienceRepository(getPublicSupabaseClient());
}

export async function getServerPlaceManagementRepository(): Promise<SupabasePlaceManagementRepository> {
  return new SupabasePlaceManagementRepository(await createSupabaseServerClient());
}

export async function getServerExperienceManagementRepository(): Promise<SupabaseExperienceManagementRepository> {
  return new SupabaseExperienceManagementRepository(await createSupabaseServerClient());
}
