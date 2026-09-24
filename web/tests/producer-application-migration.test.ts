import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * Engine-level regression for migration 0016 (Producer Application).
 *
 * The producer-identity tests guard the migration's text; this harness
 * executes the SQL on a real Postgres engine (PGlite) after the foundation
 * chain so the locked identity behavior is proven semantically, not just
 * lexically:
 * - submit refuses duplicate active applications;
 * - approval activates producer_memberships for the APPLICANT's user_id;
 * - no auth user is ever created and anon/authenticated hold no rights;
 * - a rejected application can be refiled under the same user_id.
 */

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

// Same harness shims as live-migration-validity.test.ts: objects that exist on
// Supabase but not on stock Postgres/PGlite. Migration files are not modified.
const SHIMS = `
  create schema if not exists auth;
  create table auth.users (id uuid primary key, email_confirmed_at timestamptz);
  create function auth.uid() returns uuid language sql stable as 'select null::uuid';
  create role anon;
  create role authenticated;
  create role service_role;
  create role supabase_admin;
  create role authenticator;
`;

const stripPgcrypto = (s: string) =>
  s.replace(/create extension if not exists pgcrypto;?/gim, "");

// 0016's tables/RPCs depend only on the 0001 foundation (users, producers,
// places, producer_memberships). 0002–0005 harden RLS on those tables and are
// applied too so the chain matches the real DEV environment. 0006–0007 (story)
// and the Live chain are out of scope for this harness.
const FOUNDATION = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
] as const;

async function bootstrapDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIMS);
  await db.exec("create publication supabase_realtime;");
  for (const name of FOUNDATION) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  await db.exec(stripPgcrypto(readMigration("0016_producer_applications.sql")));
  // 0017 replaces the submit RPC (refile-after-rejection fix); apply it too so
  // the harness always tests the current contract.
  await db.exec(stripPgcrypto(readMigration("0017_producer_application_refile.sql")));
  return db;
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Seed one auth user (+ public.users row via the 0001 trigger), one producer,
// and one place, then return their ids.
async function seed(db: PGlite, n: number): Promise<{ userId: string; producerId: string; placeId: string }> {
  const userId = uuid(n);
  const producerId = `producer-${n}`;
  const placeId = `place-${n}`;
  await db.exec(`
    insert into auth.users (id, email_confirmed_at) values ('${userId}', now());
    insert into public.producers (id, display_name) values ('${producerId}', 'Producer ${n}');
    insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id)
    values ('${placeId}', 'Place ${n}', 'desc', 'craft', 'production', 'Yogyakarta', 'Asia/Jakarta', 'IDR', '${producerId}');
  `);
  return { userId, producerId, placeId };
}

test("0016 applies cleanly after the foundation chain and locks client access", async () => {
  const db = await bootstrapDb();
  try {
    const rows = async (query: string) =>
      ((await db.query(query)).rows ?? []) as Record<string, unknown>[];

    const rls = (
      await rows("select rowsecurity from pg_tables where schemaname='public' and tablename='producer_applications'")
    )[0];
    assert.equal(rls?.rowsecurity, true, "RLS must be enabled on producer_applications");

    // No policies at all: fail-closed for every non-service caller.
    const policies = await rows(
      "select policyname from pg_policies where schemaname='public' and tablename='producer_applications'",
    );
    assert.equal(policies.length, 0, "producer_applications must have zero RLS policies");

    // anon/authenticated hold no table privileges.
    const grants = await rows(
      `select r.rolname, g.privilege_type
       from information_schema.role_table_grants g
       join pg_roles r on r.rolname = g.grantee
       where g.table_schema='public' and g.table_name='producer_applications'`,
    );
    const loginRoles = grants.map((g) => String(g.rolname));
    assert.ok(!loginRoles.includes("anon") && !loginRoles.includes("authenticated"),
      `anon/authenticated must hold no grants (got ${loginRoles.join(", ")})`);

    // The submit RPC (0017) is also revoked from every client role.
    const submitGrantees = await rows(
      `select r.rolname from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
       aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl join pg_roles r on r.oid=acl.grantee
       where n.nspname='public' and p.proname='submit_producer_application' and acl.privilege_type='EXECUTE'`,
    );
    const submitRoles = submitGrantees.map((g) => String(g.rolname));
    assert.ok(!submitRoles.includes("public") && !submitRoles.includes("anon") && !submitRoles.includes("authenticated"),
      `submit RPC must be revoked from clients (got ${submitRoles.join(", ")})`);
  } finally {
    await db.close();
  }
});

test("submit_producer_application files under the account's user_id and refuses duplicates", async () => {
  const db = await bootstrapDb();
  try {
    const { userId } = await seed(db, 1);

    await db.query("select public.submit_producer_application($1, $2, $3)", [
      userId,
      "producer-1@example.com",
      "catatan",
    ]);

    const rows = ((await db.query("select user_id, status, contact_email from public.producer_applications"))
      .rows ?? []) as { user_id: string; status: string; contact_email: string | null }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, userId, "application row is keyed by the submitted user_id");
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].contact_email, "producer-1@example.com", "email is a snapshot only");

    // Duplicate active application must be refused (idempotency guard).
    await assert.rejects(
      () => db.query("select public.submit_producer_application($1, $2, $3)", [userId, "again@example.com", null]),
      /application_already_active/,
    );

    // Exactly one row remains — the refusal did not insert anything.
    let ids = ((await db.query("select user_id from public.producer_applications")).rows ?? []) as {
      user_id: string;
    }[];
    assert.equal(ids.length, 1);

    // A different account may file its own application.
    const other = await seed(db, 2);
    await db.query("select public.submit_producer_application($1, $2, $3)", [
      other.userId,
      "producer-2@example.com",
      null,
    ]);
    ids = ((await db.query("select user_id from public.producer_applications")).rows ?? []) as {
      user_id: string;
    }[];
    assert.equal(ids.length, 2, "each account holds its own application row");
  } finally {
    await db.close();
  }
});

