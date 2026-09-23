import "server-only";

import { PlatformModeratorRequiredError, requirePlatformModerator } from "@/lib/live/platform";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Admin Center data layer (Authority Master §5: operational oversight only).
 *
 * Rules enforced here:
 * - Every call re-verifies Platform Admin authorization server-side
 *   (`requirePlatformModerator`) — no client-supplied identity.
 * - Data is read from canonical Supabase through the RLS-governed anon-key
 *   server client — never from cache or a search index (AGENTS.md).
 * - No secrets, tokens, or infrastructure credentials are ever selected or
 *   returned (Authority Master §3).
 * - Query failures surface as thrown errors, never as fabricated empty data.
 */

export type AdminOverviewTotals = {
  users: number;
  producers: number;
  producerMemberships: number;
  places: number;
  experiences: number;
  visitIntents: number;
  liveSessions: number;
  liveReports: number;
};

export type AdminOverview = {
  totals: AdminOverviewTotals;
  recentVisitIntents: AdminVisitIntentRow[];
  recentLiveSessions: AdminLiveSessionRow[];
  recentLiveReports: AdminLiveReportRow[];
};

export type AdminUserRow = {
  id: string;
  createdAt: string;
  platformRole: string | null;
};

export type AdminProducerRow = {
  id: string;
  displayName: string;
  claimStatus: string;
  createdAt: string;
};

export type AdminMembershipRow = {
  userId: string;
  producerId: string;
  placeId: string;
  role: string;
  createdAt: string;
};

export type AdminPlaceRow = {
  id: string;
  name: string;
  category: string;
  type: string;
  area: string;
  publicationStatus: string;
  claimStatus: string;
  producerId: string | null;
  createdAt: string;
};

export type AdminExperienceRow = {
  id: string;
  placeId: string;
  title: string;
  status: string;
  publicationStatus: string;
  createdAt: string;
};

export type AdminVisitIntentRow = {
  id: string;
  userId: string;
  placeId: string;
  experienceId: string;
  requestedDate: string;
  requestedStartTime: string;
  requestedEndTime: string;
  status: string;
  createdAt: string;
};

export type AdminLiveSessionRow = {
  id: string;
  placeId: string;
  producerId: string;
  stageId: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
  viewerPeak: number;
};

export type AdminLiveReportRow = {
  id: string;
  liveSessionId: string;
  reporterId: string;
  category: string;
  note: string | null;
  createdAt: string;
};

export type AdminEligibilityRow = {
  producerId: string;
  path: string;
  active: boolean;
  grantedAt: string;
};

export type AdminAuditRow = {
  id: number;
  actorId: string | null;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
};

async function countRows(table: string): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

function requireAdmin(): Promise<{ userId: string }> {
  return requirePlatformModerator();
}

export async function getAdminOverview(): Promise<AdminOverview> {
  await requireAdmin();

  const [
    users,
    producers,
    producerMemberships,
    places,
    experiences,
    visitIntents,
    liveSessions,
    liveReports,
  ] = await Promise.all([
    countRows("users"),
    countRows("producers"),
    countRows("producer_memberships"),
    countRows("places"),
    countRows("experiences"),
    countRows("visit_intents"),
    countRows("live_sessions"),
    countRows("live_reports"),
  ]);

  const [recentVisitIntents, recentLiveSessions, recentLiveReports] = await Promise.all([
    listRecentVisitIntents(5),
    listRecentLiveSessions(5),
    listRecentLiveReports(5),
  ]);

  return {
    totals: {
      users,
      producers,
      producerMemberships,
      places,
      experiences,
      visitIntents,
      liveSessions,
      liveReports,
    },
    recentVisitIntents,
    recentLiveSessions,
    recentLiveReports,
  };
}

export async function listAdminUsers(): Promise<AdminUserRow[]> {
  await requireAdmin();

  const supabase = await createSupabaseServerClient();
  // MVP read-only scope: id, created_at, platform_role. No email selection —
  // public.users intentionally holds no email and auth.users is not read here.
  const { data, error } = await supabase
    .from("users")
    .select("id, created_at, platform_role")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    createdAt: String(row.created_at),
    platformRole: row.platform_role ?? null,
  }));
}

export async function listAdminProducers(): Promise<AdminProducerRow[]> {
  await requireAdmin();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("producers")
    .select("id, display_name, claim_status, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    displayName: String(row.display_name),
    claimStatus: String(row.claim_status),
    createdAt: String(row.created_at),
  }));
}

export async function listAdminMemberships(): Promise<AdminMembershipRow[]> {
  await requireAdmin();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("producer_memberships")
    .select("user_id, producer_id, place_id, role, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    userId: String(row.user_id),
    producerId: String(row.producer_id),
    placeId: String(row.place_id),
    role: String(row.role),
    createdAt: String(row.created_at),
  }));
}

