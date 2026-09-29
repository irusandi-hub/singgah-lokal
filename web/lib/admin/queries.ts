import "server-only";

import { PlatformModeratorRequiredError, requirePlatformModerator } from "@/lib/live/platform";
import { createSupabaseServiceClient } from "@/lib/supabase/admin";

/**
 * Admin Center data layer (Authority Master §5: operational oversight only).
 *
 * Rules enforced here:
 * - Every call re-verifies Platform Admin authorization server-side
 *   (`requirePlatformModerator`, session-derived) — no client-supplied identity.
 * - Data is read from canonical Supabase — never from cache or a search index
 *   (AGENTS.md). The reads use the service-role client because the platform
 *   scope is intentionally wider than the session's own RLS row scope
 *   (`memberships_self_read` 0001, `users_self_access`, `live_audit` dark to
 *   authenticated per 0008): without it the Overview/Membership pages could
 *   not report platform-wide canonical counts. Authorization stays on the
 *   session guard above; the service role never reaches the client.
 * - No secrets, tokens, or infrastructure credentials are ever selected or
 *   returned (Authority Master §3).
 * - Query failures surface as thrown errors, never as fabricated empty data.
 */

function canonicalAdminClient() {
  return createSupabaseServiceClient();
}

export type AdminOverviewTotals = {
  users: number;
  producers: number;
  producerMemberships: number;
  places: number;
  experiences: number;
};

export type AdminOverview = {
  totals: AdminOverviewTotals;
};

/**
 * NOTE: there is deliberately no Admin user read here. The single canonical
 * Admin user list — the one that also resolves the account email, because
 * user management is the only context that may see it — lives in
 * lib/admin/user-directory.ts. Two overlapping user reads would be a second
 * source of truth.
 */

/**
 * One Pengelola ↔ Place RELATION row (PO, 2026-09-29): every producer_memberships
 * row joined to its Place's geography, so the Data Pengelola page is the list of
 * WHO manages WHICH Place — not a producers table. The producers entity itself
 * is untouched; a Pengelola with several Places simply appears once per relation.
 */
export type AdminProducerPlaceRow = {
  /** Account email of the member — Admin context ONLY. */
  email: string | null;
  producerId: string;
  producerName: string;
  /** Canonical claim status of the Pengelola entity, displayed as data. */
  claimStatus: string;
  placeId: string | null;
  placeName: string | null;
  countryCode: string | null;
  regionName: string | null;
  /** Canonical Place category (the three-value locked vocabulary). */
  category: string | null;
  /** Membership role on this Place — the access/membership status. */
  role: string;
  placeCreatedAt: string | null;
};

export type AdminMembershipRow = {
  userId: string;
  producerId: string;
  placeId: string;
  role: string;
  createdAt: string;
  /** Account email of the member — Admin context ONLY. */
  userEmail: string | null;
  /** Canonical Place name, for reading and searching the list. */
  placeName: string | null;
};

