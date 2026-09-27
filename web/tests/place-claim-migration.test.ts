import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * Security regression for migration 0028 — "Klaim Place yang Sudah Ada".
 *
 * These run on a real Postgres engine (PGlite) after the Place foundation
 * chain, so the locked rules are proven SEMANTICALLY, not by reading SQL:
 *
 *  1. An owned Place never appears in the claim list.
 *  2. An owned Place cannot be claimed by calling the API's RPC directly.
 *  3. An unowned Place can be claimed.
 *  4. A claim without proof of ownership is refused.
 *  5. Evidence is stored in a PRIVATE bucket with no client policy.
 *  6. Producer A cannot read Producer B's claim/evidence.
 *  7. A newly filed claim stays 'pending'.
 *  8. A pending claim grants NO ownership.
 *  9. A rejected claim grants NO ownership.
 * 10. Approval grants ownership exactly once.
 * 11. Duplicate/racing claims can never produce two ownerships.
 * 12. The existing Create Place flow still passes and its Places stay
 *     unclaimable.
 * 13. Existing Producer authorization / RLS is untouched by this migration.
 */

const readMigration = (name: string) =>
  readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");

// Same harness shims as the other engine-level tests: objects that exist on
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
  create schema if not exists storage;
  create table if not exists storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
  );
