-- 0039 — DUMMY PLACE + DEVELOPER AUTHORITY: the canonical Dummy flag.
--
-- MASTER_DEVELOPER_AUTHORITY_DUMMY_PLACE_v1.0 (new; see MASTER_INDEX_v1.0).
--
-- PURPOSE
-- A "Dummy Place" is data that exists only for development and testing. Until
-- this migration the concept had NO canonical representation: the DEV demo
-- Places seeded by 0037 are ordinary `published` rows whose only trace is the
-- words "Demo Place:" in a description. Nothing could be authorized against
-- that, because a free-text description is not a fact — it is editable by
-- anyone who can write a Place, so it is exactly the kind of "client-supplied
-- label" this Master forbids as a validation basis.
--
-- `public.places.is_dummy` is that canonical, server-side fact.
--
-- RULES HONOURED
-- - §4 ONE TRUSTED PATH. `is_dummy` may only be changed through the
--   service-role Creator path (the Developer Authority module). A guard
--   trigger, modelled on 0036's `block_place_is_curated_update`, refuses the
--   change from EVERY other writer — anon, authenticated, Producer, and
--   Platform Admin alike. Nobody, at any tier below Creator, can mark a Place
--   Dummy or unmark it, and no client can smuggle the flag through the generic
--   Place update paths.
-- - §4 NEVER INFERRED FROM TEXT. No statement in this migration (or 0040) ever
--   derives the flag from a name, description, or any other free text. The
--   only rows marked here are named EXPLICITLY by id, and only because 0037 is
--   the authoritative record of what those exact ids are. A Place that merely
--   contains the word "Demo" is NOT a Dummy Place.
-- - §4 NOT A MODERATION ROLE. Nothing here grants `platform_moderator` or any
--   operational moderation power. Authority Master §4 forbids modelling the
--   Creator as a moderator; this migration grants no database role at all.
-- - §6 NO BYPASS FOR ORDINARY OPERATIONS. 0036's `is_curated` lockdown is NOT
--   widened by this migration. The only `is_curated` writer remains the
--   audited service-role path. RLS, the append-only audit trigger from 0031,
--   and every existing policy are untouched.
-- - §5 APPEND-ONLY AUDIT. 0031's `block_place_audit_mutation` trigger keeps
--   guarding UPDATE/DELETE; this migration only EXTENDS the action vocabulary
--   with the Developer keys. No existing action, row, column or trigger of
--   `place_audit` is modified or removed.
-- - §3 AUDIT FAILURE MUST NOT LEAVE DATA. The write-then-audit ordering is
--   enforced in the application module (`setDeveloperPlaceDummy`), which rolls
--   the flag back when the audit write fails. The database cannot enforce that
--   ordering alone, so the module is the single writer and is covered by
--   regression tests.
-- - §8/§15 NOTHING IS DESTROYED. Additive only: one column, one index, one
--   guard trigger, one re-created CHECK. No Place, row, policy or grant is
--   deleted or rewritten. An existing non-Dummy Place keeps `false`.
-- - AGENTS.md IDEMPOTENCY. `add column if not exists`, `create index if not
--   exists`, constraints dropped before re-creation, and the guard trigger is
--   DROPPED BEFORE the explicit backfill and re-created after it — so
--   re-applying this file is a no-op and the backfill can never deadlock
--   against its own guard.
--
-- CURRENCY
-- `SAR` is admitted so DEV-only test Places can carry an honest currency for
-- their own geography. This does NOT change the initial market (still
-- Indonesia, MASTER 01): it widens the accepted vocabulary so a Place always
-- satisfies "Currency follows Place" instead of being forced to claim a
-- currency its geography does not have.

-- ---------------------------------------------------------------------------
-- 1. The canonical flag.
-- ---------------------------------------------------------------------------
alter table public.places
  add column if not exists is_dummy boolean not null default false;

create index if not exists places_is_dummy_idx
  on public.places (is_dummy)
  where is_dummy;

-- ---------------------------------------------------------------------------
-- 2. Trusted-path lock (mirrors 0036 for `is_curated`).
-- ---------------------------------------------------------------------------
-- Dropped BEFORE the backfill and re-created after it, so the migration's own
-- explicit backfill below is not refused by the guard it is about to install,
-- and so a re-apply is still a clean no-op.
drop trigger if exists places_is_dummy_update_guard on public.places;
drop function if exists public.block_place_is_dummy_update();

create or replace function public.block_place_is_dummy_update()
returns trigger
language plpgsql
as $$
begin
  if new.is_dummy is distinct from old.is_dummy then
    -- The Creator-controlled Developer Authority path writes through the
    -- SERVICE ROLE connection (current_user = service_role). Every other
    -- writer — anon, authenticated, Producer, Platform Admin, or any client
    -- using the generic Place UPDATE paths — is refused here. SECURITY is not
    -- an assumption about the caller: it is a closed allowlist of one.
    if current_user <> 'service_role' then
      raise exception 'place_is_dummy_locked'
        using hint = 'is_dummy is Creator/Developer-Authority only (Master Dummy Place v1.0 §4).';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Explicit backfill — NAMED IDS ONLY, never inferred from text.
-- ---------------------------------------------------------------------------
-- The ten ids are exactly the demo Places created by 0037. They are named here
-- because 0037 is the authoritative record of what they are, NOT because their
-- description happens to contain a word. Every other existing Place — all 54
-- non-demo rows in DEV — stays `false`, including any row that merely mentions
-- "demo" somewhere.
update public.places
   set is_dummy = true
 where id in (
   'sari-jagung-sejahtera',
   'sari-tempe-makmur',
   'sari-tahu-pakis',
   'sari-kerajinan-bambu',
   'sari-batik-pancarsari',
   'sari-tenun-klasik',
   'sari-anyaman-lentera',
   'sari-kebun-obat',
   'sari-taman-bibit',
   'sari-gula-aren'
 )
 and is_dummy is distinct from true;

create trigger places_is_dummy_update_guard
before update on public.places
for each row execute procedure public.block_place_is_dummy_update();

-- The guard is not an EXECUTE-grantable function: revoke keeps it out of reach
-- of any client that could otherwise call it directly (0031/0013 pattern).
revoke execute on function public.block_place_is_dummy_update()
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Audit vocabulary — additive only.
-- ---------------------------------------------------------------------------
-- Distinct keys (not the `admin_place_curated` ones) so the trail always
-- distinguishes a Developer-Authority decision from a Platform Admin one.
-- 0031's append-only trigger continues to guard the table.
alter table public.place_audit drop constraint if exists place_audit_action_check;
alter table public.place_audit
  add constraint place_audit_action_check check (action in (
    -- Platform Admin Place operations (workspace).
    'admin_place_created',
    'admin_place_updated',
    'admin_place_published',
    'admin_place_paused',
    'admin_place_archived',
    'admin_place_restored',
    -- Platform Admin Place claim decisions (the single ownership path).
    'place_claim_approved',
    'place_claim_rejected',
    -- Tempat Pilihan promotion decisions (Stage 4; flag-only).
    'admin_place_curated',
    'admin_place_uncurated',
    -- Developer Authority (Creator-controlled; Dummy Place only).
    'developer_place_dummy_marked',
    'developer_place_dummy_cleared',
    'developer_place_curated',
    'developer_place_uncurated'
  ));

-- ---------------------------------------------------------------------------
-- 5. Currency vocabulary — SAR admitted for honest test-data geography.
-- ---------------------------------------------------------------------------
alter table public.places drop constraint if exists places_currency_check;
alter table public.places
  add constraint places_currency_check
  check (currency in ('IDR', 'USD', 'SAR'));