test("approve_producer_application activates membership for the APPLICANT user_id — no auth user created", async () => {
  const db = await bootstrapDb();
  try {
    const { userId, producerId, placeId } = await seed(db, 3);
    await db.query("select public.submit_producer_application($1, $2, $3)", [userId, "p3@example.com", null]);

    const authUsersBefore = (((await db.query("select count(*)::int as c from auth.users")).rows ??
      []) as { c: number }[])[0].c;

    // Approve via the server-side RPC contract used by the admin API.
    const app = (((await db.query("select id from public.producer_applications where user_id = $1", [userId]))
      .rows ?? []) as { id: string }[])[0];
    await db.query("select public.approve_producer_application($1, $2, $3, $4)", [
      app.id,
      producerId,
      placeId,
      "owner",
    ]);

    // The membership belongs to the APPLICANT's user_id (same account).
    const memberships = ((await db.query(
      "select user_id, producer_id, place_id, role from public.producer_memberships",
    )).rows ?? []) as { user_id: string; producer_id: string; place_id: string; role: string }[];
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0].user_id, userId, "membership user_id must equal the applicant's user_id");
    assert.equal(memberships[0].producer_id, producerId);
    assert.equal(memberships[0].place_id, placeId);
    assert.equal(memberships[0].role, "owner");

    const application = (((await db.query(
      "select status, reviewed_at from public.producer_applications where user_id = $1",
      [userId],
    )).rows ?? []) as { status: string; reviewed_at: string | null }[])[0];
    assert.equal(application.status, "approved");
    assert.ok(application.reviewed_at !== null, "reviewed_at must be stamped on approval");

    // Approval is single-use: replay must fail and change nothing.
    await assert.rejects(
      () =>
        db.query("select public.approve_producer_application($1, $2, $3, $4)", [
          app.id,
          producerId,
          placeId,
          "owner",
        ]),
      /application_not_pending/,
    );

    // No new auth user was ever created by the flow.
    const authUsersAfter = (((await db.query("select count(*)::int as c from auth.users")).rows ??
      []) as { c: number }[])[0].c;
    assert.equal(authUsersAfter, authUsersBefore, "approval must not create an auth user");
    assert.equal(authUsersAfter, 1, "only the seeded applicant exists in auth.users");
  } finally {
    await db.close();
  }
});

test("approval is idempotent on membership and refile after rejection reuses the same user_id", async () => {
  const db = await bootstrapDb();
  try {
    const { userId, producerId, placeId } = await seed(db, 4);
    await db.query("select public.submit_producer_application($1, $2, $3)", [userId, "p4@example.com", null]);

    const app = (((await db.query("select id from public.producer_applications where user_id = $1", [userId]))
      .rows ?? []) as { id: string }[])[0];

    // Seed a pre-existing membership row; approval must upsert, not duplicate.
    await db.exec("insert into public.producers (id, display_name) values ('old-producer', 'Old Producer');");
    await db.exec(
      `insert into public.producer_memberships (user_id, producer_id, place_id, role)
       values ('${userId}', 'old-producer', '${placeId}', 'editor');`,
    );

    await db.query("select public.approve_producer_application($1, $2, $3, $4)", [
      app.id,
      producerId,
      placeId,
      "manager",
    ]);

    const memberships = ((await db.query(
      "select producer_id, role from public.producer_memberships where user_id = $1 and place_id = $2",
      [userId, placeId],
    )).rows ?? []) as { producer_id: string; role: string }[];
    assert.equal(memberships.length, 1, "membership stays one row per (user_id, place_id)");
    // The upsert only refreshes role — it must never hijack an existing
    // membership's producer binding (no producer takeover via approval).
    assert.equal(memberships[0].producer_id, "old-producer", "existing producer binding is preserved");
    assert.equal(memberships[0].role, "manager", "approval refreshes only the role");

    // Rejection path: a rejected application may be refiled for the same
    // account — the SAME row is reset to pending (user_id UNIQUE forbids a
    // second row; this is the regression guard for the refile fix).
    await db.exec(
      `update public.producer_applications set status = 'rejected', reviewed_at = now() where id = '${app.id}';`,
    );
    await db.query("select public.submit_producer_application($1, $2, $3)", [userId, "p4b@example.com", "refile"]);
    const row = (((await db.query(
      "select status, contact_email, note, reviewed_at from public.producer_applications where user_id = $1",
      [userId],
    )).rows ?? []) as { status: string; contact_email: string | null; note: string | null; reviewed_at: string | null }[])[0];
    assert.ok(row, "refiled application row exists");
    assert.equal(row.status, "pending", "refile resets the same row to pending");
    assert.equal(row.contact_email, "p4b@example.com", "refile refreshes the email snapshot");
    assert.equal(row.reviewed_at, null, "refile clears reviewed_at");
    const count = (((await db.query(
      "select count(*)::int as c from public.producer_applications where user_id = $1",
      [userId],
    )).rows ?? []) as { c: number }[])[0];
    assert.equal(count.c, 1, "exactly one application row per account, ever");
  } finally {
    await db.close();
  }
});
