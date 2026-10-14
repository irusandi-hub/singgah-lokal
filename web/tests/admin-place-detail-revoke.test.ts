import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

/**
 * ADMIN-PLACE-REVOKE — "Cabut Hak Pengelolaan" di halaman detail Place
 * (perluasan di atas #45; docs/audits/ADMIN_PLACE_DETAIL_REVOKE_AUDIT.md).
 *
 * Dua lapis, tanpa menduplikasi suite #45:
 * 1. PERILAKU pada Postgres nyata (PGlite + rantai migrasi nyata s/d 0057):
 *    membership id yang disajikan payload detail Place memang mencabut baris
 *    yang TEPAT, Place/akun lain utuh, audit tertulis, `places.producer_id`
 *    TIDAK berubah, dan produser yang dicabut tidak lagi lolos predikat kelola
 *    membership-scoped; pencabutan ulang idempoten.
 * 2. KONTRAK statis untuk markup/wiring yang tidak bisa dijalankan di sandbox:
 *    komponen dialog BERSAMA dipakai dua permukaan, label per permukaan,
 *    payload detail membawa membership id, dan jalur `places.producer_id`
 *    tertutup di predikat kelola.
 */

const MIGRATION_DIR = "../supabase/migrations/";
const readMigration = (name: string) =>
  readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/[^\n]*$/gm, "");

const CHAIN = [
  "0001_visit_intent_foundation.sql",
  "0002_harden_visit_intent_rls.sql",
  "0003_persistence_integrity.sql",
  "0004_place_management.sql",
  "0005_experience_management.sql",
  "0006_production_story.sql",
  "0007_production_story_atomic_persistence.sql",
  "0008_live_sessions.sql",
  "0012_live_end_idempotency.sql",
  "0013_live_rpc_privilege_lockdown.sql",
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
  "0030_notifications_realtime_publication.sql",
  "0031_place_audit.sql",
  "0057_admin_revoke_producer_place_access.sql",
];

const ADMIN = "aaaa0000-0000-4000-8000-0000000000a1";
const OWNER_A = "bbbb0000-0000-4000-8000-0000000000a1";
const OWNER_B = "bbbb0000-0000-4000-8000-0000000000a2";
const MANAGER = "cccc0000-0000-4000-8000-0000000000a1";
const EDITOR = "dddd0000-0000-4000-8000-0000000000a1";
const PRODUCER = "prod-place-detail";
const PRODUCER_OTHER = "prod-place-detail-other";
const PLACE = "rumah-teh-lokal";
const PLACE_OTHER = "kopi-dari-kebun";

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];
const count = async (db: PGlite, table: string): Promise<number> =>
  Number((await rows(db, `select count(*)::int as n from ${table}`))[0].n);

async function createDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, encrypted_password text);
    create function auth.uid() returns uuid language sql stable as
      $$ select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
    create role anon;
    create role authenticated;
    create role service_role;
    create role supabase_admin;
    create role authenticator;
    alter role service_role bypassrls;
    grant usage on schema auth to authenticated;

    create schema if not exists realtime;
    create table realtime.messages (id bigserial primary key, topic text, extension text, event text, payload jsonb);
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
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  `);
  await db.exec("create publication supabase_realtime;");
  for (const name of CHAIN) {
    await db.exec(stripPgcrypto(readMigration(name)));
    if (name === "0001_visit_intent_foundation.sql") {
      await db.exec(
        `grant usage on schema public to anon, authenticated, service_role;
         grant all on all tables in schema public to anon, authenticated;
         grant usage, select on all sequences in schema public to anon, authenticated;`,
      );
    }
  }
  return db;
}

async function asService(db: PGlite, actorId: string, membershipId: string): Promise<Row> {
  await db.exec("reset role;");
  await db.exec("set role service_role;");
  try {
    const result = await db.query(
      `select public.revoke_producer_place_access($1::uuid, $2::uuid) as outcome`,
      [actorId, membershipId],
    );
    const first = (result.rows?.[0] ?? {}) as Record<string, unknown>;
    return (first.outcome ?? {}) as Row;
  } finally {
    await db.exec("reset role;");
  }
}

async function seedWorld(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${ADMIN}', 'admin@example.com', now()),
      ('${OWNER_A}', 'ownera@example.com', now()),
      ('${OWNER_B}', 'ownerb@example.com', now()),
      ('${MANAGER}', 'manager@example.com', now()),
      ('${EDITOR}', 'editor@example.com', now())
    on conflict (id) do nothing;
    update public.users set platform_role = 'platform_moderator' where id = '${ADMIN}';
    insert into public.producers (id, display_name) values
      ('${PRODUCER}', 'Pengelola Utama'), ('${PRODUCER_OTHER}', 'Pengelola Cabang')
    on conflict (id) do nothing;
    -- PLACE already has a non-null producer_id (the legacy ownership signal).
    update public.places set producer_id = '${PRODUCER}' where id = '${PLACE}';
    insert into public.producer_memberships (user_id, producer_id, place_id, role) values
      ('${OWNER_A}', '${PRODUCER}', '${PLACE}', 'owner'),
      ('${OWNER_B}', '${PRODUCER}', '${PLACE}', 'owner'),
      ('${MANAGER}', '${PRODUCER}', '${PLACE}', 'manager'),
      ('${EDITOR}',  '${PRODUCER}', '${PLACE}', 'editor'),
      ('${OWNER_A}', '${PRODUCER_OTHER}', '${PLACE_OTHER}', 'owner')
    on conflict do nothing;
  `);
}

