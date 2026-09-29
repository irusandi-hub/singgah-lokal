-- 0036 — TEMPAT PILIHAN ADMIN CONTROL: audit actions + column lockdown.
--
-- STAGE 4 (PO): Admin dapat "Jadikan Tempat Pilihan" / "Cabut Promosi".
-- Discovery stays a computed layer — the Admin can never write a score, a
-- star, or eligibility; only the Tempat Pilihan FLAG moves, and every move
-- is attributable in the append-only place_audit trail (MASTER 09 §2/§13).
--
-- PART 1 — Audit vocabulary: the two locked action keys from the Stage 4
-- directive are appended to 0031's action CHECK. Additive-only: the check is
-- dropped and re-created with the two new values; no existing row, column,
-- policy, or trigger of place_audit is touched (the append-only trigger from
-- 0031 keeps guarding UPDATE/DELETE).
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
    -- Tempat Pilihan promotion decisions (Stage 4; flag-only, never
    -- publication, claim, ownership, or any Discovery value).
    'admin_place_curated',
    'admin_place_uncurated'
  ));

-- PART 2 — Write lockdown (SECURITY rule): `places.is_curated` must never be
-- writable through the generic Producer/Admin UPDATE path. The canonical
-- places UPDATE policies (0004: producers via membership; 0008-era: admin
-- operations) stay untouched — instead a row-level guard trigger refuses any
-- UPDATE that changes `is_curated`. Only the service role (the server code
-- behind requirePlatformModerator) bypasses the trigger, so the promotion is
-- reachable EXCLUSIVELY through the audited Admin action.
create or replace function public.block_place_is_curated_update()
returns trigger
language plpgsql
as $$
begin
  if new.is_curated is distinct from old.is_curated then
    -- The canonical Admin curation path writes through the SERVICE ROLE
    -- connection (current_user = service_role); every other writer — Producer
    -- forms, the Admin edit form, any generic API route — carries a session
    -- role and is refused here. The function stays SECURITY INVOKER on
    -- purpose: inside a definer function current_user would be the function
    -- owner, which would make the identity check meaningless.
    if current_user <> 'service_role' then
      raise exception 'place_is_curated_locked'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists places_is_curated_update_guard on public.places;
create trigger places_is_curated_update_guard
before update on public.places
for each row execute procedure public.block_place_is_curated_update();

-- The helper is never called directly by anyone; trigger execution runs as
-- the table owner and is unaffected by EXECUTE grants (0031/0013 pattern).
revoke execute on function public.block_place_is_curated_update()
from public, anon, authenticated;
