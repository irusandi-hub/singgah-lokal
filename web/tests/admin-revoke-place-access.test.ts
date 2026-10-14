import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

/**
 * ADMIN-REVOKE — Platform Admin mencabut hak kelola seorang Produser atas SATU
 * Tempat, beserta notifikasi ke pihak terdampak.
 *
 * Semua perilaku di sini dijalankan terhadap RANTAI MIGRASI NYATA di mesin
 * Postgres nyata (PGlite) — bukan mock: RPC `revoke_producer_place_access`
 * (0057), trail audit `place_audit` (0031), dan penulis notifikasi
 * `notify_recipient` (0029) dipanggil apa adanya. Bukti untuk
 * docs/audits/ADMIN_REVOKE_PLACE_ACCESS_AUDIT.md.
 *
 * Rantai berhenti di 0031 + 0057 (0036/0039 hanya memperluas CHECK `action`
 * place_audit dengan nilai yang sama seperti yang 0057 tulis ulang lengkap), jadi
 * keadaan akhir yang diuji identik dengan rantai produksi.
 */

const MIGRATION_DIR = "../supabase/migrations/";
const readMigration = (name: string) =>
  readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");

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

const ADMIN = "aaaa0000-0000-4000-8000-000000000001"; // platform_moderator
const ADMIN_2 = "aaaa0000-0000-4000-8000-000000000002"; // platform_moderator (ke-2)
const OWNER = "bbbb0000-0000-4000-8000-000000000001"; // Produser: owner PLACE_A + PLACE_B
const OWNER_2 = "bbbb0000-0000-4000-8000-000000000002"; // Produser: owner PLACE_A + PLACE_C
const MANAGER = "cccc0000-0000-4000-8000-000000000001"; // Produser: manager PLACE_A
const EDITOR = "dddd0000-0000-4000-8000-000000000001"; // Produser: editor PLACE_A
const REGULAR = "eeee0000-0000-4000-8000-000000000001"; // user biasa, BUKAN admin

const PLACE_A = "rumah-teh-lokal"; // seed 0001
const PLACE_B = "kopi-dari-kebun"; // seed 0001
const PLACE_C = "dapur-rasa"; // seed 0001
const PRODUCER_A = "prod-admin-revoke-a";
const PRODUCER_B = "prod-admin-revoke-b";

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
      // Supabase grants its default table privileges when a table is CREATED,
      // i.e. before the later explicit REVOKE/GRANT statements run. Applying
      // them here (not at the end) is what makes 0025's notifications and
      // 0031's place_audit lockdowns the real posture rather than a no-op.
      await db.exec(
        `grant usage on schema public to anon, authenticated, service_role;
         grant all on all tables in schema public to anon, authenticated;
         grant usage, select on all sequences in schema public to anon, authenticated;`,
      );
    }
  }
  return db;
}

/** Replace auth.uid() with a constant (or NULL) — every PGlite query is its own
 *  transaction, so a GUC would not survive the statements the RPC runs. */
async function setAuthUid(db: PGlite, userId: string | null): Promise<void> {
  await db.exec("reset role;");
  const body = userId === null ? "select null::uuid" : `select '${userId}'::uuid`;
  await db.exec(
    `create or replace function auth.uid() returns uuid language sql stable as $fn$ ${body} $fn$`,
  );
}