/** EXACTLY the resolution the Place-detail payload now performs. */
async function membershipIdFor(db: PGlite, userId: string, placeId: string): Promise<string> {
  const found = await rows(
    db,
    `select id, user_id, producer_id, role, created_at
       from public.producer_memberships
      where place_id = $1::text and user_id = $2::uuid
      order by created_at asc`,
    [placeId, userId],
  );
  assert.equal(found.length, 1);
  assert.ok(String(found[0].id ?? "").length > 0, "payload detail Place kini membawa membership id");
  return String(found[0].id);
}

/** The membership-scoped management predicate every gate/RLS uses. */
async function canManage(db: PGlite, userId: string, placeId: string): Promise<boolean> {
  const found = await rows(
    db,
    `select 1 from public.producer_memberships
      where user_id = $1::uuid and place_id = $2::text and role in ('owner','manager','editor')`,
    [userId, placeId],
  );
  return found.length > 0;
}

// ---------------------------------------------------------------------------
// 1. Perilaku pada Postgres nyata
// ---------------------------------------------------------------------------

test("detail Place: membership id yang disajikan mencabut baris TEPAT (bukan yang lain)", async () => {
  const db = await createDb();
  await seedWorld(db);

  const before = {
    memberships: await count(db, "producer_memberships"),
    places: await count(db, "places"),
    experiences: await count(db, "experiences"),
    visitIntents: await count(db, "visit_intents"),
    users: await count(db, "public.users"),
  };
  // The chosen membership is the MANAGER's row on PLACE (from the page's list).
  const targetId = await membershipIdFor(db, MANAGER, PLACE);
  const otherMembershipIdBefore = await membershipIdFor(db, EDITOR, PLACE);

  const outcome = await asService(db, ADMIN, targetId);
  assert.equal(outcome.status, "revoked");
  assert.equal(outcome.notified, true);

  // Target row gone; the manager can no longer manage PLACE.
  assert.equal(await canManage(db, MANAGER, PLACE), false);
  // Nothing else changed: the other membership on the same Place survives with
  // the SAME id, and the manager's membership on ANY place is what was removed.
  assert.equal(await canManage(db, EDITOR, PLACE), true);
  assert.equal(await membershipIdFor(db, EDITOR, PLACE), otherMembershipIdBefore);
  assert.equal(await canManage(db, OWNER_A, PLACE), true);

  assert.equal(await count(db, "producer_memberships"), before.memberships - 1);
  assert.equal(await count(db, "places"), before.places);
  assert.equal(await count(db, "experiences"), before.experiences);
  assert.equal(await count(db, "visit_intents"), before.visitIntents);
  assert.equal(await count(db, "public.users"), before.users);

  // One attributed audit row, in the SAME Place trail the workspace renders.
  const audit = await rows(
    db,
    `select place_id, actor_id, action, detail from public.place_audit
      where action = 'producer_place_access_revoked'`,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].place_id, PLACE);
  assert.equal(audit[0].actor_id, ADMIN);
  assert.equal(String((audit[0].detail as Row).membership_id), targetId);

  await db.close();
});

test("detail Place: jalur alternatif places.producer_id TIDAK meloloskan yang dicabut", async () => {
  const db = await createDb();
  await seedWorld(db);

  const targetId = await membershipIdFor(db, MANAGER, PLACE);
  // Precondition: the Place still carries producer_id BEFORE the revoke.
  assert.equal(
    String((await rows(db, `select producer_id from public.places where id = $1`, [PLACE]))[0].producer_id),
    PRODUCER,
  );

  await asService(db, ADMIN, targetId);

  // The revoke does NOT clear places.producer_id (Policy Decision P-A2) ...
  assert.equal(
    String((await rows(db, `select producer_id from public.places where id = $1`, [PLACE]))[0].producer_id),
    PRODUCER,
    "revoke never changes places.producer_id (ownership signal, not a management grant)",
  );
  // ... yet the revoked manager cannot manage the Place through ANY
  // membership-scoped predicate (the only authority).
  assert.equal(await canManage(db, MANAGER, PLACE), false);
  // The producer_id signal is still "owned" for the claim gate — unchanged.
  assert.equal(
    (await rows(db, `select public.place_has_active_ownership($1) as owned`, [PLACE]))[0].owned,
    true,
  );

  await db.close();
});