export type AdminPlaceRow = {
  id: string;
  name: string;
  category: string;
  type: string;
  area: string;
  countryCode: string | null;
  regionName: string | null;
  publicationStatus: string;
  claimStatus: string;
  producerId: string | null;
  createdAt: string;
  /** Account email of the owner (via membership) — Admin context ONLY. */
  ownerEmail: string | null;
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
  const supabase = canonicalAdminClient();
  const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

function requireAdmin(): Promise<{ userId: string }> {
  return requirePlatformModerator();
}

/**
 * Bounded canonical read (PO, 2026-09-28): the list pages read the WHOLE
 * list domain — not the first page of it — so the country → region → name
 * ordering is computed over the real dataset and a search cannot silently
 * miss rows that fall outside a small page. The bound is a platform-size
 * guard, not a page size.
 */
const CANONICAL_LIST_LIMIT = 2000;

/** The ordering key of a Place: country → region → name (PO, 2026-09-28). */
type PlaceOrderTriple = { countryCode: string | null; regionName: string | null; name: string };

function compareByPlaceTriple(a: PlaceOrderTriple, b: PlaceOrderTriple): number {
  // A Place without geography sorts after every Place that has one (the
  // sentinel keeps the comparison total without special-casing nulls twice).
  const country = (a.countryCode ?? "\uffff").localeCompare(b.countryCode ?? "\uffff", "en");
  if (country !== 0) return country;
  const region = (a.regionName ?? "\uffff").localeCompare(b.regionName ?? "\uffff", "en");
  if (region !== 0) return region;
  return a.name.localeCompare(b.name, "en");
}

/**
 * Account emails BY user id, for the Admin lists that show/search them.
 * Same privacy posture as lib/admin/user-directory: resolved here — server
 * side, behind requireAdmin — and never sent anywhere else. A missing email
 * is reported absent, never guessed.
 */
async function loadAuthEmails(): Promise<Map<string, string>> {
  const { data, error } = await canonicalAdminClient().auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (error) throw error;
  const emails = new Map<string, string>();
  for (const user of data.users ?? []) {
    if (user.email) emails.set(String(user.id), user.email);
  }
  return emails;
}

export async function getAdminOverview(): Promise<AdminOverview> {
  await requireAdmin();

  // Counts only — no row reads. The Overview is a totals screen; the detail
  // behind every number lives on its own Admin page (PO, 2026-09-28: the
  // Overview no longer pre-reads Kunjungan rows for a "terbaru" table, and
  // carries no Kunjungan count — /admin/visit-intents owns that data).
  const [users, producers, producerMemberships, places, experiences] = await Promise.all([
    countRows("users"),
    countRows("producers"),
    countRows("producer_memberships"),
    countRows("places"),
    countRows("experiences"),
  ]);

  return { totals: { users, producers, producerMemberships, places, experiences } };
}

/**
 * The Pengelola ↔ Place list (PO, 2026-09-29).
 *
 * One row per producer_memberships relation, joined to the Pengelola (its
 * display name and claim status) and to the Place (name, country, region,
 * category, creation date) — plus the account email, resolved server-side
 * behind requireAdmin. The membership role IS the access status column.
 *
 * The row order is the canonical country → region → place-name triple shared
 * with the Place list (compareByPlaceTriple), so both lists line up region
 * by region. A membership whose Place row has disappeared keeps the relation
 * with null Place fields and sorts last — nothing is dropped or fabricated.
 */
export async function listAdminProducerPlaces(): Promise<AdminProducerPlaceRow[]> {
  await requireAdmin();

  const supabase = canonicalAdminClient();
  const [membershipResult, producerResult, placeResult, emails] = await Promise.all([
    supabase
      .from("producer_memberships")
      .select("user_id, producer_id, place_id, role, created_at")
      .order("created_at", { ascending: false })
      .limit(CANONICAL_LIST_LIMIT),
    supabase.from("producers").select("id, display_name, claim_status").limit(CANONICAL_LIST_LIMIT),
    supabase
      .from("places")
      .select("id, name, category, country_code, region_name, created_at")
      .order("country_code", { ascending: true })
      .order("region_name", { ascending: true })
      .order("name", { ascending: true })
      .limit(CANONICAL_LIST_LIMIT),
    loadAuthEmails(),
  ]);

  for (const result of [membershipResult, producerResult, placeResult]) {
    if (result.error) throw result.error;
  }

  const places = (placeResult.data ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    category: String(row.category),
    countryCode: row.country_code === null ? null : String(row.country_code),
    regionName: row.region_name === null ? null : String(row.region_name),
    createdAt: String(row.created_at),
  }));
  const placeById = new Map(places.map((place) => [place.id, place]));

  const producerById = new Map(
    (producerResult.data ?? []).map((row) => [
      String(row.id),
      { displayName: String(row.display_name), claimStatus: String(row.claim_status) },
    ]),
  );

  const rows = (membershipResult.data ?? []).map((row) => {
    const producerId = String(row.producer_id);
    const producer = producerById.get(producerId);
    const place = placeById.get(String(row.place_id));
    return {
      email: emails.get(String(row.user_id)) ?? null,
      producerId,
      producerName: producer?.displayName ?? producerId,
      claimStatus: producer?.claimStatus ?? "unverified",
      placeId: place?.id ?? null,
      placeName: place?.name ?? null,
      countryCode: place?.countryCode ?? null,
      regionName: place?.regionName ?? null,
      category: place?.category ?? null,
      role: String(row.role),
      placeCreatedAt: place?.createdAt ?? null,
    };
  });

  rows.sort((a, b) => {
    const order = compareByPlaceTriple(
      { countryCode: a.countryCode, regionName: a.regionName, name: a.placeName ?? "" },
      { countryCode: b.countryCode, regionName: b.regionName, name: b.placeName ?? "" },
    );
    if (order !== 0) return order;
    // Same Place, several members: owner first, then by Pengelola name.
    const roleRank = (role: string) => (role === "owner" ? 0 : 1);
    return (
      roleRank(a.role) - roleRank(b.role) ||
      a.producerName.localeCompare(b.producerName, "en") ||
      a.producerId.localeCompare(b.producerId)
    );
  });

  return rows;
}


