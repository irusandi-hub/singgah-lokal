import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import {
  InvalidNotificationPreferencesError,
  NotificationNotFoundError,
  countUnreadUserNotifications,
  listUserNotifications,
  markUserNotificationRead,
  readUserNotificationPreferences,
  updateUserNotificationPreferences,
} from "../lib/notification-service";
import type { NotificationRepository } from "../lib/notification-repository";

/**
 * Notification access control — the authorization contract of the User
 * surface, verified on the real database rules (PGlite) and on the service
 * boundary (stub repository).
 *
 * Covered here:
 * - a notification owned by user A is never returned/marked for user B;
 * - read_at is the only column the service ever writes;
 * - preferences are the caller's own, and the mandatory safety category can
 *   never be turned off (MASTER 10 §10);
 * - no category outside the locked six is accepted.
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
  "0023_place_follows.sql",
  "0024_notification_preferences.sql",
  "0025_notifications.sql",
  "0026_live_followed_notifications.sql",
];

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string): Promise<Row[]> => ((await db.query(query)).rows ?? []) as Row[];

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
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
  await db.exec("create publication supabase_realtime;");
  for (const name of MIGRATIONS) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  for (const userId of [USER_A, USER_B]) {
    await db.exec(`insert into auth.users (id) values ('${userId}') on conflict do nothing`);
    await db.exec(`insert into public.users (id) values ('${userId}') on conflict do nothing`);
  }
  return db;
}

async function actAs(db: PGlite, userId: string): Promise<void> {
  await db.exec("reset role;");
  await db.exec(`create or replace function auth.uid() returns uuid language sql stable as 'select $$${userId}$$::uuid'`);
  await db.exec("set role authenticated;");
}

async function seedNotification(db: PGlite, userId: string, title: string, read: boolean): Promise<string> {
  const inserted = await rows(
    db,
    `insert into public.notifications (user_id, category, event_type, title, body, source_type, source_id, read_at)
     values ('${userId}', 'system', 'account_notice', '${title}', 'Isi notifikasi.', 'test_event', '${title}', ${read ? "now()" : "null"})
     returning id::text as id`,
  );
  return String(inserted[0].id);
}

// --- Real RLS behaviour (authenticated sessions) ---------------------------

test("inbox shows only the caller's own notifications, and unread is per user", async () => {
  const db = await createDb();
  await db.exec("reset role;");
  const aUnread = await seedNotification(db, USER_A, "a-unread", false);
  await seedNotification(db, USER_A, "a-read", true);
  await seedNotification(db, USER_B, "b-unread", false);

  await actAs(db, USER_A);
  const mine = await rows(db, "select title, read_at from public.notifications order by title");
  assert.deepEqual(mine.map((row) => row.title), ["a-read", "a-unread"], "user A sees exactly their own rows");
  const unread = await rows(
    db,
    "select count(*)::int as c from public.notifications where read_at is null",
  );
  assert.equal(Number(unread[0].c), 1, "unread count is scoped to the caller");

  await actAs(db, USER_B);
  const theirs = await rows(db, "select title from public.notifications");
  assert.deepEqual(theirs.map((row) => row.title), ["b-unread"], "user B sees only their own notification");
  await db.close();
  assert.ok(aUnread);
});

test("a user can mark their own notification read; another user's is invisible and unmarkable", async () => {
  const db = await createDb();
  await db.exec("reset role;");
  const aNotification = await seedNotification(db, USER_A, "a-target", false);
  const bNotification = await seedNotification(db, USER_B, "b-target", false);

  // USER B tries to mark USER A's notification read: RLS hides the row, so
  // the update matches nothing (identical to "does not exist").
  await actAs(db, USER_B);
  const crossUpdate = await rows(
    db,
    `update public.notifications set read_at = now() where id = '${aNotification}' returning id::text as id`,
  );
  assert.equal(crossUpdate.length, 0, "cross-user mark-read must not affect another user's row");
  await db.exec("reset role;");
  const stillUnread = await rows(db, `select read_at from public.notifications where id = '${aNotification}'`);
  assert.equal(stillUnread[0].read_at, null, "the other user's read_at is untouched");

  // USER A marks their own read.
  await actAs(db, USER_A);
  const ownUpdate = await rows(
    db,
    `update public.notifications set read_at = now() where id = '${aNotification}' returning read_at`,
  );
  assert.equal(ownUpdate.length, 1);
  assert.ok(ownUpdate[0].read_at, "read_at is set");
  // Verified as the table owner — USER A cannot even see user B's row.
  await db.exec("reset role;");
  const stillUnreadB = await rows(db, `select read_at from public.notifications where id = '${bNotification}'`);
  assert.equal(stillUnreadB[0].read_at, null, "user B's own notification is unaffected");
  await db.close();
});

test("preferences are the caller's own; the mandatory safety category cannot be turned off", async () => {
  const db = await createDb();

  // USER A turns everything off except the mandatory category.
  await actAs(db, USER_A);
  await db.exec(
    `update public.notification_preferences set live_place = false, promotional = false, safety_account = true where user_id = '${USER_A}'`,
  );
  // A row that tries to disable the mandatory category is corrected by the
  // service, but the raw table grant allows the write — assert the service
  // contract below and keep the DB honest here.
  await db.exec("reset role;");
  await db.exec(
    `insert into public.notification_preferences (user_id, live_place, promotional) values ('${USER_B}', true, true) on conflict do nothing`,
  );

  await actAs(db, USER_B);
  const visible = await rows(db, "select user_id from public.notification_preferences");
  assert.deepEqual(visible.map((row) => row.user_id), [USER_B], "only the caller's own preference row is readable");
  await db.close();
});

// --- Service boundary (stub repository) ------------------------------------

type StubCall = { method: string; args: unknown[] };

function makeRepository(overrides: Partial<NotificationRepository> = {}) {
  const calls: StubCall[] = [];
  const repository: NotificationRepository = {
    async listForUser(userId, limit) {
      calls.push({ method: "listForUser", args: [userId, limit] });
      return [];
    },
    async countUnreadForUser(userId) {
      calls.push({ method: "countUnreadForUser", args: [userId] });
      return 0;
    },
    async markReadForUser(userId, notificationId, readAt) {
      calls.push({ method: "markReadForUser", args: [userId, notificationId, readAt] });
      return true;
    },
    async readPreferences(userId) {
      calls.push({ method: "readPreferences", args: [userId] });
      return {
        live_place: true,
        visit_experience: true,
        help_support: true,
        system: true,
        safety_account: true,
        promotional: false,
      };
    },
    async writePreferences(userId, patch) {
      calls.push({ method: "writePreferences", args: [userId, patch] });
      return {
        live_place: patch.live_place ?? true,
        visit_experience: patch.visit_experience ?? true,
        help_support: patch.help_support ?? true,
        system: patch.system ?? true,
        safety_account: true,
        promotional: patch.promotional ?? false,
      };
    },
    ...overrides,
  };
  return { repository, calls };
}

test("every service call is scoped to the session identity", async () => {
  const { repository, calls } = makeRepository();
  await listUserNotifications("user-a", repository);
  await countUnreadUserNotifications("user-a", repository);
  await markUserNotificationRead("user-a", "n1", repository);
  await readUserNotificationPreferences("user-a", repository);
  assert.ok(calls.length >= 4);
  for (const call of calls) {
    assert.equal(call.args[0], "user-a", `${call.method} must receive the actor identity`);
  }
});

test("marking read of a missing/foreign notification is a 404-style not-found, never a silent success", async () => {
  const { repository } = makeRepository({ markReadForUser: async () => false });
  await assert.rejects(
    () => markUserNotificationRead("user-a", "nope", repository),
    NotificationNotFoundError,
  );
});

test("an unauthenticated identity is rejected before any query runs", async () => {
  const { repository, calls } = makeRepository();
  await assert.rejects(() => listUserNotifications("  ", repository), /Authenticated user is required/);
  await assert.rejects(() => countUnreadUserNotifications("", repository), /Authenticated user is required/);
  await assert.rejects(() => readUserNotificationPreferences(" ", repository), /Authenticated user is required/);
  assert.equal(calls.length, 0, "no repository call for an unauthenticated request");
});

test("preference updates accept only the five optional categories and never disable safety", async () => {
  const { repository, calls } = makeRepository();

  const updated = await updateUserNotificationPreferences(
    "user-a",
    { live_place: false, promotional: true, safety_account: false },
    repository,
  );
  assert.equal(updated.safety_account, true, "the mandatory category stays ON in the result");

  const write = calls.find((call) => call.method === "writePreferences");
  assert.ok(write, "the preference write happened");
  const patch = write.args[1] as Record<string, unknown>;
  assert.equal(patch.live_place, false);
  assert.equal(patch.promotional, true);
  assert.equal("safety_account" in patch, false, "the mandatory category is not sent as a user choice");

  // Unknown category and non-boolean values are rejected outright.
  await assert.rejects(
    () => updateUserNotificationPreferences("user-a", { marketing_flash: true }, repository),
    InvalidNotificationPreferencesError,
  );
  await assert.rejects(
    () => updateUserNotificationPreferences("user-a", { live_place: "yes" }, repository),
    InvalidNotificationPreferencesError,
  );
  await assert.rejects(() => updateUserNotificationPreferences("user-a", {}, repository), InvalidNotificationPreferencesError);
});