test("detail Place: pencabutan ulang idempoten — tanpa audit/notifikasi kedua", async () => {
  const db = await createDb();
  await seedWorld(db);

  const targetId = await membershipIdFor(db, EDITOR, PLACE);
  const first = await asService(db, ADMIN, targetId);
  assert.equal(first.status, "revoked");

  const auditAfterFirst = await count(db, "place_audit");
  const notifAfterFirst = await count(db, "notifications");

  const second = await asService(db, ADMIN, targetId);
  assert.equal(second.status, "already_revoked");
  assert.equal(second.notified, false);
  assert.equal(await count(db, "place_audit"), auditAfterFirst, "penolakan idempoten tidak menulis audit baru");
  assert.equal(await count(db, "notifications"), notifAfterFirst, "tidak ada notifikasi ganda");

  await db.close();
});

// ---------------------------------------------------------------------------
// 2. Kontrak statis: satu implementasi, dua permukaan, jalur producer_id tertutup
// ---------------------------------------------------------------------------

test("dialog pencabutan adalah SATU komponen bersama (bukan salinan)", () => {
  const dialog = stripComments(read("../components/admin/producer-access-revoke-dialog.tsx"));
  assert.match(dialog, /export default function ProducerAccessRevokeDialog/);
  assert.match(dialog, /\/api\/admin\/producer-memberships\/\$\{encodeURIComponent\(target\.membershipId\)\}\/revoke/);

  // Kedua permukaan mengimpor komponen yang sama.
  for (const path of [
    "../app/admin/producer-membership/AdminPengelolaTable.tsx",
    "../components/admin/place-members-panel.tsx",
  ]) {
    const source = read(path);
    assert.match(source, /from "@\/components\/admin\/producer-access-revoke-dialog"/, `${path} harus memakai komponen bersama`);
    assert.match(source, /<ProducerAccessRevokeDialog/);
  }

  // Tidak ada RPC/route kedua untuk tujuan yang sama.
  assert.equal(
    readFileSync(new URL("../lib/admin/producer-membership-revoke.ts", import.meta.url), "utf8").includes("revokeProducerPlaceAccess"),
    true,
  );
});

test("label per permukaan: Data Pengelola 'Cabut Hak Akses', detail Place 'Cabut Hak Pengelolaan'", () => {
  const table = stripComments(read("../app/admin/producer-membership/AdminPengelolaTable.tsx"));
  const panel = stripComments(read("../components/admin/place-members-panel.tsx"));
  assert.match(table, /actionLabel="Cabut Hak Akses"/);
  assert.match(panel, /actionLabel="Cabut Hak Pengelolaan"/);
  assert.match(panel, /aria-label=\{`Cabut hak pengelolaan \$\{account\} atas \$\{placeName\}`\}/);
  // Owner terakhir: nonaktif dengan alasan singkat, bukan disembunyikan.
  assert.match(panel, /data-testid="place-member-locked"/);
  assert.match(panel, /Tidak dapat dicabut: Pemilik terakhir\./);
  // Empty state yang ada dipertahankan.
  assert.match(panel, /Belum ada membership\./);
});

test("payload detail Place membawa membership id + email akun (konvensi aman)", () => {
  const workspace = stripComments(read("../lib/admin/place-workspace.ts"));
  assert.match(workspace, /membershipId: string;/);
  assert.match(workspace, /userEmail: string \| null;/);
  assert.match(workspace, /\.select\("id, user_id, producer_id, role, created_at"\)/);
  assert.match(workspace, /membershipId: String\(row\.id\)/);
  assert.match(workspace, /listAdminActorEmails/);
  // Halaman detail merender panelnya.
  const page = stripComments(read("../app/admin/places/[placeId]/page.tsx"));
  assert.match(page, /<AdminPlaceMembersPanel placeName=\{place\.name\} memberships=\{memberships\} \/>/);
});

test("predikat kelola tidak lagi memakai places.producer_id (fail-closed)", () => {
  const producer = read("../lib/producer.ts");
  // Cabang lama `place.producer?.id === access.producerId` harus hilang.
  assert.doesNotMatch(producer, /place\.producer\?\.id === access\.producerId/);
  assert.match(producer, /return access\.placeId === place\.id;/);
});
