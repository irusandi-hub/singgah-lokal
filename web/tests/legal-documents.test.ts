import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync, existsSync } from "node:fs";

import {
  KETENTUAN_PENGGUNAAN,
  LEGAL_DOCUMENTS,
  LEGAL_REVIEW_NOTICE,
  legalDocumentById,
} from "../lib/legal/documents";
import { LEGAL_DOCUMENT_IDS } from "../lib/legal/documents";

/**
 * DOKUMEN HUKUM BERVERSI (migration 0059) — Ketentuan Penggunaan + persetujuan.
 *
 * Yang dibuktikan:
 * 1. register dokumen + catatan persetujuan APPEND-ONLY ada di rantai migrasi
 *    nyata (PGlite), idempoten, RLS menyala, dan grant-nya least privilege;
 * 2. versi yang berlaku di database SAMA dengan versi yang dinyatakan kode —
 *    satu sumber untuk prosa, satu versi untuk keduanya;
 * 3. klien hanya dapat menyetujui VERSI YANG BERLAKU dan hanya untuk dirinya
 *    sendiri; versi lain, akun lain, update, dan delete ditolak;
 * 4. kebijakan pengelolaan digital benar-benar ada di dokumen (setiap prinsip
 *    material dari instruksi produk), dan tidak ada tempat mana pun yang
 *    mengklaim dokumen ini sudah ditinjau hukum;
 * 5. dokumen dapat diakses lewat aplikasi: halaman /ketentuan, kartu
 *    persetujuan di /account, checkbox di pendaftaran, dan pencatatan
 *    persetujuan di route pendaftaran;
 * 6. 0059 tidak menyentuh tabel/data kebijakan lain (place_audit, places,
 *    producer_memberships, notifications).
 */

const MIGRATION_DIR = "../supabase/migrations/";
const readMigration = (name: string) =>
  readFileSync(new URL(MIGRATION_DIR + name, import.meta.url), "utf8");