/** Call the RPC exactly the way server code does: service_role, no session. */
async function revokeAsService(
  db: PGlite,
  actorId: string,
  membershipId: string,
  role = "service_role",
): Promise<Row> {
  await setAuthUid(db, null);
  await db.exec(`set role ${role};`);
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

/** Call the RPC as an authenticated/anon client (no EXECUTE grant). */
async function revokeAsClient(
  db: PGlite,
  userId: string,
  membershipId: string,
  role: "authenticated" | "anon",
): Promise<void> {
  await setAuthUid(db, userId);
  await db.exec(`set role ${role};`);
  try {
    await db.query(`select public.revoke_producer_place_access($1::uuid, $2::uuid)`, [
      userId,
      membershipId,
    ]);
    assert.fail("a client role must not be able to execute the admin revoke RPC");
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match((error as Error).message, /permission denied/i);
  } finally {
    await db.exec("reset role;");
  }
}

async function expectRpcRaise(
  db: PGlite,
  actorId: string,
  membershipId: string,
  message: string,
  sessionUserId: string | null = null,
): Promise<void> {
  await setAuthUid(db, sessionUserId);
  await db.exec("set role service_role;");
  try {
    await db.query(`select public.revoke_producer_place_access($1::uuid, $2::uuid)`, [
      actorId,
      membershipId,
    ]);
    assert.fail(`expected raise exception '${message}'`);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match((error as Error).message, new RegExp(message));
  } finally {
    await db.exec("reset role;");
  }
}

const membershipId = async (db: PGlite, userId: string, placeId: string): Promise<string> => {
  const found = await rows(
    db,
    `select id from public.producer_memberships where user_id = $1::uuid and place_id = $2::text`,
    [userId, placeId],
  );
  assert.equal(found.length, 1, `expected exactly one membership for ${userId} on ${placeId}`);
  return String(found[0].id);
};

async function seedWorld(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${ADMIN}', 'admin@example.com', now()),
      ('${ADMIN_2}', 'admin2@example.com', now()),
      ('${OWNER}', 'owner@example.com', now()),
      ('${OWNER_2}', 'owner2@example.com', now()),
      ('${MANAGER}', 'manager@example.com', now()),
      ('${EDITOR}', 'editor@example.com', now()),
      ('${REGULAR}', 'regular@example.com', now())
    on conflict (id) do nothing;
    update public.users set platform_role = 'platform_moderator'
      where id in ('${ADMIN}', '${ADMIN_2}');
    insert into public.producers (id, display_name) values
      ('${PRODUCER_A}', 'Pengelola Utama'), ('${PRODUCER_B}', 'Pengelola Cabang')
    on conflict (id) do nothing;
    insert into public.producer_memberships (user_id, producer_id, place_id, role) values
      ('${OWNER}',   '${PRODUCER_A}', '${PLACE_A}', 'owner'),
      ('${OWNER_2}', '${PRODUCER_A}', '${PLACE_A}', 'owner'),
      ('${MANAGER}', '${PRODUCER_A}', '${PLACE_A}', 'manager'),
      ('${EDITOR}',  '${PRODUCER_A}', '${PLACE_A}', 'editor'),
      ('${OWNER}',   '${PRODUCER_B}', '${PLACE_B}', 'owner'),
      ('${OWNER_2}', '${PRODUCER_B}', '${PLACE_C}', 'owner')
    on conflict do nothing;
  `);
}

const notificationsFor = (db: PGlite, userId: string) =>
  rows(
    db,
    `select category, event_type, title, body, place_id, source_type, source_id
       from public.notifications where user_id = $1::uuid order by created_at, event_type`,
    [userId],
  );

const auditRows = (db: PGlite, action: string) =>
  rows(
    db,
    `select place_id, actor_id, action, detail, before_data, after_data
       from public.place_audit where action = $1::text order by id`,
    [action],
  );

// ---------------------------------------------------------------------------
// 1. Skema: identitas membership + kosakata audit
// ---------------------------------------------------------------------------

test("0057: setiap membership punya SATU id unik yang tidak null", async () => {
  const db = await createDb();
  await seedWorld(db);

  const all = await rows(db, `select id from public.producer_memberships`);
  assert.equal(all.length, 6);
  const ids = new Set(all.map((row) => String(row.id)));
  assert.equal(ids.size, 6, "setiap baris punya id yang berbeda");
  assert.equal(ids.has("null"), false, "tidak ada id null");

  const notNull = await rows(
    db,
    `select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'producer_memberships' and column_name = 'id'`,
  );
  assert.equal(notNull[0].is_nullable, "NO", "kolom id NOT NULL");

  const unique = await rows(
    db,
    `select indexdef from pg_indexes
      where schemaname = 'public' and tablename = 'producer_memberships'
        and indexdef ilike '%unique%' and indexdef ilike '%(id)%'`,
  );
  assert.equal(unique.length, 1, "unique index untuk id ada tepat satu");

  // PK kanonik tidak berubah (0016/0001).
  const pk = await rows(
    db,
    `select a.attname from pg_index i
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'public.producer_memberships'::regclass and i.indisprimary
      order by a.attname`,
  );
  assert.deepEqual(pk.map((r) => r.attname), ["place_id", "user_id"], "PK tetap (user_id, place_id)");

  await db.close();
});

test("0057: place_audit tetap RLS-on, tanpa policy, dan append-only", async () => {
  const db = await createDb();

  const rls = await rows(
    db,
    `select relrowsecurity from pg_class where oid = 'public.place_audit'::regclass`,
  );
  assert.equal(rls[0].relrowsecurity, true, "RLS tetap menyala");
  assert.equal(
    Number(
      (
        await rows(
          db,
          `select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = 'place_audit'`,
        )
      )[0].n,
    ),
    0,
    "tidak ada policy → tertutup untuk klien",
  );

  const actions = await rows(
    db,
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'public.place_audit'::regclass and conname = 'place_audit_action_check'`,
  );
  const def = String(actions[0].def);
  assert.match(def, /producer_place_access_revoked/);
  assert.match(def, /producer_place_access_revoke_denied/);
  // Tidak ada nilai lama yang hilang.
  for (const legacy of [
    "admin_place_created",
    "admin_place_published",
    "place_claim_approved",
    "admin_place_curated",
    "developer_place_dummy_marked",
  ]) {
    assert.match(def, new RegExp(legacy), `kosakata lama ${legacy} tetap ada`);
  }

  await db.close();
});

