-- 0031 — PLACE AUDIT: an append-only, attributable trail of administrative
-- action on a Place (MASTER 09 §2 / §13).
--
-- GAP THIS MIGRATION FILLS
-- Until now, every important Admin action on a Place (created, edited,
-- published, paused, archived, restored, claim approved, claim rejected)
-- happened with no durable record of WHO did it or WHAT changed. The Place
-- row keeps only `updated_at`, so the current state was visible and the
-- sequence of decisions behind it was not. MASTER 09 §2 requires that
-- "Administrative action must be attributable to an authenticated admin
-- identity and recorded in an audit trail", and §13 requires that every
-- privileged state-changing action record actor, action, target, timestamp,
-- result and reason/context. The Live domain already has this (0008's
-- `live_audit`); Place did not.
--
-- RULES HONOURED
-- - §13 APPEND-ONLY. A `before update or delete` trigger raises for every
--   writer, the service role included. A trail that can be rewritten is not a
--   trail. The model mirrors 0008's `block_live_audit_mutation` exactly.
-- - §13/§14 FAIL CLOSED ON ACCESS. RLS is enabled and the table is revoked
--   from `public`, `anon` and `authenticated` with NO policy at all, so no
--   client — not even a signed-in Producer or a signed-in User — can select
--   or write a row. Reads and writes go through server code (service role)
--   AFTER the session-derived Platform Admin guard, the same posture as
--   0028's `place_claims`. There is deliberately no client-facing RPC.
-- - §2 ATTRIBUTION IS NOT OPTIONAL. `actor_id` is NOT NULL and references
--   `public.users(id)` ON DELETE RESTRICT: an Admin account that appears in a
--   Place audit trail cannot be deleted out from under it. Deletes of
--   `public.users` are not performed anywhere in the application, so this
--   constrains nothing today and protects the trail tomorrow.
-- - §8/§15 NOTHING IS DESTROYED. This trail is a new, additive table. It
--   changes no existing table, policy, function body, or grant, and it never
--   deletes a Place: `place_id` references `public.places(id)` with the
--   default NO ACTION precisely because a Place must never be removed
--   (§8 "Deletion should be exceptional", §15 "Archived resources remain
--   internally traceable"). If a Place row disappeared, the trail could not
--   silently vanish with it.
-- - AGENTS.md IDEMPOTENCY. Every statement is `if not exists` / `on
--   conflict`-safe, and the trigger is dropped before it is created, so
--   re-applying the file is a no-op.
--
-- PRIVACY: `before_data` / `after_data` snapshot the canonical Place columns
-- only. No user email, no credential, and no infrastructure value is ever
-- written to this table. `detail` carries the operator-facing reason
-- (currently a Place claim review note) and nothing else.
--
-- SCOPE: one new table, one append-only trigger, one index. Safe re-apply.

create table if not exists public.place_audit (
  id bigserial primary key,
  -- NOT NULL: an administrative action with no attributable identity is
  -- exactly what this table exists to make impossible. NO ACTION (the
  -- Postgres default) is kept on purpose — see the §8/§15 note above.
  place_id text not null references public.places(id),
  actor_id uuid not null references public.users(id) on delete restrict,
  action text not null check (action in (
    -- Platform Admin Place operations (workspace).
    'admin_place_created',
    'admin_place_updated',
    'admin_place_published',
    'admin_place_paused',
    'admin_place_archived',
    'admin_place_restored',
    -- Platform Admin Place claim decisions (the single ownership path).
    'place_claim_approved',
    'place_claim_rejected'
  )),
  -- Canonical Place column snapshots, so a decision can be read back without
  -- replaying history. Nullable on 'created' (there is no "before").
  before_data jsonb,
  after_data jsonb,
  -- Operator-facing reason/context, bounded in practice by the caller.
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- The Riwayat read is always "newest first for this Place"; without this the
-- workspace would degrade into a sequential scan as trails accumulate.
create index if not exists place_audit_place_created_idx
on public.place_audit (place_id, created_at desc);

create index if not exists place_audit_actor_created_idx
on public.place_audit (actor_id, created_at desc);

-- Append-only (MASTER 09 §13): the trail is written once and never
-- corrected in place. A wrong entry is superseded by a later one, which is
-- why the snapshots are kept instead of being updated.
create or replace function public.block_place_audit_mutation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  raise exception 'place_audit is append-only';
end;
$$;

drop trigger if exists place_audit_block_mutation on public.place_audit;
create trigger place_audit_block_mutation
before update or delete on public.place_audit
for each row execute procedure public.block_place_audit_mutation();

-- Fail closed, mirroring 0028's `place_claims` and 0008's `live_audit`: RLS
-- on, zero policies, and every client role stripped. The service role
-- (server code behind the Platform Admin guard) is the only writer/reader.
alter table public.place_audit enable row level security;

revoke all on public.place_audit from public, anon, authenticated;

-- The trigger function is never called directly by anyone; trigger execution
-- runs as the table owner and is unaffected by EXECUTE grants (same reasoning
-- as 0013 for `block_live_audit_mutation`).
revoke execute on function public.block_place_audit_mutation()
from public, anon, authenticated;