const stripPgcrypto = (s: string) => s.replace(/create extension if not exists pgcrypto;?/gim, "");
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const ALL_MIGRATIONS = readdirSync(new URL(MIGRATION_DIR, import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort();

const LEGAL_MIGRATION = "0059_legal_documents_acceptance.sql";
const USER = "eeee0000-0000-4000-8000-000000000001";
const OTHER_USER = "eeee0000-0000-4000-8000-000000000002";

type Row = Record<string, unknown>;
const rows = async (db: PGlite, query: string, params: unknown[] = []): Promise<Row[]> =>
  ((await db.query(query, params)).rows ?? []) as Row[];

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
    grant usage on schema auth to anon, authenticated;

    create schema if not exists realtime;
    create table realtime.messages (id bigserial primary key, topic text, extension text, event text, payload jsonb);
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to anon, authenticated;
    grant select on realtime.messages to anon, authenticated;
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
  for (const name of ALL_MIGRATIONS) {
    await db.exec(stripPgcrypto(readMigration(name)));
    if (name === "0001_visit_intent_foundation.sql") {
      // Supabase grants default table privileges when a table is CREATED, i.e.
      // before each migration's explicit REVOKE/GRANT runs. Applying them here
      // is what makes the lockdowns the real posture rather than a no-op.
      await db.exec(
        `grant usage on schema public to anon, authenticated, service_role;
         grant all on all tables in schema public to anon, authenticated;
         grant usage, select on all sequences in schema public to anon, authenticated;`,
      );
    }
  }
  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at)
    values ('${USER}', 'legal@example.com', now()), ('${OTHER_USER}', 'other@example.com', now())
    on conflict (id) do nothing;
    insert into public.users (id) values ('${USER}'), ('${OTHER_USER}') on conflict (id) do nothing;
  `);
  return db;
}

/** Run a statement as a client role with a session, expecting it to be refused. */
async function expectDenied(
  db: PGlite,
  userId: string,
  role: "anon" | "authenticated",
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await db.exec("reset role;");
  await db.exec(
    `create or replace function auth.uid() returns uuid language sql stable as $fn$ select '${userId}'::uuid $fn$`,
  );
  await db.exec(`set role ${role};`);
  try {
    await db.query(sql, params);
    assert.fail(`expected refusal for: ${sql}`);
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match(
      (error as Error).message,
      /permission denied|row-level security|append-only/i,
      `unexpected error: ${(error as Error).message}`,
    );
  } finally {
    await db.exec("reset role;");
  }
}

// ---------------------------------------------------------------------------
// 1. Register + catatan persetujuan pada rantai migrasi nyata
// ---------------------------------------------------------------------------

test("0059: register dokumen + catatan persetujuan ada, idempoten, dan versinya cocok dengan kode", async () => {
  const db = await createDb();

  // Idempoten: menerapkan ulang tidak error dan tidak menggandakan baris.
  await db.exec(stripPgcrypto(readMigration(LEGAL_MIGRATION)));
  await db.exec(stripPgcrypto(readMigration(LEGAL_MIGRATION)));

  const documents = await rows(
    db,
    `select id, title, version, requires_acceptance from public.legal_documents order by id`,
  );
  assert.equal(documents.length, LEGAL_DOCUMENTS.length, "satu baris register per dokumen kode");

  for (const document of LEGAL_DOCUMENTS) {
    const stored = documents.find((row) => row.id === document.id);
    assert.ok(stored, `register harus memuat dokumen ${document.id}`);
    assert.equal(stored.title, document.title);
    assert.equal(
      stored.version,
      document.version,
      `${document.id}: versi register harus sama dengan versi kode (satu sumber versi)`,
    );
    assert.equal(stored.requires_acceptance, document.requiresAcceptance);
  }

  // Dokumen kebijakan digital benar-benar versi 1.1 dan wajib disetujui.
  const ketentuan = documents.find((row) => row.id === LEGAL_DOCUMENT_IDS.ketentuanPenggunaan);
  assert.ok(ketentuan, "register harus memuat Ketentuan Penggunaan");
  assert.equal(ketentuan.version, "1.1");
  assert.equal(ketentuan.requires_acceptance, true);

  // RLS menyala di kedua tabel, dan hanya policy yang dimaksud yang ada.
  for (const table of ["public.legal_documents", "public.legal_document_acceptances"]) {
    const rls = await rows(db, `select relrowsecurity as on_ from pg_class where oid = '${table}'::regclass`);
    assert.equal(rls[0].on_, true, `${table} harus RLS-on`);
  }
  const policies = await rows(
    db,
    `select tablename, policyname, cmd from pg_policies
      where schemaname='public' and tablename in ('legal_documents','legal_document_acceptances')
      order by tablename, policyname`,
  );
  assert.deepEqual(
    policies.map((row) => `${row.tablename}:${row.cmd}`),
    ["legal_document_acceptances:INSERT", "legal_document_acceptances:SELECT", "legal_documents:SELECT"],
    "tidak ada policy UPDATE/DELETE — catatan persetujuan append-only",
  );

  await db.close();
});

test("0059: anon dapat membaca dokumen, tetapi tidak dapat menulis apa pun", async () => {
  const db = await createDb();

  const anonRead = await rows(
    db,
    `select has_table_privilege('anon', 'public.legal_documents', 'select') as docs,
            has_table_privilege('anon', 'public.legal_document_acceptances', 'select') as acceptances,
            has_table_privilege('anon', 'public.legal_document_acceptances', 'insert') as can_insert`,
  );
  assert.equal(anonRead[0].docs, true, "dokumen resmi bersifat publik (disclosure)");
  assert.equal(anonRead[0].acceptances, false, "anon tidak membaca catatan persetujuan");
  assert.equal(anonRead[0].can_insert, false, "anon tidak menulis persetujuan");

  await expectDenied(
    db,
    OTHER_USER,
    "anon",
    `insert into public.legal_document_acceptances (user_id, document_id, version)
     values ('${OTHER_USER}'::uuid, '${LEGAL_DOCUMENT_IDS.ketentuanPenggunaan}', '1.1')`,
  );

  await db.close();
});

test("persetujuan hanya untuk VERSI YANG BERLAKU dan hanya untuk akun sendiri", async () => {
  const db = await createDb();
  const docId = LEGAL_DOCUMENT_IDS.ketentuanPenggunaan;

  // Versi yang tidak berlaku ditolak (klien tidak bisa menandai "sudah setuju"
  // untuk versi lain).
  await expectDenied(
    db,
    USER,
    "authenticated",
    `insert into public.legal_document_acceptances (user_id, document_id, version)
     values ('${USER}'::uuid, '${docId}', '0.9')`,
  );
  // Dokumen yang tidak mewajibkan persetujuan / tidak dikenal ditolak.
  await expectDenied(
    db,
    USER,
    "authenticated",
    `insert into public.legal_document_acceptances (user_id, document_id, version)
     values ('${USER}'::uuid, 'dokumen-tidak-dikenal', '1.1')`,
  );
  // Menyetujui atas nama akun lain ditolak.
  await expectDenied(
    db,
    USER,
    "authenticated",
    `insert into public.legal_document_acceptances (user_id, document_id, version)
     values ('${OTHER_USER}'::uuid, '${docId}', '1.1')`,
  );

  // Versi yang berlaku, untuk dirinya sendiri: DITERIMA.
  await db.exec("reset role;");
  await db.exec(
    `create or replace function auth.uid() returns uuid language sql stable as $fn$ select '${USER}'::uuid $fn$`,
  );
  await db.exec("set role authenticated;");
  await db.query(
    `insert into public.legal_document_acceptances (user_id, document_id, version)
     values ('${USER}'::uuid, '${docId}', '1.1')`,
  );
  // Hanya miliknya sendiri yang terlihat.
  const own = await rows(db, `select user_id, version from public.legal_document_acceptances`);
  assert.equal(own.length, 1);
  assert.equal(own[0].user_id, USER);
  assert.equal(own[0].version, "1.1");
  await db.exec("reset role;");

  // Catatan persetujuan TIDAK dapat diubah atau dihapus siapa pun.
  await expectDenied(
    db,
    USER,
    "authenticated",
    `update public.legal_document_acceptances set version = '0.1' where user_id = '${USER}'::uuid`,
  );
  await expectDenied(
    db,
    USER,
    "authenticated",
    `delete from public.legal_document_acceptances where user_id = '${USER}'::uuid`,
  );
  await expectDenied(db, USER, "authenticated", `update public.legal_documents set version = '9.9'`);
  await expectDenied(db, USER, "authenticated", `delete from public.legal_documents`);
  await expectDenied(
    db,
    USER,
    "authenticated",
    `insert into public.legal_documents (id, title, version, effective_at)
     values ('palsu', 'Palsu', '1.0', now())`,
  );

  // service_role (server code) juga ditolak — tidak ada grant DELETE di sini.
  await db.exec("reset role; set role service_role;");
  try {
    await db.query(`delete from public.legal_document_acceptances`);
    assert.fail("service_role tidak boleh menghapus catatan persetujuan");
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match((error as Error).message, /permission denied|append-only/i);
  } finally {
    await db.exec("reset role;");
  }

  // Bahkan PEMILIK tabel (yang melewati RLS dan grant) ditahan oleh trigger
  // append-only — itulah jaminan sebenarnya bahwa catatan tidak dapat diubah.
  for (const statement of [
    `update public.legal_document_acceptances set version = '0.1'`,
    `delete from public.legal_document_acceptances`,
  ]) {
    try {
      await db.query(statement);
      assert.fail(`owner-level mutation must be blocked: ${statement}`);
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      assert.match((error as Error).message, /append-only/i);
    }
  }
  assert.equal((await rows(db, `select 1 from public.legal_document_acceptances`)).length, 1);

  await db.close();
});

test("0059 tidak menyentuh kebijakan/data lain (place_audit, places, memberships, notifications)", async () => {
  const db = await createDb();
  const code = stripComments(readMigration(LEGAL_MIGRATION));

  for (const untouched of [
    "place_audit",
    "producer_memberships",
    "notifications",
    "place_claims",
    "live_sessions",
    "revoke_producer_place_access",
  ]) {
    assert.doesNotMatch(code, new RegExp(untouched), `0059 must not touch ${untouched}`);
  }
  assert.doesNotMatch(code, /drop table/i);
  assert.doesNotMatch(code, /alter table public\.[a-z_]+ drop/i);
  assert.doesNotMatch(code, /disable row level security/i);

  // Posture tabel yang sudah ada tetap seperti semula.
  for (const table of ["public.places", "public.producer_memberships", "public.place_audit", "public.notifications"]) {
    const rls = await rows(db, `select relrowsecurity as on_ from pg_class where oid = '${table}'::regclass`);
    assert.equal(rls[0].on_, true, `${table} RLS tetap menyala`);
  }
  assert.equal(
    (await rows(db, `select count(*)::int as n from pg_policies where schemaname='public' and tablename='place_audit'`))[0].n,
    0,
    "place_audit tetap tanpa policy",
  );

  await db.close();
});

// ---------------------------------------------------------------------------
// 2. Isi dokumen: prinsip material kebijakan pengelolaan digital
// ---------------------------------------------------------------------------

test("Ketentuan Penggunaan memuat setiap prinsip material kebijakan pengelolaan digital", () => {
  const text = KETENTUAN_PENGGUNAAN.sections
    .flatMap((section) => [section.heading, ...section.paragraphs])
    .join("\n");

  const required = [
    // Ruang lingkup + batas platform.
    /platform digital yang menyediakan sarana untuk menampilkan, mempromosikan, dan mengelola informasi tempat secara online/i,
    /SINGGAH adalah pernyataan niat berkunjung/i,
    // Kewenangan digital ≠ kepemilikan hukum.
    /kewenangan digital sesuai dengan peran dan izin yang diberikan dalam platform/i,
    /tidak dengan sendirinya merupakan pengakuan, penetapan, atau jaminan atas kepemilikan hukum/i,
    /Kepemilikan nyata atas tempat tetap mengikuti bukti dan ketentuan hukum yang berlaku di dunia nyata\./i,
    // Hak admin mencabut + alasan yang sah.
    /berhak meninjau, membatasi, menangguhkan, atau mencabut kewenangan pengelolaan digital/i,
    /kebutuhan administratif, keamanan, kepatuhan terhadap ketentuan platform, laporan yang diterima, atau alasan lain yang sah/i,
    // Tempat managerless + tanpa pengganti + tidak menghapus data.
    /tetap tersimpan tanpa pengelola digital aktif/i,
    /tidak mengharuskan Singgah Lokal menunjuk pengelola pengganti/i,
    /tidak dengan sendirinya mengubah kepemilikan nyata atas tempat/i,
    /tidak dengan sendirinya menghapus data tempat atau riwayat administrasi/i,
    // Semua jalur otorisasi.
    /berlaku pada seluruh jalur kewenangan di platform/i,
    /Hanya penyembunyian tampilan bukan pencabutan\./i,
    // Tidak menyentuh yang tidak terkait.
    /tidak mengubah kewenangan atas tempat lain yang dikelola akun yang sama/i,
    /hanya melalui proses penugasan atau persetujuan resmi yang disediakan platform/i,
    // Peninjauan/keberatan.
    /dapat mengajukan peninjauan atau keberatan melalui mekanisme yang disediakan Singgah Lokal/i,
  ];
  for (const pattern of required) {
    assert.match(text, pattern);
  }

  // Rujukan ke kebijakan data & privasi, tanpa menggantikannya.
  assert.match(text, /halaman Kebijakan Data & Klaim Tempat/i);
});

test("tidak ada klaim bahwa ketentuan sudah ditinjau/final secara hukum", () => {
  assert.match(LEGAL_REVIEW_NOTICE, /menunggu peninjauan hukum/i);
  assert.match(LEGAL_REVIEW_NOTICE, /belum dinyatakan final secara hukum/i);

  for (const path of ["../app/ketentuan/page.tsx", "../lib/legal/documents.ts", "../app/policy/page.tsx"]) {
    const source = read(path);
    assert.doesNotMatch(
      source,
      /sudah ditinjau (oleh )?(tim )?hukum|telah ditinjau (secara )?hukum|disetujui bagian hukum|final secara hukum dan sah/i,
      `${path} tidak boleh mengklaim peninjauan hukum`,
    );
  }
  // Halaman dokumen WAJIB menampilkan penandanya.
  assert.match(stripComments(read("../app/ketentuan/page.tsx")), /LEGAL_REVIEW_NOTICE/);
});

test("identitas dokumen konsisten di kode, migration, dan halaman", () => {
  const migration = readMigration(LEGAL_MIGRATION);
  assert.match(migration, /'ketentuan-penggunaan'/);
  assert.match(migration, /'Ketentuan Penggunaan'/);
  assert.match(migration, /'1\.1'/);
  assert.equal(KETENTUAN_PENGGUNAAN.id, LEGAL_DOCUMENT_IDS.ketentuanPenggunaan);
  assert.equal(legalDocumentById(KETENTUAN_PENGGUNAAN.id)?.version, KETENTUAN_PENGGUNAAN.version);
  assert.equal(KETENTUAN_PENGGUNAAN.href, "/ketentuan");
  assert.equal(legalDocumentById("tidak-ada"), undefined);
});

// ---------------------------------------------------------------------------
// 3. Permukaan aplikasi: halaman, kartu persetujuan, dan pendaftaran
// ---------------------------------------------------------------------------

test("halaman /ketentuan ada, publik, dan menampilkan versi dari register", () => {
  assert.ok(existsSync(new URL("../app/ketentuan/page.tsx", import.meta.url)));
  const page = stripComments(read("../app/ketentuan/page.tsx"));
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /readLegalDocumentRegistry/);
  assert.match(page, /KETENTUAN_PENGGUNAAN\.sections\.map/);
  assert.match(page, /data-testid="ketentuan-version"/);
  assert.match(page, /data-testid="ketentuan-legal-review"/);
  // Tidak ada akses admin untuk membaca dokumen publik.
  assert.doesNotMatch(page, /requirePlatformModerator/);
});

test("halaman Kebijakan (permukaan yang sudah ada) mengungkap kebijakan digital dan menautkan ketentuan", () => {
  const policy = read("../app/policy/page.tsx");
  assert.match(policy, /data-testid="policy-digital-management"/);
  assert.match(policy, /kewenangan digital/i);
  assert.match(policy, /bukan pengakuan, penetapan, atau jaminan kepemilikan hukum/i);
  assert.match(policy, /tanpa wajib menunjuk pengelola pengganti/i);
  assert.match(policy, /href="\/ketentuan"/);

  // Tentang menautkan kedua permukaan resmi, tanpa menyalin isinya.
  const about = read("../app/about/page.tsx");
  assert.match(about, /href="\/ketentuan"/);
  assert.match(about, /href="\/policy"/);
});

test("alur persetujuan: kartu di /account, route tervalidasi, dan checkbox pendaftaran", () => {
  const acceptance = read("../lib/legal/acceptance.ts");
  assert.match(acceptance, /^import "server-only";/m);
  assert.match(acceptance, /readKetentuanAcceptanceState/);
  assert.match(acceptance, /acceptCurrentLegalDocument/);
  assert.match(acceptance, /recordLegalAcceptance/);
  // Versi ditulis server dari register, bukan dari klien.
  assert.match(acceptance, /if \(input\.version\.trim\(\) !== currentVersion\)/);

  const route = read("../app/api/legal/accept/route.ts");
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /supabase\.auth\.getUser\(\)/);
  assert.match(route, /status: 401/);
  assert.match(route, /isKnownLegalDocumentId/);
  assert.match(route, /userId: userData\.user\.id/);
  // Tidak ada user id dari klien.
  assert.doesNotMatch(stripComments(route), /body\.userId/);

  const account = read("../app/account/page.tsx");
  assert.match(account, /LegalAcceptancePrompt/);
  assert.match(account, /needsLegalAcceptance/);

  const prompt = read("../components/legal/legal-acceptance-prompt.tsx");
  assert.match(prompt, /"use client"/);
  assert.match(prompt, /data-testid="legal-acceptance-prompt"/);
  assert.match(prompt, /fetch\("\/api\/legal\/accept"/);

  // Pendaftaran: checkbox WAJIB + tautan dokumen, dan flag dikirim ke server.
  const signUpForm = read("../app/auth/sign-up/sign-up-form.tsx");
  assert.match(signUpForm, /id="acceptedTerms"/);
  assert.match(signUpForm, /type="checkbox"/);
  assert.match(signUpForm, /required/);
  assert.match(signUpForm, /href="\/ketentuan"/);
  assert.match(signUpForm, /acceptedTerms: true/);
  assert.match(signUpForm, /if \(!acceptedTerms\)/);

  // Route pendaftaran mencatat persetujuan untuk akun yang BARU dibuat vendor
  // auth, dengan versi dari register (bukan dari klien).
  const signUpRoute = stripComments(read("../app/api/auth/sign-up/route.ts"));
  assert.match(signUpRoute, /if \(body\.acceptedTerms === true && data\.user\?\.id\)/);
  assert.match(signUpRoute, /acceptCurrentLegalDocument\(\{/);
  assert.match(signUpRoute, /userId: data\.user\.id/);
  assert.doesNotMatch(signUpRoute, /body\.version/);
});