export async function listAdminMemberships(): Promise<AdminMembershipRow[]> {
  await requireAdmin();

  const supabase = canonicalAdminClient();
  const [membershipResult, placeResult, emails] = await Promise.all([
    supabase
      .from("producer_memberships")
      .select("user_id, producer_id, place_id, role, created_at")
      .order("created_at", { ascending: false })
      .limit(CANONICAL_LIST_LIMIT),
    supabase
      .from("places")
      .select("id, name, country_code, region_name")
      .order("country_code", { ascending: true })
      .order("region_name", { ascending: true })
      .order("name", { ascending: true })
      .limit(CANONICAL_LIST_LIMIT),
    loadAuthEmails(),
  ]);

  for (const result of [membershipResult, placeResult]) {
    if (result.error) throw result.error;
  }

  const placeNameById = new Map((placeResult.data ?? []).map((row) => [String(row.id), String(row.name)]));

  return (membershipResult.data ?? []).map((row) => ({
    userId: String(row.user_id),
    producerId: String(row.producer_id),
    placeId: String(row.place_id),
    role: String(row.role),
    createdAt: String(row.created_at),
    userEmail: emails.get(String(row.user_id)) ?? null,
    placeName: placeNameById.get(String(row.place_id)) ?? null,
  }));
}

/**
 * Every Place, ordered country → region → place name (PO, 2026-09-28),
 * optionally narrowed by country and then by the subdivision inside that
 * country (PO, 2026-09-28). The filter is applied in the database against the
 * `(country_code, region_name)` index from migration 0032 — not by filtering
 * a page of rows in JavaScript — so a country selection always means "every
 * Place in this country", never "every Place in the first 100". Each row
 * carries the owner's account email (through the membership with role
 * 'owner'), resolved server-side behind requireAdmin — Admin context only.
 */
export async function listAdminPlaces(filter: { countryCode?: string | null; regionName?: string | null } = {}): Promise<AdminPlaceRow[]> {
  await requireAdmin();

  const supabase = canonicalAdminClient();
  const countryCode = filter.countryCode?.trim().toUpperCase() ?? "";
  const regionName = filter.regionName?.trim() ?? "";

  const [membershipResult, emails] = await Promise.all([
    supabase.from("producer_memberships").select("place_id, user_id, role, created_at").order("created_at", { ascending: true }).limit(CANONICAL_LIST_LIMIT),
    loadAuthEmails(),
  ]);
  if (membershipResult.error) throw membershipResult.error;

  let placeQuery = supabase
    .from("places")
    .select("id, name, category, type, area, country_code, region_name, publication_status, claim_status, producer_id, created_at")
    // The canonical order, applied in the DATABASE (PO, 2026-09-28):
    // country → region → place name — never a client-side sort of a
    // truncated page.
    .order("country_code", { ascending: true })
    .order("region_name", { ascending: true })
    .order("name", { ascending: true })
    .limit(CANONICAL_LIST_LIMIT);
  if (countryCode) placeQuery = placeQuery.eq("country_code", countryCode);
  if (countryCode && regionName) placeQuery = placeQuery.eq("region_name", regionName);

  const { data: placeData, error: placeError } = await placeQuery;
  if (placeError) throw placeError;

  // The owning account of a Place: the owner membership first, then any
  // membership, then the linked producer — whichever resolves an email first.
  const emailByPlace = new Map<string, string>();
  const roleRank = (role: string) => (role === "owner" ? 0 : 1);
  const orderedMemberships = [...(membershipResult.data ?? [])].sort(
    (a, b) => roleRank(String(a.role)) - roleRank(String(b.role)) || String(a.created_at).localeCompare(String(b.created_at)),
  );
  for (const row of orderedMemberships) {
    const placeId = String(row.place_id);
    if (emailByPlace.has(placeId)) continue;
    const email = emails.get(String(row.user_id));
    if (email) emailByPlace.set(placeId, email);
  }

  const rows = (placeData ?? []).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    category: String(row.category),
    type: String(row.type),
    area: String(row.area),
    countryCode: row.country_code === null ? null : String(row.country_code),
    regionName: row.region_name === null ? null : String(row.region_name),
    publicationStatus: String(row.publication_status),
    claimStatus: String(row.claim_status),
    producerId: row.producer_id === null ? null : String(row.producer_id),
    createdAt: String(row.created_at),
    ownerEmail: emailByPlace.get(String(row.id)) ?? null,
  }));

  return rows;
}

export async function listAdminExperiences(): Promise<AdminExperienceRow[]> {
  await requireAdmin();

  const supabase = canonicalAdminClient();
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

  const supabase = canonicalAdminClient();
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

export async function listAdminLiveSessions(): Promise<AdminLiveSessionRow[]> {
  await requireAdmin();

  const supabase = canonicalAdminClient();
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

export async function listAdminLiveReports(): Promise<AdminLiveReportRow[]> {
  await requireAdmin();

  const supabase = canonicalAdminClient();
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

export async function listAdminEligibility(): Promise<AdminEligibilityRow[]> {
  await requireAdmin();

  const supabase = canonicalAdminClient();
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

  const supabase = canonicalAdminClient();
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