export async function listAdminPlaces(): Promise<AdminPlaceRow[]> {
  await requireAdmin();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("places")
    .select("id, name, category, type, area, publication_status, claim_status, producer_id, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    category: String(row.category),
    type: String(row.type),
    area: String(row.area),
    publicationStatus: String(row.publication_status),
    claimStatus: String(row.claim_status),
    producerId: row.producer_id === null ? null : String(row.producer_id),
    createdAt: String(row.created_at),
  }));
}

export async function listAdminExperiences(): Promise<AdminExperienceRow[]> {
  await requireAdmin();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("experiences")
    .select("id, place_id, title, status, publication_status, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    placeId: String(row.place_id),
    title: String(row.title),
    status: String(row.status),
    publicationStatus: String(row.publication_status),
    createdAt: String(row.created_at),
  }));
}

export async function listAdminVisitIntents(): Promise<AdminVisitIntentRow[]> {
  await requireAdmin();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("visit_intents")
    .select("id, user_id, place_id, experience_id, requested_date, requested_start_time, requested_end_time, status, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    placeId: String(row.place_id),
    experienceId: String(row.experience_id),
    requestedDate: String(row.requested_date),
    requestedStartTime: String(row.requested_start_time).slice(0, 5),
    requestedEndTime: String(row.requested_end_time).slice(0, 5),
    status: String(row.status),
    createdAt: String(row.created_at),
  }));
}

async function listRecentVisitIntents(limit: number): Promise<AdminVisitIntentRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("visit_intents")
    .select("id, user_id, place_id, experience_id, requested_date, requested_start_time, requested_end_time, status, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    placeId: String(row.place_id),
    experienceId: String(row.experience_id),
    requestedDate: String(row.requested_date),
    requestedStartTime: String(row.requested_start_time).slice(0, 5),
    requestedEndTime: String(row.requested_end_time).slice(0, 5),
    status: String(row.status),
    createdAt: String(row.created_at),
  }));
}

export async function listAdminLiveSessions(): Promise<AdminLiveSessionRow[]> {
  await requireAdmin();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("live_sessions")
    .select("id, place_id, producer_id, stage_id, status, started_at, ended_at, ended_reason, viewer_peak")
    .order("started_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    placeId: String(row.place_id),
    producerId: String(row.producer_id),
    stageId: String(row.stage_id),
    status: String(row.status),
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    endedReason: row.ended_reason === null ? null : String(row.ended_reason),
    viewerPeak: Number(row.viewer_peak),
  }));
}

async function listRecentLiveSessions(limit: number): Promise<AdminLiveSessionRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("live_sessions")
    .select("id, place_id, producer_id, stage_id, status, started_at, ended_at, ended_reason, viewer_peak")
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    placeId: String(row.place_id),
    producerId: String(row.producer_id),
    stageId: String(row.stage_id),
    status: String(row.status),
    startedAt: String(row.started_at),
    endedAt: row.ended_at === null ? null : String(row.ended_at),
    endedReason: row.ended_reason === null ? null : String(row.ended_reason),
    viewerPeak: Number(row.viewer_peak),
  }));
}

export async function listAdminLiveReports(): Promise<AdminLiveReportRow[]> {
  await requireAdmin();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("live_reports")
    .select("id, live_session_id, reporter_id, category, note, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    liveSessionId: String(row.live_session_id),
    reporterId: String(row.reporter_id),
    category: String(row.category),
    note: row.note === null ? null : String(row.note),
    createdAt: String(row.created_at),
  }));
}

async function listRecentLiveReports(limit: number): Promise<AdminLiveReportRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("live_reports")
    .select("id, live_session_id, reporter_id, category, note, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: String(row.id),
    liveSessionId: String(row.live_session_id),
    reporterId: String(row.reporter_id),
    category: String(row.category),
    note: row.note === null ? null : String(row.note),
    createdAt: String(row.created_at),
  }));
}

export async function listAdminEligibility(): Promise<AdminEligibilityRow[]> {
  await requireAdmin();

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("live_eligibility")
    .select("producer_id, path, active, granted_at")
    .order("granted_at", { ascending: false })
    .limit(100);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    producerId: String(row.producer_id),
    path: String(row.path),
    active: Boolean(row.active),
    grantedAt: String(row.granted_at),
  }));
}

export async function listAdminAudit(): Promise<AdminAuditRow[]> {
  await requireAdmin();

  const supabase = await createSupabaseServerClient();
  // live_audit has no SELECT grant for authenticated (append-only, migration
  // 0008/0013) — reads go through the server client, which is denied by RLS
  // unless the moderator policy applies. Fail closed: an error surfaces as a
  // thrown error, never as fabricated data.
  const { data, error } = await supabase
    .from("live_audit")
    .select("id, actor_id, action, detail, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: Number(row.id),
    actorId: row.actor_id === null ? null : String(row.actor_id),
    action: String(row.action),
    detail: (row.detail ?? {}) as Record<string, unknown>,
    createdAt: String(row.created_at),
  }));
}

export { PlatformModeratorRequiredError };
