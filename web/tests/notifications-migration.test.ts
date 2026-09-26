import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * Migration 0025 — notifications schema + RLS regression.
 *
 * The migration chain (0001→0007 foundations, 0023→0024 notification
 * foundations) is applied on a real Postgres engine (PGlite), then the
 * contract is exercised against the actual policies/grants/triggers:
 * - migration applies cleanly after 0024 on the real chain;
 * - owner read works; cross-user read is blocked;
 * - the recipient can change ONLY read_at (mark read/unread);
 * - ownership/content/identity changes are rejected for the client;
 * - client INSERT/DELETE is impossible (server-side creation only);
 * - anon is denied entirely;
 * - the four locked indexes exist;
 * - validation: blank event_type/title/body and unpaired source columns
 *   are rejected.
 */

const MIGRATION_DIR = "../supabase/migrations/";

const readMigration = (name: string) => readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");

const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

const DEPENDENCY_MIGRATIONS = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0023_place_follows.sql",
  "0024_notification_preferences.sql",
];

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const PLACE_ID = "kopi-dari-kebun"; // seeded by 0001

type Row = Record<string, unknown>;

const rows = async (db: PGlite, query: string): Promise<Row[]> => ((await db.query(query)).rows ?? []) as Row[];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  // Supabase environment shims (harness-only, same pattern as
  // live-migration-validity.test.ts).
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as 'select null::uuid';
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_admin;
    create role authenticator;
  `);
  for (const name of DEPENDENCY_MIGRATIONS) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  await db.exec(stripPgcrypto(readMigration("0025_notifications.sql")));
  return db;
}

async function seedUser(db: PGlite, userId: string): Promise<void> {
  await db.exec(`insert into auth.users (id) values ('${userId}') on conflict do nothing;`);
  await db.exec(`insert into public.users (id) values ('${userId}') on conflict do nothing;`);
}

async function setAuthUid(db: PGlite, userId: string | null): Promise<void> {
  // Function redefinition must run as the superuser — after `set role`
  // the authenticated role cannot create functions in the auth schema.
  await db.exec("reset role;");
  if (userId) {
    await db.exec(`create or replace function auth.uid() returns uuid language sql stable as 'select $$${userId}$$::uuid';`);
  } else {
    await db.exec(`create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';`);
  }
  await db.exec("set role authenticated;");
}

async function setRole(db: PGlite, role: "anon" | "authenticated"): Promise<void> {
  await db.exec(`set role ${role};`);
}

/** Insert one notification as the server (owner). */
async function insertNotification(db: PGlite, userId: string, overrides: Row = {}): Promise<Row> {
  const values: Row = {
    user_id: userId,
    category: "live_place",
    event_type: "live_session_started",
    title: "Place Live dimulai",
    body: "Proses produksi sedang berlangsung.",
    ...overrides,
  };
  const columns = Object.keys(values);
  const params = columns.map((column) => values[column]);
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  const created = await db.query(
    `insert into public.notifications (${columns.join(", ")}) values (${placeholders}) returning *`,
    params,
  );
  return (created.rows ?? [])[0] as Row;
}