`;

const stripPgcrypto = (s: string) =>
  s.replace(/create extension if not exists pgcrypto;?/gim, "");

const FOUNDATION = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0020_one_membership_per_user.sql",
  "0022_allow_multiple_places_per_producer.sql",
] as const;

const CLAIM_MIGRATION = "0028_place_claims.sql";

async function bootstrapDb(options: { withClaim?: boolean } = {}): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SHIMS);
  await db.exec("create publication supabase_realtime;");
  for (const name of FOUNDATION) {
    await db.exec(stripPgcrypto(readMigration(name)));
  }
  if (options.withClaim) await db.exec(stripPgcrypto(readMigration(CLAIM_MIGRATION)));
  return db;
}

const bootstrapClaimDb = (): Promise<PGlite> => bootstrapDb({ withClaim: true });

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER_A = uuid(1);
const USER_B = uuid(2);

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string, params?: unknown[]): Promise<Row[]> => {
  const result = params ? await db.query(query, params as never[]) : await db.query(query);
  return (result.rows ?? []) as Row[];
};

async function seedUser(db: PGlite, userId: string): Promise<void> {
  await db.exec(`insert into auth.users (id, email_confirmed_at) values ('${userId}', now()) on conflict do nothing`);
}

async function seedPlace(db: PGlite, id: string, options: { producerId?: string } = {}): Promise<void> {
  if (options.producerId) {
    await db.exec(
      `insert into public.producers (id, display_name) values ('${options.producerId}', 'P ${options.producerId}') on conflict do nothing`,
    );
  }
  await db.exec(`
    insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id)
    values ('${id}', 'Place ${id}', 'desc', 'Kuliner', 'production', 'Bandung', 'Asia/Jakarta', 'IDR',
      ${options.producerId ? `'${options.producerId}'` : "null"});
  `);
}

/** Give a Place an active owner (the create-place / application outcome). */
async function seedOwnerMembership(
  db: PGlite,
  placeId: string,
  producerId: string,
  userId: string,
): Promise<void> {
  await db.exec(`insert into public.producers (id, display_name) values ('${producerId}', 'P ${producerId}') on conflict do nothing`);
  await db.exec(
    `insert into public.producer_memberships (user_id, producer_id, place_id, role)
     values ('${userId}', '${producerId}', '${placeId}', 'owner')`,
  );
}

const membershipCount = async (db: PGlite, placeId: string): Promise<number> =>
  Number(
    ((await rows(db, "select count(*)::int as c from public.producer_memberships where place_id = $1", [placeId]))[0]
      ?.c ?? -1),
  );

const claimRows = async (db: PGlite): Promise<Row[]> => rows(db, "select * from public.place_claims order by created_at");

const submitClaim = async (
  db: PGlite,
  userId: string,
  placeId: string,
  evidencePath: string | null = "place-claims/x/abc.pdf",
): Promise<string> => {
  const result = await rows(db, "select public.submit_place_claim($1, $2, $3) as id", [
    userId,
    placeId,
    evidencePath,
  ]);
  return String(result[0].id);
};

const claimableIds = async (db: PGlite): Promise<string[]> =>
  (await rows(db, "select place_id from public.list_claimable_places()")).map((row) => String(row.place_id));

const isOwned = async (db: PGlite, placeId: string): Promise<boolean> =>
  (await rows(db, "select public.place_has_active_ownership($1) as owned", [placeId]))[0].owned === true;

// --- 1 / 2 / 3 — the claim list and the direct-API gate --------------------

test("1. an owned Place never appears in the claim list (unowned-only filter is in the database)", async () => {
  const db = await bootstrapClaimDb();
  try {
    await seedUser(db, USER_A);
    await seedUser(db, USER_B);
    await seedPlace(db, "place-unowned");
    await seedPlace(db, "place-owned", { producerId: "producer-x" });
    await seedOwnerMembership(db, "place-owned", "producer-x", USER_B);
    // A Place bound to a Producer but with no membership row is still owned —
    // the same predicate must be used by the list and by the submit gate.
    await seedPlace(db, "place-producer-bound", { producerId: "producer-y" });

    const claimable = await claimableIds(db);
    assert.ok(claimable.includes("place-unowned"), "the unowned Place is claimable");
    assert.ok(!claimable.includes("place-owned"), "a Place with an active owner is not claimable");
    assert.ok(
      !claimable.includes("place-producer-bound"),
      "a Place bound to a Producer without a membership is still owned",
    );
  } finally {
    await db.close();
  }
});

test("2. an owned Place cannot be claimed through a direct API call", async () => {
  const db = await bootstrapClaimDb();
  try {
    await seedUser(db, USER_A);
    await seedUser(db, USER_B);
    await seedPlace(db, "place-owned");
    await seedOwnerMembership(db, "place-owned", "producer-x", USER_B);

    // Bypassing the list entirely (calling the RPC the API calls) is refused.
    await assert.rejects(
      () => submitClaim(db, USER_A, "place-owned"),
      /place_already_owned/,
    );
    assert.equal((await claimRows(db)).length, 0, "no claim row is created for an owned Place");
    assert.equal(await membershipCount(db, "place-owned"), 1, "ownership is untouched");
  } finally {
    await db.close();
  }
});

test("3. an unowned Place can be claimed", async () => {
  const db = await bootstrapClaimDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-free");
    const placesBefore = await rows(db, "select id, category, type, producer_id from public.places order by id");

    const claimId = await submitClaim(db, USER_A, "place-free");
    assert.match(claimId, /^[0-9a-f-]{36}$/i, "submit returns the new claim id");

    const claim = (await claimRows(db))[0];
    assert.equal(claim.place_id, "place-free");
    assert.equal(claim.user_id, USER_A, "the claim is filed under the caller's account");
    assert.equal(claim.evidence_path, "place-claims/x/abc.pdf");

    // The claim never creates or edits a Place.
    const placesAfter = await rows(db, "select id, category, type, producer_id from public.places order by id");
    assert.deepEqual(placesAfter, placesBefore, "claiming changed no Place row at all");
    const claimed = placesAfter.find((row) => row.id === "place-free");
    assert.equal(claimed?.category, "Kuliner", "the canonical category is unchanged");
    assert.equal(claimed?.type, "production", "the canonical type is unchanged");
    assert.equal(claimed?.producer_id, null, "no producer binding was written at claim time");
  } finally {
    await db.close();
  }
});

// --- 4 — proof of ownership is mandatory ----------------------------------

test("4. a claim without proof of ownership is refused", async () => {
  const db = await bootstrapClaimDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-free");

    await assert.rejects(() => submitClaim(db, USER_A, "place-free", null), /place_claim_evidence_required/);
    await assert.rejects(() => submitClaim(db, USER_A, "place-free", "   "), /place_claim_evidence_required/);
    assert.equal((await claimRows(db)).length, 0, "no claim row without evidence");
    assert.equal(await membershipCount(db, "place-free"), 0);

    // The table itself refuses an empty evidence reference, so the rule holds
    // even for a direct write by an operator.
    await assert.rejects(
      () =>
        db.exec(
          `insert into public.place_claims (place_id, user_id, evidence_path) values ('place-free', '${USER_A}', '')`,
        ),
    );
  } finally {
    await db.close();
  }
});

// --- 5 — evidence is private ---------------------------------------------

test("5. proof of ownership is stored in a private bucket with no client policy", async () => {
  const db = await bootstrapClaimDb();
  try {
    const bucket = (await rows(db, "select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'place-claim-evidence'"))[0];
    assert.ok(bucket, "the private evidence bucket exists");
    assert.equal(bucket.public, false, "the evidence bucket must NOT be public");
    assert.ok(Number(bucket.file_size_limit) > 0, "the bucket carries a size limit");

    // No storage policy at all: with RLS on and zero policies, anon and
    // authenticated can neither read nor write evidence objects.
    const objectPolicies = await rows(
      db,
      "select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'",
    );
    assert.equal(objectPolicies.length, 0, "no storage.objects policy may expose claim evidence");
  } finally {
    await db.close();
  }
});

// --- 6 — one Producer can never read another's claim/evidence ------------

test("6. Producer A cannot read Producer B's claim or its evidence reference", async () => {
  const db = await bootstrapClaimDb();
  try {
    await seedUser(db, USER_A);
    await seedUser(db, USER_B);
    await seedPlace(db, "place-free");
    const bClaim = await submitClaim(db, USER_B, "place-free");

    const aClaims = await rows(db, "select id from public.list_user_place_claims($1)", [USER_A]);
    assert.equal(aClaims.length, 0, "Producer A sees none of Producer B's claims");
    const bClaims = await rows(db, "select id from public.list_user_place_claims($1)", [USER_B]);
    assert.equal(bClaims.length, 1);
    assert.equal(bClaims[0].id, bClaim, "the claimant sees their own claim");

    // And the raw table is unreadable by any client role — claims (and their
    // evidence references) are server-side only.
    await db.exec("reset role;");
    await db.exec(`create or replace function auth.uid() returns uuid language sql stable as 'select $$${USER_A}$$::uuid'`);
    await db.exec("set role authenticated;");
    await assert.rejects(
      () => db.query("select evidence_path from public.place_claims"),
      /permission denied/,
      "authenticated clients have no direct read on place_claims",
    );
    await db.exec("reset role;");
  } finally {
    await db.close();
  }
});

// --- 7 / 8 — pending grants nothing --------------------------------------

test("7/8. a newly filed claim stays 'pending' and grants NO ownership", async () => {
  const db = await bootstrapClaimDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-free");
    await submitClaim(db, USER_A, "place-free");

    assert.equal((await claimRows(db))[0].status, "pending", "a filed claim is pending, never approved");
    assert.equal(await isOwned(db, "place-free"), false, "the Place is still unowned while pending");
    assert.equal(await membershipCount(db, "place-free"), 0, "no membership row was created");
    const memberships = await rows(db, "select * from public.producer_memberships");
    assert.equal(memberships.length, 0, "ownership is untouched platform-wide");

    // Nothing approves on its own: waiting does not change the status.
    assert.equal((await claimRows(db))[0].status, "pending");
  } finally {
    await db.close();
  }
});

// --- 9 — rejection grants nothing ----------------------------------------

test("9. a rejected claim grants NO ownership", async () => {
  const db = await bootstrapClaimDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-free");
    const claimId = await submitClaim(db, USER_A, "place-free");

    await rows(db, "select public.review_place_claim($1, $2, $3)", [claimId, "rejected", "bukti tidak cukup"]);

    const claim = (await claimRows(db))[0];
    assert.equal(claim.status, "rejected");
    assert.ok(claim.reviewed_at !== null, "the decision is stamped");
    assert.equal(await isOwned(db, "place-free"), false, "the Place stays unowned after rejection");
    assert.equal(await membershipCount(db, "place-free"), 0, "rejection created no membership");

    // A rejected claim cannot later be approved into ownership.
    await assert.rejects(
      () => rows(db, "select public.review_place_claim($1, $2, $3)", [claimId, "approved", null]),
      /place_claim_not_pending/,
    );
    assert.equal(await membershipCount(db, "place-free"), 0);
  } finally {
    await db.close();
  }
});

// --- 10 — approval grants ownership once ---------------------------------

test("10. approval grants ownership exactly once, through the existing authorization model", async () => {
  const db = await bootstrapClaimDb();
  try {
    await seedUser(db, USER_A);
    await seedPlace(db, "place-free");
    // The claimant already holds a Producer identity elsewhere.
    await seedPlace(db, "place-other");
    await seedOwnerMembership(db, "place-other", "producer-a", USER_A);
    const claimId = await submitClaim(db, USER_A, "place-free");

    await rows(db, "select public.review_place_claim($1, $2, $3)", [claimId, "approved", null]);

    const memberships = await rows(
      db,
      "select user_id, producer_id, place_id, role from public.producer_memberships where place_id = 'place-free'",
    );
    assert.equal(memberships.length, 1, "exactly one ownership row");
    assert.equal(memberships[0].user_id, USER_A, "ownership goes to the CLAIMANT's own account");
    assert.equal(memberships[0].role, "owner", "the existing ownership role is used");
    assert.equal(memberships[0].producer_id, "producer-a", "the claimant's existing Producer identity is bound");
    assert.equal(await isOwned(db, "place-free"), true, "the Place is now owned");
    assert.equal((await claimRows(db))[0].status, "approved");

    // Replay: a second approval is refused and grants nothing extra.
    await assert.rejects(
      () => rows(db, "select public.review_place_claim($1, $2, $3)", [claimId, "approved", null]),
      /place_claim_not_pending/,
    );
    assert.equal(await membershipCount(db, "place-free"), 1, "ownership is still granted only once");
  } finally {
    await db.close();
  }
});

// --- 11 — duplicate / racing claims --------------------------------------

test("11. duplicate claims for one Place can never produce two ownerships", async () => {
  const db = await bootstrapClaimDb();
  try {
    await seedUser(db, USER_A);
    await seedUser(db, USER_B);
    await seedPlace(db, "place-free");
    await seedPlace(db, "place-other");
    await seedPlace(db, "place-other-b");
    await seedOwnerMembership(db, "place-other", "producer-a", USER_A);
    await seedOwnerMembership(db, "place-other-b", "producer-b", USER_B);

    // Two Producers file a claim for the SAME Place before any approval.
    const claimA = await submitClaim(db, USER_A, "place-free");
    const claimB = await submitClaim(db, USER_B, "place-free");
    assert.notEqual(claimA, claimB);
    assert.equal((await claimRows(db)).length, 2, "both claims are recorded for review");
    assert.equal(await membershipCount(db, "place-free"), 0, "still no ownership while both are pending");

    // Approving both: the second one must lose.
    await rows(db, "select public.review_place_claim($1, $2, $3)", [claimA, "approved", null]);
    await assert.rejects(
      () => rows(db, "select public.review_place_claim($1, $2, $3)", [claimB, "approved", null]),
      /place_already_owned/,
    );

    const owners = await rows(
      db,
      "select user_id, role from public.producer_memberships where place_id = 'place-free' and role = 'owner'",
    );
    assert.equal(owners.length, 1, "the Place ends up with exactly ONE owner");
    assert.equal(owners[0].user_id, USER_A);
    assert.equal((await claimRows(db)).length, 2, "the losing claim is kept for an explicit review decision");

    // Same Producer cannot stack a second active claim either.
    await seedPlace(db, "place-free-2");
    const second = await submitClaim(db, USER_A, "place-free-2").catch((error: Error) => error);
    assert.ok(
      second instanceof Error && /place_claim_already_active/.test(second.message),
      "one active claim per account",
    );

    // The losing claim is still reviewable — the Admin rejects it explicitly.
    await rows(db, "select public.review_place_claim($1, $2, $3)", [claimB, "rejected", null]);
    assert.equal((await claimRows(db)).find((row) => row.id === claimB)?.status, "rejected");
  } finally {
    await db.close();
  }
});

test("11b. the race guard is structural: submit and review both lock the Place row and re-check ownership", async () => {
  const db = await bootstrapClaimDb();
  try {
    const body = async (name: string): Promise<string> => {
      const result = await rows(
        db,
        "select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1",
        [name],
      );
      return String(result[0]?.prosrc ?? "");
    };

    for (const name of ["submit_place_claim", "review_place_claim"]) {
      const source = await body(name);
      assert.match(source, /for update/i, `${name} must take a row lock on the Place`);
      const lockIndex = source.search(/for update/i);
      const ownershipIndex = source.indexOf("place_has_active_ownership");
      assert.ok(ownershipIndex > -1, `${name} must re-check ownership`);
      assert.ok(
        ownershipIndex > lockIndex,
        `${name} must re-check ownership AFTER the lock, so a racing approval sees the winner's row`,
      );
    }

    // Defense in depth: one active claim per account, enforced by the database
    // itself and not only by the RPC.
    const indexes = await rows(
      db,
      "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'place_claims'",
    );
    assert.ok(
      indexes.some((row) => /one_active_per_user/.test(String(row.indexdef))),
      "an active-claim-per-account index backs the idempotency guard",
    );
  } finally {
    await db.close();
  }
});

