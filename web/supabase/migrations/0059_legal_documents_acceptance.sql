-- 0059 — DOKUMEN HUKUM BERVERSI + PERSETUJUAN (Ketentuan Penggunaan).
--
-- MENGAPA
-- Kebijakan pengelolaan digital permanen (0058) harus DAPAT DIAKSES pengguna
-- melalui aplikasi dan tunduk pada mekanisme versi + persetujuan, bukan hanya
-- hidup sebagai teks di dalam kode. Sebelum migrasi ini tidak ada satu pun
-- dokumen hukum berversi maupun catatan persetujuan di platform — jadi
-- mekanismenya DIDIRIKAN di sini, sekecil mungkin dan tanpa mengklaim apa pun
-- yang belum ditinjau.
--
-- ATURAN
-- - `legal_documents` adalah daftar resmi dokumen + VERSI BERLAKU-nya. Isi prosa
--   dokumen tetap satu sumber di kode (web/lib/legal/documents.ts) supaya tidak
--   ada dua salinan teks yang bisa berbeda; tabel ini memegang identitas,
--   versi, tanggal berlaku, dan apakah persetujuan diwajibkan.
-- - `legal_document_acceptances` adalah catatan APPEND-ONLY: (user, dokumen,
--   versi, waktu). Tidak ada UPDATE/DELETE — dari klien (tanpa policy) maupun
--   dari service_role (trigger penjaga), konsisten dengan `place_audit` (0031).
-- - Versi yang diterima harus SAMA dengan versi yang berlaku saat itu: policy
--   INSERT menolak versi yang tidak cocok / tidak mewajibkan persetujuan, jadi
--   klien tidak dapat memalsukan "sudah setuju" untuk versi lain.
-- - `legal_documents` hanya boleh DIBACA klien. Isi resminya ditulis lewat
--   migrasi, bukan dari aplikasi.
-- - Tidak ada klaim "sudah ditinjau hukum" di mana pun. Dokumennya ditandai
--   menunggu peninjauan hukum pada lapisan tampilan.
--
-- NON-DESTRUKTIF & FORWARD-ONLY. Tidak ada tabel, kolom, policy, atau baris
-- lama yang diubah/dihapus. Idempoten (aman dijalankan ulang).

-- ---------------------------------------------------------------------------
-- 1. Tabel
-- ---------------------------------------------------------------------------
create table if not exists public.legal_documents (
  id                  text primary key,
  title               text not null,
  version             text not null,
  effective_at        timestamptz not null,
  requires_acceptance boolean not null default true,
  updated_at          timestamptz not null default now()
);

comment on table public.legal_documents is
  'Dokumen hukum resmi + versi yang berlaku (0059). Prosa dokumen hidup di web/lib/legal/documents.ts; baris ini memegang identitas, versi, tanggal berlaku, dan kewajiban persetujuan.';

create table if not exists public.legal_document_acceptances (
  user_id     uuid not null references public.users(id) on delete cascade,
  document_id text not null references public.legal_documents(id),
  version     text not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, document_id, version)
);

comment on table public.legal_document_acceptances is
  'Catatan persetujuan dokumen hukum, APPEND-ONLY (0059). Satu baris per (akun, dokumen, versi).';

create index if not exists legal_document_acceptances_user_idx
on public.legal_document_acceptances (user_id, document_id);

-- ---------------------------------------------------------------------------
-- 2. Append-only + RLS + grant
-- ---------------------------------------------------------------------------
create or replace function public.block_legal_acceptance_mutation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  raise exception 'legal_document_acceptances is append-only';
end;
$$;

drop trigger if exists legal_acceptances_block_mutation on public.legal_document_acceptances;
create trigger legal_acceptances_block_mutation
before update or delete on public.legal_document_acceptances
for each row execute function public.block_legal_acceptance_mutation();

alter table public.legal_documents enable row level security;
alter table public.legal_document_acceptances enable row level security;

-- Dokumen resmi: dapat dibaca siapa pun (disclosure publik), tidak pernah
-- ditulis dari aplikasi.
drop policy if exists legal_documents_public_read on public.legal_documents;
create policy legal_documents_public_read on public.legal_documents
  for select to anon, authenticated using (true);

-- Persetujuan: akun hanya melihat dan membuat barisnya sendiri, dan hanya untuk
-- versi yang benar-benar berlaku.
drop policy if exists legal_acceptances_select_own on public.legal_document_acceptances;
create policy legal_acceptances_select_own on public.legal_document_acceptances
  for select to authenticated using (user_id = auth.uid());

drop policy if exists legal_acceptances_insert_own on public.legal_document_acceptances;
create policy legal_acceptances_insert_own on public.legal_document_acceptances
  for insert to authenticated with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.legal_documents d
      where d.id = legal_document_acceptances.document_id
        and d.version = legal_document_acceptances.version
        and d.requires_acceptance
    )
  );

revoke all on public.legal_documents from public, anon, authenticated;
revoke all on public.legal_document_acceptances from public, anon, authenticated;
grant select on public.legal_documents to anon, authenticated;
grant select, insert on public.legal_document_acceptances to authenticated;
revoke execute on function public.block_legal_acceptance_mutation()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Data awal: Ketentuan Penggunaan versi 1.1
-- ---------------------------------------------------------------------------
-- Versi 1.1 menambahkan bagian "Kewenangan Pengelolaan Digital dan Pencabutan
-- Akses" (kebijakan permanen 0058). Versinya HARUS sama dengan
-- web/lib/legal/documents.ts; tests/legal-documents.test.ts gagal bila berbeda.
insert into public.legal_documents (id, title, version, effective_at, requires_acceptance)
values (
  'ketentuan-penggunaan',
  'Ketentuan Penggunaan',
  '1.1',
  timestamptz '2026-10-15T00:00:00Z',
  true
)
on conflict (id) do update
  set title = excluded.title,
      version = excluded.version,
      effective_at = excluded.effective_at,
      requires_acceptance = excluded.requires_acceptance,
      updated_at = now();