test("0025 applies cleanly after 0024 on the real migration chain with the locked shape", async () => {
  const db = await createDb();

  const columns = await rows(
    db,
    `select column_name, is_nullable, column_default from information_schema.columns
     where table_schema='public' and table_name='notifications' order by ordinal_position`,
  );
  assert.deepEqual(
    columns.map((row) => row.column_name),
    [
      "id", "user_id", "category", "event_type", "title", "body",
      "place_id", "source_type", "source_id", "metadata", "read_at", "created_at",
    ],
    "column set is locked by the task spec",
  );
  const defaults = new Map(columns.map((row) => [row.column_name, row.column_default]));
  assert.match(String(defaults.get("id")), /gen_random_uuid/, "id must default to gen_random_uuid()");
  assert.equal(defaults.get("metadata"), "'{}'::jsonb", "metadata must default to empty object");
  assert.equal(defaults.get("read_at"), null, "read_at must be nullable with no default");

  // Exactly the four locked indexes (plus the PK index, which is not one of
  // them).
  const indexes = await rows(
    db,
    `select indexname from pg_indexes where schemaname='public' and tablename='notifications' and indexname like 'notifications_%' order by indexname`,
  );
  assert.deepEqual(
    indexes.map((row) => row.indexname),
    [
      "notifications_pkey",
      "notifications_place_created_idx",
      "notifications_user_category_created_idx",
      "notifications_user_created_idx",
      "notifications_user_unread_idx",
    ],
  );
  const unreadIndex = await rows(
    db,
    `select indexdef from pg_indexes where schemaname='public' and indexname='notifications_user_unread_idx'`,
  );
  assert.match(String(unreadIndex[0].indexdef), /where \(read_at is null\)/i, "unread index must be partial");
  const placeIndex = await rows(
    db,
    `select indexdef from pg_indexes where schemaname='public' and indexname='notifications_place_created_idx'`,
  );
  assert.match(String(placeIndex[0].indexdef), /where \(place_id is not null\)/i, "place index must be partial");

  // RLS enabled with exactly the two client policies.
  const policies = await rows(
    db,
    `select policyname, cmd from pg_policies where schemaname='public' and tablename='notifications' order by policyname`,
  );
  assert.deepEqual(
    policies.map((row) => `${row.policyname}:${row.cmd}`),
    ["notifications_self_read:SELECT", "notifications_self_update_read_at:UPDATE"],
    "exactly the owner read + read_at update policies must exist (no INSERT/DELETE policy)",
  );

  // anon holds NO grants; authenticated holds SELECT + read_at UPDATE only
  // (UPDATE is column-scoped, so table-level grants list only SELECT).
  const grants = await rows(
    db,
    `select grantee, privilege_type from information_schema.role_table_grants
     where table_schema='public' and table_name='notifications' and grantee in ('anon','authenticated') order by 1,2`,
  );
  assert.deepEqual(
    grants.map((row) => `${row.grantee}:${row.privilege_type}`),
    ["authenticated:SELECT"],
    "anon holds nothing; authenticated's only table-level grant is SELECT",
  );
  const updateColumns = await rows(
    db,
    `select column_name from information_schema.column_privileges
     where table_schema='public' and table_name='notifications' and grantee='authenticated' and privilege_type='UPDATE' order by 1`,
  );
  assert.deepEqual(updateColumns.map((row) => row.column_name), ["read_at"], "client UPDATE is restricted to read_at");

  // The client-update guard trigger exists.
  const trigger = await rows(
    db,
    `select tgname from pg_trigger where tgname='notifications_client_update_guard' and not tgisinternal`,
  );
  assert.equal(trigger.length, 1, "read_at-only guard trigger must exist");

  await db.close();
});

test("server-side creation works with defaults, category enum, and paired source validation", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await db.exec("reset role;"); // service-role-like server context (table owner)

  // Full insert with explicit source pair + place reference.
  const created = await insertNotification(db, USER_A, {
    category: "safety_account",
    event_type: "account_security_alert",
    source_type: "security_event",
    source_id: "evt-123",
    place_id: PLACE_ID,
    metadata: { reason: "password_change" },
  });
  assert.ok(created.id);
  assert.equal(created.read_at, null, "notifications start unread");
  assert.deepEqual(created.metadata, { reason: "password_change" });

  // The paired-source check: source_id without source_type is rejected.
  await assert.rejects(
    () => insertNotification(db, USER_A, { source_id: "evt-456" }),
    /source|check/i,
    "source_id without source_type must be rejected",
  );
  await assert.rejects(
    () => insertNotification(db, USER_A, { source_type: "security_event" }),
    /source|check/i,
    "source_type without source_id must be rejected",
  );

  // Blank event_type/title/body are rejected.
  await assert.rejects(() => insertNotification(db, USER_A, { event_type: "   " }), /check/i);
  await assert.rejects(() => insertNotification(db, USER_A, { title: "" }), /check/i);
  await assert.rejects(() => insertNotification(db, USER_A, { body: " " }), /check/i);

  // Category is a closed enum.
  await assert.rejects(
    () => insertNotification(db, USER_A, { category: "marketing_flash" }),
    /check/i,
    "no new category may be invented",
  );

  await db.close();
});

test("recipient reads their own notifications only (owner read pass, cross-user blocked)", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await seedUser(db, USER_B);
  await db.exec("reset role;");
  await insertNotification(db, USER_A, { event_type: "a_one" });
  await insertNotification(db, USER_B, { event_type: "b_one" });
  await insertNotification(db, USER_B, { event_type: "b_two" });

  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");
  const own = await rows(db, "select event_type from public.notifications order by event_type");
  assert.deepEqual(own.map((row) => row.event_type), ["a_one"], "user A sees only their own notification");

  await setAuthUid(db, USER_B);
  const bOwn = await rows(db, "select event_type from public.notifications order by event_type");
  assert.deepEqual(bOwn.map((row) => row.event_type), ["b_one", "b_two"], "user B sees only their own notifications");
  await db.close();
});