// --- 12 — the existing Create Place flow is untouched --------------------

test("12. the existing Create Place flow still passes and its Places are never claimable", async () => {
  const foundation = await bootstrapDb();
  let beforePolicies: string[];
  try {
    beforePolicies = (
      await rows(
        foundation,
        "select policyname from pg_policies where schemaname = 'public' and tablename in ('places', 'producer_memberships') order by policyname",
      )
    ).map((row) => String(row.policyname));
    assert.ok(beforePolicies.includes("places_producer_insert"), "the create-place policy exists");
  } finally {
    await foundation.close();
  }

  const db = await bootstrapClaimDb();
  try {
    await seedUser(db, USER_A);
    await seedUser(db, USER_B);
    // The existing create-place path: USER_A is an owner of a Producer
    // identity, which is exactly what `places_producer_insert` checks.
    await seedPlace(db, "place-seed");
    await seedOwnerMembership(db, "place-seed", "producer-a", USER_A);
    // Supabase grants these by default; the harness must reproduce them to
    // exercise the policy as a real client would.
    await db.exec("grant insert, select on public.places to authenticated");
    // Supabase also grants authenticated a (RLS-scoped) read on memberships,
    // which the insert policy relies on.
    await db.exec("grant select on public.producer_memberships to authenticated");

    const createPlace = async (userId: string, id: string): Promise<Row[]> => {
      await db.exec("reset role;");
      await db.exec(
        `create or replace function auth.uid() returns uuid language sql stable as 'select $$${userId}$$::uuid'`,
      );
      await db.exec("set role authenticated;");
      try {
        return await rows(
          db,
          `insert into public.places (id, name, short_description, category, type, area, timezone, currency, producer_id)
           values ('${id}', 'Place Baru', 'desc', 'Kopi', 'production', 'Bandung', 'Asia/Jakarta', 'IDR', 'producer-a')
           returning id`,
        );
      } finally {
        await db.exec("reset role;");
      }
    };

    const created = await createPlace(USER_A, "place-created");
    assert.equal(created.length, 1, "an authorized Producer can still create a Place");
    await assert.rejects(
      () => createPlace(USER_B, "place-denied"),
      /row-level security/,
      "an account without the owner membership is still refused by the existing policy",
    );

    // The ownership grant the create flow performs makes the Place unclaimable.
    await seedOwnerMembership(db, "place-created", "producer-a", USER_A);
    assert.ok(!(await claimableIds(db)).includes("place-created"),
      "a Place created through the existing flow is not claimable");
    assert.equal((await claimRows(db)).length, 0, "creating a Place files no claim");
  } finally {
    await db.close();
  }
});