// ---------------------------------------------------------------------------
// 2. Otorisasi
// ---------------------------------------------------------------------------

test("admin sah dapat mencabut: baris hilang, audit tercatat, notifikasi terkirim", async () => {
  const db = await createDb();
  await seedWorld(db);

  const target = await membershipId(db, MANAGER, PLACE_A);
  const before = {
    memberships: await count(db, "public.producer_memberships"),
    notifications: await count(db, "public.notifications"),
    audit: await count(db, "public.place_audit"),
  };

  const outcome = await revokeAsService(db, ADMIN, target);
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.status, "revoked");
  assert.equal(outcome.notified, true);
  assert.equal(outcome.placeName, "Rumah Teh Lokal");
  assert.equal(outcome.role, "manager");

  // Baris membership benar-benar hilang (DELETE adalah mekanisme yang ada).
  assert.equal(
    (
      await rows(
        db,
        `select 1 from public.producer_memberships where user_id = $1::uuid and place_id = $2::text`,
        [MANAGER, PLACE_A],
      )
    ).length,
    0,
  );

  // Audit: pelaku = admin sendiri, target = Tempat, hasil tercatat.
  const revoked = await auditRows(db, "producer_place_access_revoked");
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].place_id, PLACE_A);
  assert.equal(revoked[0].actor_id, ADMIN);
  const detail = revoked[0].detail as Record<string, unknown>;
  assert.equal(detail.membership_id, target);
  assert.equal(detail.target_user_id, MANAGER);
  assert.equal(detail.role, "manager");
  assert.equal(detail.result, "revoked");
  assert.equal((revoked[0].before_data as Record<string, unknown>).role, "manager");
  assert.equal(revoked[0].after_data, null);

  // Notifikasi: tepat 1 (safety_account) + 2 owner lain (system), tanpa editor.
  assert.equal(await count(db, "public.notifications"), before.notifications + 3);

  const revokedNotifs = await notificationsFor(db, MANAGER);
  assert.equal(revokedNotifs.length, 1);
  const n = revokedNotifs[0];
  assert.equal(n.category, "safety_account", "penerima wajib memakai kategori non-disableable");
  assert.equal(n.event_type, "producer_place_access_revoked");
  assert.equal(n.title, "Hak akses Tempat dicabut");
  assert.equal(n.place_id, null, "tanpa tautan ke Tempat yang tak lagi ia kelola");
  assert.equal(n.source_type, "producer_membership");
  assert.equal(n.source_id, target);
  const body = String(n.body);
  assert.match(body, /Admin Singgah Lokal/);
  assert.match(body, /Pengelola/); // label role terkunci (manager)
  assert.match(body, /Rumah Teh Lokal/);
  assert.match(body, /\(Asia\/Jakarta\)/); // zona waktu Tempat
  assert.match(body, /tidak lagi bisa mengelola Tempat itu/i);
  assert.match(body, /Tempat lain yang kamu kelola tidak berubah/);
  assert.match(body, /menu Bantuan/);
  assert.doesNotMatch(body, /admin@example\.com|@example\.com/, "tanpa email siapa pun");
  assert.doesNotMatch(body, /pembayaran|checkout|pesanan/i);

  const coManagerNotifs = await notificationsFor(db, OWNER);
  assert.equal(coManagerNotifs.length, 1);
  assert.equal(coManagerNotifs[0].event_type, "producer_place_management_changed");
  assert.equal(coManagerNotifs[0].category, "system");
  assert.equal(coManagerNotifs[0].place_id, PLACE_A, "penerima lain masih mengelola → tautan valid");
  const coBody = String(coManagerNotifs[0].body);
  assert.match(coBody, /Pengelola Utama/); // nama tampilan Produser, bukan email
  assert.match(coBody, /Rumah Teh Lokal/);
  assert.match(coBody, /Pengelola/);
  assert.match(coBody, /\(Asia\/Jakarta\)/);
  assert.doesNotMatch(coBody, /@example\.com/, "tanpa data kontak");
  assert.doesNotMatch(coBody, /Admin Singgah Lokal|admin/i, "tanpa detail internal admin");

  assert.equal((await notificationsFor(db, OWNER_2)).length, 1, "owner aktif kedua ikut diberi tahu");
  assert.equal((await notificationsFor(db, EDITOR)).length, 0, "editor TIDAK diberi notifikasi");
  assert.equal((await notificationsFor(db, REGULAR)).length, 0);
  assert.equal((await notificationsFor(db, ADMIN)).length, 0, "admin pelaku tidak dinotifikasi");

  assert.equal(await count(db, "public.place_audit"), before.audit + 1);
  assert.equal(await count(db, "public.producer_memberships"), before.memberships - 1);

  await db.close();
});

