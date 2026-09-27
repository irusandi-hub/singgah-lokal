import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0029 — notification fan-out for the Master 10 §6 events that have a
 * trigger point in the current code base.
 *
 * Applies the real migration chain on Postgres (PGlite) and drives the same
 * write paths the server uses (submit/approve/review RPCs, direct Visit Intent
 * writes), then asserts:
 * - Producer application submitted → every Platform Admin, nobody else;
 * - approved/rejected → the applicant only, and a refile after a rejection is a
 *   NEW event (a new submission sequence), while a repeated fire of the same
 *   submission is not;
 * - Place claim submitted → every Platform Admin; approved/rejected → the
 *   claimant only;
 * - Visit Intent created → the Place's owner/manager Producers (editors and
 *   unrelated accounts excluded);
 * - accepted/declined/requires_confirmation → the User; cancelled → the OTHER
 *   party; expired → the Producer;
 * - a repeated identical event never creates a second row (MASTER 10 §12);
 * - a switched-off category is not written and a missing preference row keeps
 *   the 0024 default, exactly like the 0026 Live path;
 * - no generated wording implies payment, order, or guaranteed reservation;
 * - the realtime unread signal is broadcast on the RECIPIENT's own topic after
 *   insert and after mark-as-read;
 * - a notification failure never rolls back the valid business change;
 * - the write surfaces and grants of the underlying tables are unchanged.
 */

const MIGRATION_DIR = "../supabase/migrations/";
const readMigration = (name: string) => readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

const MIGRATIONS = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0008_live_sessions.sql",
  "0016_producer_applications.sql",
  "0017_producer_application_refile.sql",
  "0020_one_membership_per_user.sql",
  "0022_allow_multiple_places_per_producer.sql",
  "0023_place_follows.sql",
  "0024_notification_preferences.sql",
  "0025_notifications.sql",
  "0026_live_followed_notifications.sql",
  "0028_place_claims.sql",
  "0029_notification_fanout.sql",
];

const ADMIN = "11111111-1111-1111-1111-111111111111";
const ADMIN_2 = "22222222-2222-2222-2222-222222222222";
const APPLICANT = "33333333-3333-3333-3331-111111111111";
const CLAIMANT = "44444444-4444-4444-4441-111111111111";
const PRODUCER = "55555555-5555-5555-5551-111111111111";
const PRODUCER_2 = "55555555-5555-5555-5552-111111111111";
const EDITOR = "66666666-6666-6666-6661-111111111111";
const VISITOR = "77777777-7777-7777-7771-111111111111";
const OUTSIDER = "88888888-8888-8888-8881-111111111111";

const PLACE = "rumah-teh-lokal"; // seeded by 0001, type 'experience', OWNED (Visit Intent tests)
const CLAIM_PLACE = "dapur-rasa"; // seeded by 0001, UNOWNED (Place claim tests)
const CLAIMANT_OWN_PLACE = "kopi-dari-kebun"; // seeded by 0001, the claimant's existing Producer identity
const EXPERIENCE = "kunjungan-pengenalan-rumah-teh"; // seeded by 0001
const TIMEZONE = "Asia/Jakarta";

type Row = Record<string, unknown>;