// --- 13 — existing authorization / RLS is untouched ----------------------

test("13. existing Producer authorization and RLS are unchanged, and the new surface is fail-closed", async () => {
  const foundation = await bootstrapDb();
  let beforePolicies: string[];
  let beforeAllPolicies: string[];
  try {
    beforePolicies = (
      await rows(
        foundation,
        "select policyname from pg_policies where schemaname = 'public' and tablename in ('places', 'producer_memberships') order by policyname",
      )
    ).map((row) => String(row.policyname));
    beforeAllPolicies = (
      await rows(
        foundation,
        "select policyname from pg_policies where schemaname = 'public' order by policyname",
      )
    ).map((row) => String(row.policyname));
  } finally {
    await foundation.close();
  }

  const db = await bootstrapClaimDb();
  try {
    const afterPolicies = (
      await rows(
        db,
        "select policyname from pg_policies where schemaname = 'public' and tablename in ('places', 'producer_memberships') order by policyname",
      )
    ).map((row) => String(row.policyname));
    assert.deepEqual(afterPolicies, beforePolicies, "0028 must not touch places/memberships policies");

    const afterAll = (
      await rows(db, "select policyname from pg_policies where schemaname = 'public' order by policyname")
    ).map((row) => String(row.policyname));
    assert.deepEqual(afterAll, beforeAllPolicies, "0028 adds no RLS policy anywhere in public");

    // The existing Producer read path still works for a member.
    assert.ok(afterPolicies.includes("memberships_self_read"), "the membership self-read policy is intact");

    // The claim table is fail-closed: RLS on, zero policies, no client grants.
    const rls = (
      await rows(db, "select rowsecurity from pg_tables where schemaname = 'public' and tablename = 'place_claims'")
    )[0];
    assert.equal(rls?.rowsecurity, true, "RLS is enabled on place_claims");
    const claimPolicies = await rows(
      db,
      "select policyname from pg_policies where schemaname = 'public' and tablename = 'place_claims'",
    );
    assert.equal(claimPolicies.length, 0, "place_claims has zero RLS policies");

    const tableGrants = (
      await rows(
        db,
        `select r.rolname from information_schema.role_table_grants g join pg_roles r on r.rolname = g.grantee
         where g.table_schema = 'public' and g.table_name = 'place_claims'`,
      )
    ).map((row) => String(row.rolname));
    assert.ok(!tableGrants.includes("anon") && !tableGrants.includes("authenticated"),
      `anon/authenticated must hold no grants (got ${tableGrants.join(", ")})`);

    // Every claim RPC is revoked from client roles.
    for (const name of [
      "place_has_active_ownership",
      "list_claimable_places",
      "submit_place_claim",
      "list_user_place_claims",
      "list_place_claims_for_review",
      "review_place_claim",
    ]) {
      const executors = (
        await rows(
          db,
          `select r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
           aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl join pg_roles r on r.oid = acl.grantee
           where n.nspname = 'public' and p.proname = $1 and acl.privilege_type = 'EXECUTE'`,
          [name],
        )
      ).map((row) => String(row.rolname));
      assert.ok(
        !executors.includes("public") && !executors.includes("anon") && !executors.includes("authenticated"),
        `${name} must be revoked from clients (got ${executors.join(", ")})`,
      );
    }
  } finally {
    await db.close();
  }
});