test("tanpa sesi/non-admin ditolak: klien tidak bisa memanggil RPC, service role tanpa admin pun ditolak", async () => {
  const db = await createDb();
  await seedWorld(db);
  const target = await membershipId(db, MANAGER, PLACE_A);

  // Klien (authenticated / anon) tidak punya EXECUTE sama sekali — termasuk
  // untuk owner Tempat itu sendiri dan Produser biasa.
  await revokeAsClient(db, MANAGER, target, "authenticated");
  await revokeAsClient(db, OWNER, target, "authenticated");
  await revokeAsClient(db, REGULAR, target, "authenticated");
  await revokeAsClient(db, ADMIN, target, "authenticated");
  await revokeAsClient(db, REGULAR, target, "anon");

  // Klien tidak memiliki EXECUTE pada RPC ini.
  for (const role of ["anon", "authenticated"]) {
    const priv = await rows(
      db,
      `select has_function_privilege($1::text, 'public.revoke_producer_place_access(uuid, uuid)', 'execute') as ok`,
      [role],
    );
    assert.equal(priv[0].ok, false, `${role} must NOT have EXECUTE`);
  }

  // Service role (server code) tetap diverifikasi DI DALAM fungsi: p_actor_id
  // non-moderator ditolak.
  await expectRpcRaise(db, REGULAR, target, "platform_admin_required");
  await expectRpcRaise(db, OWNER, target, "platform_admin_required", OWNER);
  await expectRpcRaise(db, OWNER, target, "platform_admin_required");
  await expectRpcRaise(db, EDITOR, target, "platform_admin_required");

  // Bahkan bila pemanggil ber-sesi mencoba memalsukan pelaku, id SESI yang menang.
  await expectRpcRaise(db, ADMIN, target, "platform_admin_required", REGULAR);

  // Tidak ada yang berubah.
  assert.equal(
    (
      await rows(
        db,
        `select 1 from public.producer_memberships where user_id = $1::uuid and place_id = $2::text`,
        [MANAGER, PLACE_A],
      )
    ).length,
    1,
  );
  assert.equal(await count(db, "public.place_audit"), 0, "penolakan otorisasi tidak mencemari trail");
  assert.equal(await count(db, "public.notifications"), 0);

  await db.close();
});

// ---------------------------------------------------------------------------
// 3. Target: hanya membership id dari klien
// ---------------------------------------------------------------------------

