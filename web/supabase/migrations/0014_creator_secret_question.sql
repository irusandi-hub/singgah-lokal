-- 0014: Creator secret question storage (Authority Master §2).
--
-- The Creator is the only tier with this credential layer. The table is
-- fail-closed: RLS is enabled and NO policies are created, so anon and
-- authenticated roles can never read or write any row — even their own.
-- Access happens exclusively server-side through the service-role client
-- guarded by requireCreator() (web/lib/creator/security-settings.ts).
--
-- The answer is never stored in plaintext: the server stores a per-row
-- random salt plus an scrypt hash (web/lib/creator/security-settings.ts).
-- The question text is Creator-authored display text shown back at
-- verification time; only the answer is a secret.

create table if not exists public.creator_secret_question (
  user_id uuid primary key references auth.users (id) on delete cascade,
  question text not null check (char_length(question) between 1 and 200),
  answer_salt text not null,
  answer_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.creator_secret_question enable row level security;

-- Deliberately no CREATE POLICY: fail-closed by design. service_role
-- bypasses RLS and is the only path to this table, and that path lives
-- behind server-side Creator authorization only.