test("recipient can change only read_at; ownership/content changes are rejected", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await db.exec("reset role;");
  const notification = await insertNotification(db, USER_A, {
    title: "Judul awal",
    place_id: PLACE_ID,
    source_type: "live_session",
    source_id: "ls-1",
  });
  const id = String(notification.id);

  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");

  // Mark read: allowed, and read_at is set server-side to now().
  const marked = await rows(db, `update public.notifications set read_at = now() where id = '${id}' returning read_at`);
  assert.equal(marked.length, 1);
  assert.ok(marked[0].read_at, "read_at is set when marking read");

  // Mark unread again: allowed (read_at -> null).
  const unmarked = await rows(db, `update public.notifications set read_at = null where id = '${id}' returning read_at`);
  assert.equal(unmarked.length, 1);
  assert.equal(unmarked[0].read_at, null);

  // Content changes are rejected — the column grant (ACL) blocks non-read_at
  // columns outright, and the guard trigger is the second layer.
  for (const attempt of [
    `update public.notifications set title = 'Rusak' where id = '${id}'`,
    `update public.notifications set body = 'Rusak' where id = '${id}'`,
    `update public.notifications set event_type = 'hijacked' where id = '${id}'`,
    `update public.notifications set category = 'system' where id = '${id}'`,
    `update public.notifications set metadata = '{"hacked": true}' where id = '${id}'`,
    `update public.notifications set place_id = null where id = '${id}'`,
    `update public.notifications set source_type = null, source_id = null where id = '${id}'`,
    `update public.notifications set created_at = now() - interval '1 day' where id = '${id}'`,
    `update public.notifications set user_id = '${USER_B}' where id = '${id}'`,
  ]) {
    await assert.rejects(
      () => db.query(attempt),
      /permission denied|read_at changes by the recipient/i,
      `rejected: ${attempt}`,
    );
  }

  // Ownership transfer is rejected for the client (cross-user path: USER B
  // cannot even address the row, and the identity guard would reject it too).
  await setAuthUid(db, USER_B);
  const bView = await rows(db, `select id from public.notifications where id = '${id}'`);
  assert.equal(bView.length, 0, "USER B cannot see the notification to update it");

  // The original content survives untouched.
  await db.exec("reset role;");
  const intact = await rows(db, `select title, body, event_type, category from public.notifications where id = '${id}'`);
  assert.deepEqual(
    { title: intact[0].title, body: intact[0].body, event_type: intact[0].event_type, category: intact[0].category },
    { title: "Judul awal", body: "Proses produksi sedang berlangsung.", event_type: "live_session_started", category: "live_place" },
    "all content must be unchanged after rejected attempts",
  );
  await db.close();
});

test("client cannot INSERT or DELETE notifications (server-side creation only)", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await db.exec("reset role;");
  const notification = await insertNotification(db, USER_A);
  const id = String(notification.id);

  await setAuthUid(db, USER_A);
  await setRole(db, "authenticated");

  await assert.rejects(
    () =>
      db.query(
        `insert into public.notifications (user_id, category, event_type, title, body) values ('${USER_A}', 'system', 'x', 'x', 'x')`,
      ),
    /permission denied/i,
    "INSERT must stay server-side (no client grant/policy)",
  );
  await assert.rejects(
    () => db.query(`delete from public.notifications where id = '${id}'`),
    /permission denied/i,
    "DELETE must stay server-side (no client grant/policy)",
  );

  await db.exec("reset role;");
  const remaining = await rows(db, "select id from public.notifications");
  assert.equal(remaining.length, 1, "the notification survives client deletion attempts");
  await db.close();
});

test("anon is denied entirely (no grant, no policy)", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await db.exec("reset role;");
  await insertNotification(db, USER_A);

  await db.exec("set role anon;");
  await assert.rejects(
    () => db.query("select id from public.notifications"),
    /permission denied|row-level security/i,
    "anon must not read notifications",
  );
  await db.close();
});

test("on delete cascade of a user removes their notifications (referential integrity)", async () => {
  const db = await createDb();
  await seedUser(db, USER_A);
  await db.exec("reset role;");
  await insertNotification(db, USER_A);
  await db.exec(`delete from public.users where id = '${USER_A}'`);
  const remaining = await rows(db, "select id from public.notifications");
  assert.equal(remaining.length, 0, "notifications follow the recipient account lifecycle");
  await db.close();
});