test("membership id palsu ditolak; tidak ada efek samping", async () => {
  const db = await createDb();
  await seedWorld(db);

  const ghost = "99999999-9999-4999-8999-999999999999";
  const outcome = await revokeAsService(db, ADMIN, ghost);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "invalid_target");
  assert.equal(outcome.notified, false);
  assert.match(String(outcome.message), /tidak ditemukan/i);

  // Id null ditolak tegas.
  await setAuthUid(db, null);
  await db.exec("set role service_role;");
  try {
    await db.query(`select public.revoke_producer_place_access($1::uuid, null)`, [ADMIN]);
    assert.fail("expected membership_target_invalid");
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match((error as Error).message, /membership_target_invalid/);
  } finally {
    await db.exec("reset role;");
  }

  assert.equal(await count(db, "public.producer_memberships"), 6, "tidak satu baris pun terhapus");
  assert.equal(await count(db, "public.notifications"), 0);
  assert.equal(await count(db, "public.place_audit"), 0);

  await db.close();
});

test("RPC hanya menerima SATU id: Produser dan Tempat diturunkan dari baris DB", async () => {
  const db = await createDb();
  await seedWorld(db);

  // Signature: (uuid, uuid) — tidak ada masukan produser/place.
  const args = await rows(
    db,
    `select pg_get_function_arguments(oid) as args, prosecdef, proconfig::text as config
       from pg_proc where proname = 'revoke_producer_place_access'`,
  );
  assert.equal(args.length, 1);
  assert.equal(args[0].args, "p_actor_id uuid, p_membership_id uuid");
  assert.equal(args[0].prosecdef, true, "SECURITY DEFINER");
  assert.match(String(args[0].config), /search_path=public/, "search_path dipin");

  // Id milik PLACE_A dicabut → hanya baris itu yang hilang; Place lain milik
  // Produser yang sama (OWNER di PLACE_B) sama sekali tidak tersentuh.
  const targetB = await membershipId(db, OWNER, PLACE_B);
  const targetA = await membershipId(db, MANAGER, PLACE_A);
  const outcome = await revokeAsService(db, ADMIN, targetA);
  assert.equal(outcome.status, "revoked");

  assert.equal(
    (
      await rows(
        db,
        `select role from public.producer_memberships where id = $1::uuid`,
        [targetB],
      )
    ).length,
    1,
    "membership Place lain milik Produser lain tetap utuh",
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// 4. Pengaman owner terakhir
// ---------------------------------------------------------------------------

test("owner terakhir DITOLAK (fail-closed) + audit penolakan, tanpa notifikasi", async () => {
  const db = await createDb();
  await seedWorld(db);

  // PLACE_C hanya punya satu owner (OWNER_2).
  const loneOwner = await membershipId(db, OWNER_2, PLACE_C);
  const outcome = await revokeAsService(db, ADMIN, loneOwner);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "last_owner");
  assert.equal(outcome.placeName, "Dapur Rasa");
  assert.match(String(outcome.message), /tanpa Pemilik/i);

  assert.equal(
    (await rows(db, `select 1 from public.producer_memberships where id = $1::uuid`, [loneOwner]))
      .length,
    1,
    "baris owner terakhir tetap ada",
  );
  assert.equal(await count(db, "public.notifications"), 0, "penolakan tidak membuat notifikasi");

  const denied = await auditRows(db, "producer_place_access_revoke_denied");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].place_id, PLACE_C);
  assert.equal(denied[0].actor_id, ADMIN);
  const detail = denied[0].detail as Record<string, unknown>;
  assert.equal(detail.reason, "last_owner");
  assert.equal(detail.result, "denied");
  assert.equal(detail.membership_id, loneOwner);

  await db.close();
});