const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  // Supabase environment shims (harness-only, same pattern as
  // live-migration-validity.test.ts). realtime.* records the broadcasts the
  // database sends so the unread signal can be asserted; storage.buckets is
  // needed by 0028.
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_admin;
    create role authenticator;
    grant usage on schema auth to authenticated;

    create schema if not exists realtime;
    create table realtime.messages (
      id bigserial primary key,
      topic text,
      extension text,
      event text,
      payload jsonb
    );
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to authenticated;
    grant select on realtime.messages to authenticated;
    create function realtime.topic() returns text language sql stable as 'select current_setting(''realtime.topic'', true)';
    create function realtime.send(p_payload jsonb, p_event text, p_topic text, p_private boolean default true)
      returns void language plpgsql as $$
      begin
        insert into realtime.messages (topic, extension, event, payload)
        values (p_topic, 'broadcast', p_event, p_payload);
      end;
      $$;

    create schema if not exists storage;
    create table storage.buckets (
      id text primary key,
      name text,
      public boolean,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
  `);
  await db.exec("create publication supabase_realtime;");
  for (const name of MIGRATIONS) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  return db;
}

async function seedUser(db: PGlite, userId: string, platformRole: string | null = null): Promise<void> {
  await db.exec(`insert into auth.users (id) values ('${userId}') on conflict do nothing`);
  await db.exec(
    `insert into public.users (id, platform_role) values ('${userId}', ${platformRole ? `'${platformRole}'` : "null"})
     on conflict (id) do update set platform_role = excluded.platform_role`,
  );
}

async function seedMembership(
  db: PGlite,
  userId: string,
  placeId: string,
  role: string,
  producerId = "prod-notify",
): Promise<void> {
  await db.exec(`insert into public.producers (id, display_name) values ('${producerId}', 'Producer Demo') on conflict do nothing`);
  await db.exec(
    `insert into public.producer_memberships (user_id, producer_id, place_id, role)
     values ('${userId}', '${producerId}', '${placeId}', '${role}') on conflict do nothing`,
  );
}

async function setPreference(db: PGlite, userId: string, category: string, value: boolean): Promise<void> {
  await db.exec(
    `insert into public.notification_preferences (user_id, ${category}) values ('${userId}', ${value})
     on conflict (user_id) do update set ${category} = excluded.${category}`,
  );
}

/** The acting session (auth.uid() inside the trigger) WITHOUT switching the
 *  database role — used where the write path is server-side (service role). */
async function actAsActor(db: PGlite, userId: string | null): Promise<void> {
  await db.exec("reset role;");
  await db.exec(
    `create or replace function auth.uid() returns uuid language sql stable as $fn$ select ${userId ? `'${userId}'::uuid` : "null::uuid"} $fn$`,
  );
}

/** A real authenticated session: RLS applies. */
async function actAs(db: PGlite, userId: string | null): Promise<void> {
  await actAsActor(db, userId);
  await db.exec("set role authenticated;");
}

const notifications = async (db: PGlite) =>
  rows(db, "select * from public.notifications order by user_id, created_at, event_type");

const broadcasts = async (db: PGlite) =>
  rows(db, "select topic, event, payload from realtime.messages order by id");

async function fileApplication(db: PGlite, userId: string, email = "pemohon@example.com"): Promise<void> {
  await db.query(`select public.submit_producer_application($1::uuid, $2::text, null)`, [userId, email]);
}

async function reviewApplication(db: PGlite, applicationId: string, placeId: string): Promise<void> {
  await db.query(`select public.approve_producer_application($1::uuid, $2::text, $3::text, 'owner')`, [
    applicationId,
    "prod-notify",
    placeId,
  ]);
}

async function fileClaim(db: PGlite, userId: string, placeId: string): Promise<string> {
  const inserted = await rows(
    db,
    `select public.submit_place_claim($1::uuid, $2::text, $3::text) as id`,
    [userId, placeId, `${userId.slice(0, 8)}/bukti.pdf`],
  );
  return String(inserted[0].id);
}

async function reviewClaim(db: PGlite, claimId: string, decision: "approved" | "rejected", note: string | null = null): Promise<void> {
  await db.query(`select public.review_place_claim($1::uuid, $2::text, $3::text)`, [claimId, decision, note]);
}

async function createIntent(db: PGlite, userId: string, id: string, placeId = PLACE, experienceId = EXPERIENCE): Promise<void> {
  await db.query(
    `insert into public.visit_intents
       (id, user_id, place_id, experience_id, requested_date, requested_start_time,
        requested_end_time, party_size, timezone, status, idempotency_key)
     values ($1, $2::uuid, $3, $4, current_date + 30, '10:00', '12:00', 2, $5, 'pending', $6)`,
    [id, userId, placeId, experienceId, TIMEZONE, `idem-${id}`],
  );
}

async function setIntentStatus(db: PGlite, id: string, status: string, note: string | null = null): Promise<void> {
  await db.query(
    `update public.visit_intents set status = $2, producer_response_note = $3 where id = $1`,
    [id, status, note],
  );
}

async function seedStandardWorld(): Promise<PGlite> {
  const db = await createDb();
  await seedUser(db, ADMIN, "platform_moderator");
  await seedUser(db, ADMIN_2, "platform_moderator");
  await seedUser(db, APPLICANT);
  await seedUser(db, CLAIMANT);
  await seedUser(db, PRODUCER);
  await seedUser(db, PRODUCER_2);
  await seedUser(db, EDITOR);
  await seedUser(db, VISITOR);
  await seedUser(db, OUTSIDER);
  await seedMembership(db, PRODUCER, PLACE, "owner");
  await seedMembership(db, PRODUCER_2, PLACE, "owner");
  await seedMembership(db, EDITOR, PLACE, "editor");
  // The claimant already runs another Place, so an approved claim has a Producer
  // identity to bind (the 0028 approval contract).
  await seedMembership(db, CLAIMANT, CLAIMANT_OWN_PLACE, "owner", "prod-other");
  return db;
}

/**
 * 0002 only allows pending → accepted/declined/requires_confirmation (and the
 * same from requires_confirmation), so 'cancelled' and 'expired' are defined in
 * MASTER 10 §6 but currently unreachable through any write path. The guard is
 * removed HERE ONLY, to prove the 0029 routing of those two Master events; the
 * migration under test and the business rule are both left untouched.
 */
async function withoutTransitionGuard(db: PGlite): Promise<void> {
  await db.exec("drop trigger if exists visit_intent_write_validation on public.visit_intents");
}

// ---------------------------------------------------------------------------
// Migration surface
// ---------------------------------------------------------------------------

test("0029 applies cleanly and adds only additive artifacts (no grant/RLS change)", async () => {
  const db = await createDb();

  // Idempotent: the SQL-Editor apply runbook re-runs a whole file, so applying
  // 0029 twice must be a no-op rather than an error.
  await db.exec(stripPgcrypto(readMigration("0029_notification_fanout.sql")));

  const triggerNames = (
    await rows(
      db,
      `select tgname from pg_trigger
       where tgname in ('producer_applications_notify','place_claims_notify','visit_intents_notify','notifications_broadcast_unread')
         and not tgisinternal order by tgname`,
    )
  ).map((row) => String(row.tgname));
  assert.deepEqual(triggerNames, [
    "notifications_broadcast_unread",
    "place_claims_notify",
    "producer_applications_notify",
    "visit_intents_notify",
  ]);

  // The realtime gate is recipient-scoped to auth.uid().
  const policy = await rows(
    db,
    `select policyname, qual from pg_policies
     where schemaname = 'realtime' and tablename = 'messages' and policyname = 'notifications_realtime_receive'`,
  );
  assert.equal(policy.length, 1, "the notification realtime receive policy must exist");
  assert.match(String(policy[0].qual), /auth\.uid\(\)/, "the gate must be built from the session's own auth.uid()");
  assert.match(String(policy[0].qual), /notifications:/);

  // The dedup key 0029 relies on is still the unique one from 0026.
  const dedup = await rows(
    db,
    `select indexdef from pg_indexes where schemaname='public' and tablename='notifications' and indexname='notifications_dedup_idx'`,
  );
  assert.match(String(dedup[0]?.indexdef), /unique/i);

  // Clients keep exactly the surface 0025/0028 defined: notifications are never
  // client-insertable, and the domain tables stay server-side only.
  for (const table of ["notifications", "producer_applications", "place_claims"]) {
    const grants = await rows(
      db,
      `select grantee, privilege_type from information_schema.role_table_grants
       where table_schema='public' and table_name=$1 and grantee in ('anon','authenticated') order by 1,2`,
      [table],
    );
    const writable = grants.filter((row) => ["INSERT", "UPDATE", "DELETE"].includes(String(row.privilege_type)));
    assert.equal(
      writable.length,
      0,
      `${table} must stay server-side only for anon/authenticated (found ${JSON.stringify(writable)})`,
    );
  }
  const notificationGrants = (
    await rows(
      db,
      `select grantee, privilege_type from information_schema.role_table_grants
       where table_schema='public' and table_name='notifications' and grantee='authenticated' order by 2`,
    )
  ).map((row) => String(row.privilege_type));
  assert.deepEqual(notificationGrants, ["SELECT"], "read only at table level, unchanged by 0029");
  const columnGrants = (
    await rows(
      db,
      `select column_name from information_schema.column_privileges
       where table_schema='public' and table_name='notifications'
         and grantee='authenticated' and privilege_type='UPDATE'`,
    )
  ).map((row) => String(row.column_name));
  assert.deepEqual(columnGrants, ["read_at"], "read_at stays the only client-writable column");

  // Only one column was added, and it defaults for existing rows.
  const column = await rows(
    db,
    `select column_default, is_nullable from information_schema.columns
     where table_schema='public' and table_name='producer_applications' and column_name='submission_seq'`,
  );
  assert.equal(column.length, 1);
  assert.equal(String(column[0].is_nullable), "NO", "the submission counter is NOT NULL");
  await db.close();
});

// ---------------------------------------------------------------------------
// Producer application
// ---------------------------------------------------------------------------

test("producer application submitted notifies every Platform Admin and nobody else", async () => {
  const db = await seedStandardWorld();
  await fileApplication(db, APPLICANT);

  const created = await notifications(db);
  assert.deepEqual(
    created.map((row) => String(row.user_id)).sort(),
    [ADMIN, ADMIN_2],
    "both moderators are recipients; the applicant and other users are not",
  );
  for (const row of created) {
    assert.equal(row.category, "system", "no category outside the locked six");
    assert.equal(row.event_type, "producer_application_submitted");
    assert.equal(row.title, "Pengajuan Producer baru");
    assert.equal(row.body, "Pengajuan menunggu verifikasi admin.");
    assert.equal(row.source_type, "producer_application");
    assert.equal(row.place_id, null, "an application references no Place yet, so no route is invented");
    assert.equal(row.read_at, null);
  }
  assert.equal(created[0].source_id, `${(await rows(db, "select id from public.producer_applications"))[0].id}:1`);
  await db.close();
});

test("producer application decision notifies the applicant only", async () => {
  const db = await seedStandardWorld();
  await fileApplication(db, APPLICANT);
  const applicationId = String((await rows(db, "select id from public.producer_applications"))[0].id);

  await reviewApplication(db, applicationId, PLACE);

  const created = (await notifications(db)).filter(
    (row) => row.event_type !== "producer_application_submitted",
  );
  assert.equal(created.length, 1, "exactly one decision notification");
  assert.equal(created[0].user_id, APPLICANT, "the decision goes to the applicant");
  assert.equal(created[0].event_type, "producer_application_approved");
  assert.equal(created[0].title, "Pengajuan disetujui");
  assert.equal(created[0].body, "Pengajuan disetujui — membership Producer aktif untuk akun ini.");
  assert.equal(created[0].source_id, `${applicationId}:1`);

  // Rejecting an already-approved row is impossible (the RPC refuses it) and
  // therefore cannot produce a second, contradictory decision notification.
  await assert.rejects(() => reviewApplication(db, applicationId, PLACE), /application_not_pending/);
  assert.equal(
    (await notifications(db)).filter((row) => row.event_type !== "producer_application_submitted").length,
    1,
  );
  await db.close();
});

test("a rejected application notifies the applicant, and a refile is a NEW submission event", async () => {
  const db = await seedStandardWorld();
  await fileApplication(db, APPLICANT);
  const applicationId = String((await rows(db, "select id from public.producer_applications"))[0].id);

  await db.query(`update public.producer_applications set status = 'rejected', reviewed_at = now() where id = $1`, [applicationId]);
  // Refile the SAME row (0017 contract): the applicant must hear the decision
  // once, and the Admin must hear about the new submission.
  await fileApplication(db, APPLICANT);

  const created = await notifications(db);
  const rejected = created.filter((row) => row.event_type === "producer_application_rejected");
  assert.equal(rejected.length, 1, "one rejection notification");
  assert.equal(rejected[0].user_id, APPLICANT);
  assert.equal(rejected[0].body, "Pengajuan sebelumnya ditolak. Kamu bisa mengajukan kembali.");

  const submitted = created.filter((row) => row.event_type === "producer_application_submitted");
  assert.equal(submitted.length, 4, "one per Platform Admin, for BOTH submissions");
  assert.deepEqual(
    [...new Set(submitted.map((row) => String(row.source_id)))].sort(),
    [`${applicationId}:1`, `${applicationId}:2`],
    "each submission occurrence is its own deduplicated event id",
  );

  // Re-firing the same submission (an UPDATE that leaves it pending) is a
  // duplicate domain event and must not add rows.
  await db.query(`update public.producer_applications set note = note where id = $1`, [applicationId]);
  assert.equal(
    (await notifications(db)).filter((row) => row.event_type === "producer_application_submitted").length,
    4,
    "a duplicate event never creates a duplicate notification",
  );
  await db.close();
});

// ---------------------------------------------------------------------------
// Place claim
// ---------------------------------------------------------------------------

test("place claim submitted notifies Platform Admin; the decision notifies the claimant", async () => {
  const db = await seedStandardWorld();
  const claimId = await fileClaim(db, CLAIMANT, CLAIM_PLACE);

  let created = await notifications(db);
  const submitted = created.filter((row) => row.event_type === "place_claim_submitted");
  assert.equal(submitted.length, 2, "both moderators receive the claim");
  assert.deepEqual([...new Set(submitted.map((row) => String(row.user_id)))].sort(), [ADMIN, ADMIN_2]);
  assert.equal(submitted[0].title, "Klaim Place baru");
  assert.equal(submitted[0].body, "Klaim Place Dapur Rasa menunggu penilaian Admin.");
  assert.equal(submitted[0].place_id, CLAIM_PLACE, "the payload references the claimed Place entity");
  assert.equal(submitted[0].source_type, "place_claim");
  assert.equal(submitted[0].source_id, claimId);

  await reviewClaim(db, claimId, "approved", null);

  created = await notifications(db);
  const approved = created.filter((row) => row.event_type === "place_claim_approved");
  assert.equal(approved.length, 1, "exactly one decision notification");
  assert.equal(approved[0].user_id, CLAIMANT, "the decision goes to the claimant, not to the Admin");
  assert.equal(approved[0].title, "Klaim Place disetujui");
  assert.equal(approved[0].body, "Disetujui — ownership diberikan untuk Dapur Rasa.");
  assert.equal(approved[0].place_id, CLAIM_PLACE);
  assert.ok(
    !created.some((row) => row.user_id === ADMIN && String(row.event_type).startsWith("place_claim_approved")),
    "an Admin never receives its own decision",
  );

  // A second review of the same claim is refused by the RPC (no duplicate event).
  await assert.rejects(() => reviewClaim(db, claimId, "rejected", null), /place_claim_not_pending/);
  assert.equal((await notifications(db)).filter((row) => row.event_type === "place_claim_approved").length, 1);
  await db.close();
});

test("a rejected claim notifies the claimant and includes the Admin review note", async () => {
  const db = await seedStandardWorld();
  const claimId = await fileClaim(db, CLAIMANT, CLAIM_PLACE);
  await reviewClaim(db, claimId, "rejected", "Bukti tidak jelas.");

  const rejected = (await notifications(db)).filter((row) => row.event_type === "place_claim_rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].user_id, CLAIMANT);
  assert.equal(rejected[0].body, "Ditolak: Bukti tidak jelas.");
  assert.equal(rejected[0].place_id, CLAIM_PLACE);
  await db.close();
});

// ---------------------------------------------------------------------------
// Visit Intent
// ---------------------------------------------------------------------------

test("a created Visit Intent notifies the Place's owner/manager Producers only", async () => {
  const db = await seedStandardWorld();
  await createIntent(db, VISITOR, "vi-create-1");

  const created = await notifications(db);
  assert.deepEqual(
    created.map((row) => String(row.user_id)).sort(),
    [PRODUCER, PRODUCER_2],
    "the editor, the visitor, the Admin and the outsider are NOT recipients",
  );
  for (const row of created) {
    assert.equal(row.category, "visit_experience");
    assert.equal(row.event_type, "visit_intent_created");
    assert.equal(row.place_id, PLACE);
    assert.equal(row.source_type, "visit_intent");
    assert.equal(row.source_id, "vi-create-1");
    assert.match(String(row.body), /Rumah Teh Lokal/, "the notification names the Place");
    assert.match(String(row.body), new RegExp(TIMEZONE), "MASTER 10 §7: the Place timezone is named");
    assert.match(String(row.body), /\d{2}\/\d{2}\/\d{4} 10:00-12:00/);
  }
  await db.close();
});

test("Visit Intent accepted / declined / requires_confirmation notify the User", async () => {
  const db = await seedStandardWorld();
  await createIntent(db, VISITOR, "vi-accept-1");
  await setIntentStatus(db, "vi-accept-1", "accepted", "Silakan datang.");

  const db2 = await seedStandardWorld();
  await createIntent(db2, VISITOR, "vi-decline-1");
  await setIntentStatus(db2, "vi-decline-1", "declined", "Slot penuh.");

  const db3 = await seedStandardWorld();
  await createIntent(db3, VISITOR, "vi-confirm-1");
  await setIntentStatus(db3, "vi-confirm-1", "requires_confirmation", "Boleh konfirmasi lagi?");

  const accepted = (await notifications(db)).filter((row) => row.event_type === "visit_intent_accepted");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].user_id, VISITOR, "the decision goes to the User who filed the intent");
  assert.equal(accepted[0].title, "Visit Intent diterima");
  assert.equal(accepted[0].body, "Visit Intent kamu di Rumah Teh Lokal diterima. Respons Producer: Silakan datang.");

  const declined = (await notifications(db2)).filter((row) => row.event_type === "visit_intent_declined");
  assert.equal(declined.length, 1);
  assert.equal(declined[0].user_id, VISITOR);
  assert.equal(declined[0].title, "Visit Intent ditolak");

  const confirm = (await notifications(db3)).filter((row) => row.event_type === "visit_intent_requires_confirmation");
  assert.equal(confirm.length, 1);
  assert.equal(confirm[0].user_id, VISITOR);
  assert.equal(confirm[0].title, "Visit Intent perlu konfirmasi");
  await db.close();
  await db2.close();
  await db3.close();
});

test("cancelled notifies the OTHER party; expired notifies the Producer", async () => {
  // The User cancels → the Producer is informed.
  const userCancels = await seedStandardWorld();
  await withoutTransitionGuard(userCancels);
  await createIntent(userCancels, VISITOR, "vi-cancel-user");
  await actAsActor(userCancels, VISITOR);
  await setIntentStatus(userCancels, "vi-cancel-user", "cancelled");
  await actAsActor(userCancels, null);

  const toProducers = (await notifications(userCancels)).filter((row) => row.event_type === "visit_intent_cancelled");
  assert.deepEqual(
    toProducers.map((row) => String(row.user_id)).sort(),
    [PRODUCER, PRODUCER_2],
    "the cancelling User is not notified about their own cancellation",
  );
  assert.equal(toProducers[0].body, "Visit Intent di Rumah Teh Lokal dibatalkan.");
  await userCancels.close();

  // The Producer cancels → the User is informed.
  const producerCancels = await seedStandardWorld();
  await withoutTransitionGuard(producerCancels);
  await createIntent(producerCancels, VISITOR, "vi-cancel-producer");
  await actAsActor(producerCancels, PRODUCER);
  await setIntentStatus(producerCancels, "vi-cancel-producer", "cancelled");
  await actAsActor(producerCancels, null);

  const toUser = (await notifications(producerCancels)).filter((row) => row.event_type === "visit_intent_cancelled");
  assert.equal(toUser.length, 1);
  assert.equal(toUser[0].user_id, VISITOR);
  await producerCancels.close();

  // Expiry is a backend rule, so the Producer is the party that must act.
  const expired = await seedStandardWorld();
  await withoutTransitionGuard(expired);
  await createIntent(expired, VISITOR, "vi-expired-1");
  await setIntentStatus(expired, "vi-expired-1", "expired");
  const toExpiredProducer = (await notifications(expired)).filter((row) => row.event_type === "visit_intent_expired");
  assert.deepEqual(
    toExpiredProducer.map((row) => String(row.user_id)).sort(),
    [PRODUCER, PRODUCER_2],
  );
  assert.equal(toExpiredProducer[0].body, "Visit Intent di Rumah Teh Lokal kedaluwarsa.");
  await expired.close();
});

test("a repeated identical Visit Intent event never duplicates a notification", async () => {
  const db = await seedStandardWorld();
  // The 0002 transition guard makes a literal repeat unreachable, so it is
  // lifted here to prove the dedup key is what absorbs the duplicate event.
  await withoutTransitionGuard(db);
  await createIntent(db, VISITOR, "vi-dup-1");
  await setIntentStatus(db, "vi-dup-1", "accepted", "ok");
  assert.equal((await notifications(db)).filter((row) => row.event_type === "visit_intent_accepted").length, 1);

  // A duplicate domain event: the same status is reported twice.
  await setIntentStatus(db, "vi-dup-1", "pending");
  await setIntentStatus(db, "vi-dup-1", "accepted", "ok");
  assert.equal(
    (await notifications(db)).filter((row) => row.event_type === "visit_intent_accepted").length,
    1,
    "the dedup key absorbs the repeat",
  );
  // An unrelated field change is not an event at all.
  await db.query(`update public.visit_intents set updated_at = now() where id = 'vi-dup-1'`);
  assert.equal((await notifications(db)).filter((row) => row.event_type === "visit_intent_accepted").length, 1);
  await db.close();
});

test("no generated notification wording implies payment, order, or a guaranteed reservation", async () => {
  const db = await seedStandardWorld();
  await fileApplication(db, APPLICANT);
  const applicationId = String((await rows(db, "select id from public.producer_applications"))[0].id);
  await db.query(`update public.producer_applications set status = 'rejected' where id = $1`, [applicationId]);
  await fileApplication(db, APPLICANT);
  const claimId = await fileClaim(db, CLAIMANT, CLAIM_PLACE);
  await reviewClaim(db, claimId, "rejected", "Tidak sesuai.");
  await withoutTransitionGuard(db);
  await createIntent(db, VISITOR, "vi-copy-1");
  await setIntentStatus(db, "vi-copy-1", "accepted", "Bisa datang.");
  await setIntentStatus(db, "vi-copy-1", "cancelled");

  const created = await notifications(db);
  assert.ok(created.length >= 8, "the sample covers every generated event");
  const forbidden = /bayar|pembayaran|bayar|checkout|pesanan|order|transaksi|reservation|reservasi|pasti pasti|terjamin|guaranteed/i;
  for (const row of created) {
    assert.doesNotMatch(String(row.body), forbidden, `body must not imply a commercial guarantee: ${row.body}`);
    assert.doesNotMatch(String(row.title), forbidden, `title must not imply a commercial guarantee: ${row.title}`);
  }
  await db.close();
});

// ---------------------------------------------------------------------------
// Preferences, realtime, RLS, failure isolation
// ---------------------------------------------------------------------------

test("preferences are honoured per category and the default (no row) stays ON", async () => {
  const db = await seedStandardWorld();
  await setPreference(db, ADMIN, "system", false);
  await setPreference(db, PRODUCER, "visit_experience", false);

  await fileApplication(db, APPLICANT);
  await createIntent(db, VISITOR, "vi-pref-1");

  const created = await notifications(db);
  const adminRows = created.filter((row) => row.user_id === ADMIN);
  assert.equal(adminRows.length, 0, "system OFF suppresses the Admin application alert");
  const producerRows = created.filter((row) => row.user_id === PRODUCER);
  assert.equal(producerRows.length, 0, "visit_experience OFF suppresses the Visit Intent alert");
  // The other recipients are untouched: the flag is per recipient.
  assert.equal(
    created.filter((row) => row.user_id === ADMIN_2 && row.event_type === "producer_application_submitted").length,
    1,
  );
  assert.equal(
    created.filter((row) => row.user_id === PRODUCER_2 && row.event_type === "visit_intent_created").length,
    1,
  );
  await db.close();
});

test("the mandatory safety/account category is never filtered by a preference", async () => {
  const db = await seedStandardWorld();
  // Even a hand-edited row that turns the mandatory category off cannot make
  // notify_recipient skip a safety_account event.
  await db.exec(
    `insert into public.notification_preferences (user_id, system, visit_experience, safety_account)
     values ('${ADMIN}', false, false, false)`,
  );
  await db.query(`select public.notify_recipient($1::uuid, 'safety_account', 'account_notice', 'Judul', 'Isi.')`, [ADMIN]);
  const created = (await notifications(db)).filter((row) => row.user_id === ADMIN);
  assert.equal(created.length, 1, "a mandatory category is written regardless of a stored OFF value");
  await db.close();
});

test("the realtime unread signal goes to the recipient's own topic on insert and on read", async () => {
  const db = await seedStandardWorld();
  await fileApplication(db, APPLICANT);

  let sent = await broadcasts(db);
  const adminSignals = sent.filter((row) => row.topic === `notifications:${ADMIN}`);
  assert.equal(adminSignals.length, 1, "the recipient's own topic is signalled");
  assert.ok(
    !sent.some((row) => row.topic === `notifications:${VISITOR}`),
    "no signal is sent to an account that received nothing",
  );
  assert.equal(adminSignals[0].event, "unread");
  assert.equal((adminSignals[0].payload as Record<string, unknown>).unreadCount, 1);

  // A second moderator also has exactly one signal, on their own topic.
  assert.equal(sent.filter((row) => row.topic === `notifications:${ADMIN_2}`).length, 1);

  // Marking it read emits a second signal with the decremented count.
  await db.exec(`update public.notifications set read_at = now() where user_id = '${ADMIN}'`);
  sent = await broadcasts(db);
  const afterRead = sent.filter((row) => row.topic === `notifications:${ADMIN}`);
  assert.equal(afterRead.length, 2, "mark-as-read also refreshes the badge");
  assert.equal((afterRead[1].payload as Record<string, unknown>).unreadCount, 0);

  // A deduplicated duplicate sends no extra signal.
  await assert.rejects(() => fileApplication(db, APPLICANT), /application_already_active/);
  await db.query(`update public.producer_applications set note = note`);
  sent = await broadcasts(db);
  assert.equal(sent.filter((row) => row.topic === `notifications:${ADMIN}`).length, 2, "no duplicate signal");
  await db.close();
});

test("realtime is recipient-scoped under a real authenticated session (RLS)", async () => {
  const db = await seedStandardWorld();
  await fileApplication(db, APPLICANT);

  await actAs(db, ADMIN);
  const enforced = await rows(db, `select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass`);
  assert.equal(enforced[0].relrowsecurity, true, "realtime.messages must keep RLS enabled");

  // The gate itself: for a given candidate topic, the policy expression decides
  // whether this session may receive on it. (In Supabase Realtime the policy is
  // evaluated against the topic the session joined, so this is the same check
  // the platform performs before delivering a message.)
  const gate = async (candidate: string) =>
    (await rows(db, `select ($1::text = 'notifications:' || auth.uid()::text) as allowed`, [candidate]))[0].allowed;

  assert.equal(await gate(`notifications:${ADMIN}`), true, "a session may receive on its OWN topic");
  assert.equal(
    await gate(`notifications:${ADMIN_2}`),
    false,
    "an Admin can never join another account's notification topic",
  );

  await actAs(db, OUTSIDER);
  assert.equal(
    await gate(`notifications:${ADMIN}`),
    false,
    "an account with no notification is denied every other account's topic",
  );
  assert.equal(await gate(`notifications:${OUTSIDER}`), true, "and may still join its own (empty) topic");
  await db.close();
});

test("notifications stay recipient-scoped for clients (RLS + read_at-only update)", async () => {
  const db = await seedStandardWorld();
  await fileApplication(db, APPLICANT);
  await createIntent(db, VISITOR, "vi-rls-1");

  await actAs(db, PRODUCER);
  const visible = await rows(db, "select user_id, event_type from public.notifications order by event_type");
  assert.deepEqual(
    visible.map((row) => `${row.user_id}:${row.event_type}`),
    [`${PRODUCER}:visit_intent_created`],
    "a Producer session sees only its own notifications, never the Admin's or the other Producer's",
  );

  await actAs(db, PRODUCER_2);
  const other = await rows(db, "select user_id from public.notifications");
  assert.deepEqual(
    other.map((row) => String(row.user_id)),
    [PRODUCER_2],
    "the second Producer sees only their own row",
  );
  await actAs(db, ADMIN);
  const adminView = await rows(db, "select user_id, event_type from public.notifications");
  assert.deepEqual(
    adminView.map((row) => `${row.user_id}:${row.event_type}`),
    [`${ADMIN}:producer_application_submitted`],
    "an Admin session never reads a Producer's or another Admin's inbox",
  );
  await actAsActor(db, PRODUCER);
  await db.exec("set role authenticated;");

  // read_at is the only column a recipient may change.
  const own = (await rows(db, "select id from public.notifications limit 1"))[0];
  await db.query(`update public.notifications set read_at = now() where id = $1`, [own.id]);
  const still = await rows(db, "select read_at from public.notifications where id = $1", [own.id]);
  assert.ok(still[0].read_at, "the recipient can mark their own notification read");
  await assert.rejects(
    () => db.query(`update public.notifications set title = 'X' where id = $1`, [own.id]),
    /read_at|permission|denied/i,
    "no other column is client-writable",
  );
  await db.close();
});

test("a notification failure never rolls back the valid business change (MASTER 10 §17)", async () => {
  const db = await seedStandardWorld();
  // Simulate a broken notification write while the business path is healthy.
  await db.exec(`
    create or replace function public.block_notifications() returns trigger
    language plpgsql as $$
    begin
      raise exception 'notification_store_unavailable';
    end;
    $$;
    create trigger notifications_block before insert on public.notifications
    for each row execute procedure public.block_notifications();
  `);

  await createIntent(db, VISITOR, "vi-resilient-1");
  await setIntentStatus(db, "vi-resilient-1", "accepted", "ok");
  await fileApplication(db, APPLICANT);
  const applicationId = String((await rows(db, "select id from public.producer_applications"))[0].id);
  await reviewApplication(db, applicationId, PLACE);

  const intent = await rows(db, "select status from public.visit_intents where id = 'vi-resilient-1'");
  assert.equal(intent[0].status, "accepted", "the Visit Intent decision is committed");
  const application = await rows(db, "select status from public.producer_applications where id = $1", [applicationId]);
  assert.equal(application[0].status, "approved", "the Producer approval is committed");
  const membership = await rows(db, "select user_id from public.producer_memberships where place_id = $1 and user_id = $2", [
    PLACE,
    APPLICANT,
  ]);
  assert.equal(membership.length, 1, "ownership activation is committed");
  assert.equal((await notifications(db)).length, 0, "no notification row could be written");
  await db.close();
});

test("the 0026 Live-started fan-out keeps working unchanged next to the new events", async () => {
  const db = await seedStandardWorld();
  await seedUser(db, OUTSIDER);
  await db.exec(
    `insert into public.producers (id, display_name) values ('prod-demo-live', 'Producer Demo') on conflict do nothing`,
  );
  await db.exec(`update public.places set producer_id = 'prod-demo-live' where id = '${PLACE}'`);
  await db.exec(
    `insert into public.production_stages (id, place_id, title, description, sort_order, status)
     values ('stage-notify', '${PLACE}', 'Panen', 'Deskripsi tahap produksi.', 90, 'published')
     on conflict (id) do nothing`,
  );
  await db.exec(`insert into public.place_follows (user_id, place_id) values ('${OUTSIDER}', '${PLACE}') on conflict do nothing`);

  await db.exec(
    `insert into public.live_sessions (id, place_id, producer_id, stage_id, status, idempotency_key)
     select 'live-notify-1', '${PLACE}', p.producer_id, ps.id, 'live', 'idem-live-notify-1'
     from public.places p join public.production_stages ps on ps.place_id = p.id
     where p.id = '${PLACE}' order by ps.id limit 1`,
  );

  const live = (await notifications(db)).filter((row) => row.event_type === "live_started_followed_place");
  assert.equal(live.length, 1, "the existing Live path is untouched");
  assert.equal(live[0].user_id, OUTSIDER);
  assert.equal(live[0].category, "live_place");
  assert.equal(live[0].title, "Lihat Live Sekarang");
  assert.equal(
    (await broadcasts(db)).filter((row) => row.topic === `notifications:${OUTSIDER}`).length,
    1,
    "the follower is now also signalled live through the shared unread topic",
  );
  await db.close();
});