test("owner non-terakhir, manager, dan editor tetap dapat dicabut", async () => {
  const db = await createDb();
  await seedWorld(db);

  // owner non-terakhir (PLACE_A punya dua owner).
  assert.equal((await revokeAsService(db, ADMIN, await membershipId(db, OWNER, PLACE_A))).status, "revoked");
  // manager.
  assert.equal((await revokeAsService(db, ADMIN, await membershipId(db, MANAGER, PLACE_A))).status, "revoked");
  // editor.
  assert.equal((await revokeAsService(db, ADMIN, await membershipId(db, EDITOR, PLACE_A))).status, "revoked");

  const remaining = await rows(
    db,
    `select user_id, role from public.producer_memberships where place_id = $1::text order by user_id`,
    [PLACE_A],
  );
  assert.deepEqual(
    remaining.map((r) => `${r.user_id}:${r.role}`),
    [`${OWNER_2}:owner`],
    "hanya owner terakhir yang tersisa",
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// 5. Idempotensi, isolasi, integritas data
// ---------------------------------------------------------------------------

test("pencabutan ganda idempoten: hasil 'sudah dicabut', tanpa audit/notifikasi ganda", async () => {
  const db = await createDb();
  await seedWorld(db);

  const target = await membershipId(db, MANAGER, PLACE_A);
  const first = await revokeAsService(db, ADMIN, target);
  assert.equal(first.status, "revoked");
  const notifAfterFirst = await count(db, "public.notifications");

  const second = await revokeAsService(db, ADMIN, target);
  assert.equal(second.ok, false);
  assert.equal(second.status, "already_revoked");
  assert.equal(second.notified, false);
  assert.equal(second.placeName, "Rumah Teh Lokal");
  assert.match(String(second.message), /sudah dicabut sebelumnya/i);

  assert.equal(await count(db, "public.notifications"), notifAfterFirst, "tidak ada notifikasi ganda");
  assert.equal((await auditRows(db, "producer_place_access_revoked")).length, 1, "audit tidak digandakan");

  // Bahkan admin kedua yang mencoba juga mendapat jawaban idempoten yang sama.
  const third = await revokeAsService(db, ADMIN_2, target);
  assert.equal(third.status, "already_revoked");
  assert.equal(await count(db, "public.notifications"), notifAfterFirst);

  await db.close();
});

test("mencabut satu Tempat tidak memengaruhi Tempat lain milik Produser yang sama", async () => {
  const db = await createDb();
  await seedWorld(db);

  const targetA = await membershipId(db, OWNER, PLACE_A);
  assert.equal((await revokeAsService(db, ADMIN, targetA)).status, "revoked");

  const remaining = await rows(
    db,
    `select place_id, role, producer_id from public.producer_memberships
      where user_id = $1::uuid order by place_id`,
    [OWNER],
  );
  assert.deepEqual(
    remaining.map((r) => `${r.place_id}:${r.role}`),
    [`${PLACE_B}:owner`],
    "hanya membership pada Tempat yang dicabut yang hilang",
  );

  // Notifikasi Produser yang dicabut hanya tentang Tempat yang dicabut.
  const notifs = await notificationsFor(db, OWNER);
  assert.equal(notifs.length, 1, "satu pesan untuk Produser yang dicabut");
  const meta = notifs[0];
  assert.equal(meta.event_type, "producer_place_access_revoked");
  assert.match(String(meta.body), /Rumah Teh Lokal/);
  assert.doesNotMatch(String(meta.body), /Kopi dari Kebun/);

  await db.close();
});

test("hitung baris: hanya producer_memberships yang berubah", async () => {
  const db = await createDb();
  await seedWorld(db);

  const tables = [
    "auth.users",
    "public.users",
    "public.producers",
    "public.places",
    "public.experiences",
    "public.visit_intents",
    "public.notification_preferences",
  ];
  const before: Record<string, number> = {};
  for (const table of tables) before[table] = await count(db, table);
  const membershipsBefore = await count(db, "public.producer_memberships");

  assert.equal((await revokeAsService(db, ADMIN, await membershipId(db, MANAGER, PLACE_A))).status, "revoked");
  assert.equal((await revokeAsService(db, ADMIN, await membershipId(db, EDITOR, PLACE_A))).status, "revoked");

  for (const table of tables) {
    assert.equal(await count(db, table), before[table], `${table} tidak boleh berubah`);
  }
  assert.equal(await count(db, "public.producer_memberships"), membershipsBefore - 2);

  // Place masih ada dan tidak diarsipkan/diubah status kepemilikannya.
  const place = await rows(db, `select publication_status, producer_id, claim_status from public.places where id = $1::text`, [PLACE_A]);
  assert.equal(place[0].publication_status, "published");
  assert.equal(place[0].producer_id, null);
  assert.equal(place[0].claim_status, "unverified");

  await db.close();
});

// ---------------------------------------------------------------------------
// 6. Pencabutan berlaku segera (tanpa cache)
// ---------------------------------------------------------------------------

test("Produser yang dicabut langsung kehilangan akses kelola (gate server + RLS)", async () => {
  const db = await createDb();
  await seedWorld(db);

  // Sebelum: MANAGER adalah manager PLACE_A, dan bisa membaca Place draft.
  await db.exec(`update public.places set publication_status = 'draft' where id = '${PLACE_A}'`);
  await setAuthUid(db, MANAGER);
  await db.exec("set role authenticated;");
  const before = await rows(db, `select id from public.places where id = $1::text`, [PLACE_A]);
  await db.exec("reset role;");
  assert.equal(before.length, 1, "manager yang masih aktif bisa membaca Place draft-nya");

  assert.equal((await revokeAsService(db, ADMIN, await membershipId(db, MANAGER, PLACE_A))).status, "revoked");

  // Sesudah: gate server (query membership) dan RLS sama-sama menolak.
  assert.equal(
    (
      await rows(
        db,
        `select 1 from public.producer_memberships where user_id = $1::uuid and place_id = $2::text`,
        [MANAGER, PLACE_A],
      )
    ).length,
    0,
    "gate otorisasi Produser membaca baris ini → sekarang kosong",
  );

  await setAuthUid(db, MANAGER);
  await db.exec("set role authenticated;");
  const after = await rows(db, `select id from public.places where id = $1::text`, [PLACE_A]);
  await db.exec("reset role;");
  assert.equal(after.length, 0, "RLS places_public_read menolak Place draft yang tak lagi dikelola");

  // Place yang diterbitkan tetap terlihat (bukan Place yang disembunyikan).
  await setAuthUid(db, MANAGER);
  await db.exec("set role authenticated;");
  const published = await rows(db, `select id from public.places where id = $1::text`, [PLACE_B]);
  await db.exec("reset role;");
  assert.equal(published.length, 1);

  await db.close();
});

// ---------------------------------------------------------------------------
// 7. Audit & notifikasi: batas akses klien
// ---------------------------------------------------------------------------

test("anon dan non-admin tidak dapat membaca atau menulis audit", async () => {
  const db = await createDb();
  await seedWorld(db);
  await revokeAsService(db, ADMIN, await membershipId(db, MANAGER, PLACE_A));
  assert.equal((await auditRows(db, "producer_place_access_revoked")).length, 1, "fixture audit ada");

  for (const [role, userId] of [
    ["authenticated", ADMIN],
    ["authenticated", REGULAR],
    ["anon", REGULAR],
  ] as const) {
    await setAuthUid(db, userId);
    await db.exec(`set role ${role};`);
    try {
      await db.query(`select id from public.place_audit`);
      assert.fail(`${role} must not read place_audit`);
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      assert.match((error as Error).message, /permission denied/i);
    }
    try {
      await db.query(
        `insert into public.place_audit (place_id, actor_id, action) values ('${PLACE_A}', '${ADMIN}'::uuid, 'producer_place_access_revoked')`,
      );
      assert.fail(`${role} must not insert into place_audit`);
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      assert.match((error as Error).message, /permission denied|row-level security/i);
    } finally {
      await db.exec("reset role;");
    }
  }

  await db.close();
});

test("klien hanya bisa membaca notifikasinya sendiri, dan tidak bisa membuat/mengubahnya", async () => {
  const db = await createDb();
  await seedWorld(db);
  await revokeAsService(db, ADMIN, await membershipId(db, MANAGER, PLACE_A));

  // Penerima membaca miliknya sendiri.
  await setAuthUid(db, MANAGER);
  await db.exec("set role authenticated;");
  const own = await rows(db, `select id, title from public.notifications`);
  assert.equal(own.length, 1, "hanya notifikasi miliknya yang terlihat");
  // Tapi tidak notifikasi pengguna lain.
  assert.equal((await notificationsFor(db, MANAGER)).length, 1);
  // Menandai dibaca diizinkan pada barisnya sendiri.
  await db.query(`update public.notifications set read_at = now() where id = $1::uuid`, [String(own[0].id)]);
  // Mengubah kolom lain ditolak (grant kolom + trigger).
  try {
    await db.query(`update public.notifications set title = 'diubah' where id = $1::uuid`, [String(own[0].id)]);
    assert.fail("kolom title tidak boleh bisa diubah klien");
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match((error as Error).message, /permission denied|Notifications allow only read_at/i);
  }
  // Insert dari klien ditolak.
  try {
    await db.query(
      `insert into public.notifications (user_id, category, event_type, title, body)
       values ('${MANAGER}'::uuid, 'system', 'palsu', 'x', 'y')`,
    );
    assert.fail("klien tidak boleh membuat notifikasi");
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match((error as Error).message, /permission denied|row-level security/i);
  }
  await db.exec("reset role;");

  // Penerima lain tidak melihat notifikasi orang lain.
  await setAuthUid(db, REGULAR);
  await db.exec("set role authenticated;");
  assert.equal((await rows(db, `select id from public.notifications`)).length, 0);
  await db.exec("reset role;");

  // anon tanpa grant.
  const anonPriv = await rows(
    db,
    `select has_table_privilege('anon', 'public.notifications', 'select') as ok`,
  );
  assert.equal(anonPriv[0].ok, false, "anon tidak punya SELECT pada notifications");

  await db.close();
});

// ---------------------------------------------------------------------------
// 8. Kegagalan notifikasi tidak membatalkan pencabutan
// ---------------------------------------------------------------------------

test("kegagalan notifikasi tidak membatalkan pencabutan, dan tercatat di audit", async () => {
  const db = await createDb();
  await seedWorld(db);

  // Penulis notifikasi dipaksa gagal (mensimulasikan gangguan), persis pola
  // kegagalan yang dijaga MASTER 10 §17.
  await db.exec(`
    create or replace function public.notify_recipient(
      p_user_id uuid, p_category text, p_event_type text, p_title text, p_body text,
      p_place_id text default null, p_source_type text default null,
      p_source_id text default null, p_metadata jsonb default '{}'::jsonb
    ) returns void language plpgsql as $$
    begin
      raise exception 'simulated_notification_outage';
    end;
    $$;
  `);

  const target = await membershipId(db, MANAGER, PLACE_A);
  const outcome = await revokeAsService(db, ADMIN, target);
  assert.equal(outcome.ok, true, "pencabutan tetap berhasil");
  assert.equal(outcome.status, "revoked");
  assert.equal(outcome.notified, false, "UI harus diberi tahu bahwa notifikasi gagal");

  // Perubahan bisnis bertahan.
  assert.equal(
    (await rows(db, `select 1 from public.producer_memberships where id = $1::uuid`, [target])).length,
    0,
  );
  // Dicatat di audit.
  const revoked = await auditRows(db, "producer_place_access_revoked");
  assert.equal(revoked.length, 1);
  assert.equal((revoked[0].detail as Record<string, unknown>).result, "revoked_notification_failed");
  assert.match(
    String((revoked[0].detail as Record<string, unknown>).notification_error),
    /simulated_notification_outage/,
  );
  // Tidak ada notifikasi setengah jadi.
  assert.equal(await count(db, "public.notifications"), 0);

  await db.close();
});

// ---------------------------------------------------------------------------
// 9. Kontrak kunci baris (konkurensi sungguhan = NOT RUN)
// ---------------------------------------------------------------------------

test("RPC mengunci baris target dan baris owner (FOR UPDATE) sebelum memutuskan", () => {
  const sql = readMigration("0057_admin_revoke_producer_place_access.sql");
  assert.match(sql, /where m\.id = p_membership_id\s*\n\s*for update/);
  assert.match(sql, /where m\.place_id = v_place_id and m\.role = 'owner'\s*\n\s*order by m\.user_id\s*\n\s*for update/);
  assert.match(sql, /count\(\*\)::integer into v_owner_count/);
  // Least privilege: RPC hanya untuk service_role.
  assert.match(sql, /revoke all on function public\.revoke_producer_place_access\(uuid, uuid\)\s*\n\s*from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.revoke_producer_place_access\(uuid, uuid\) to service_role;/);
  // Tidak ada GRANT baru ke anon.
  assert.doesNotMatch(sql, /grant [^;]*to anon/i);
  assert.doesNotMatch(sql, /disable row level security/i);
});

test("service_role punya EXECUTE, dan fungsi memverifikasi admin di dalam DB", async () => {
  const db = await createDb();
  const priv = await rows(
    db,
    `select has_function_privilege('service_role', 'public.revoke_producer_place_access(uuid, uuid)', 'execute') as ok`,
  );
  assert.equal(priv[0].ok, true);

  const anon = await rows(
    db,
    `select has_function_privilege('anon', 'public.revoke_producer_place_access(uuid, uuid)', 'execute') as ok`,
  );
  assert.equal(anon[0].ok, false);

  const sql = readMigration("0057_admin_revoke_producer_place_access.sql");
  assert.match(sql, /u\.platform_role = 'platform_moderator'/);
  assert.match(sql, /v_actor := auth\.uid\(\);/);

  await db.close();
});
