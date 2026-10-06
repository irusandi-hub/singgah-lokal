-- AI Media quota release (companion to 0042 quota control).

-- Release previously-claimed tokens. Used by the generation-capability probe so
-- the readiness check does not permanently consume quota. This is also useful
-- for rollbacks and for the server path that wants to reserve capacity
-- temporarily before committing a real generation job.
create or replace function public.release_ai_media_quota(
  p_producer_id text,
  p_token_count integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  row public.ai_media_quota;
begin
  if p_token_count is null or p_token_count <= 0 then
    raise exception 'ai_media_quota_invalid';
  end if;

  select * into row from public.ai_media_quota where producer_id = p_producer_id for update;
  if not found then
    raise exception 'ai_media_quota_invalid';
  end if;

  if row.used_tokens < p_token_count then
    -- Underrun is treated as invalid state rather than silently corrupting the
    -- ledger: better to refuse than to let used_tokens drift negative.
    raise exception 'ai_media_quota_invalid';
  end if;

  update public.ai_media_quota
    set used_tokens = used_tokens - p_token_count,
        last_used_at = now(),
        updated_at = now()
    where producer_id = p_producer_id;

  return true;
end;
$$;

-- Service-role lockdown (matches 0042 revoke pattern).
revoke all on function public.release_ai_media_quota(text, integer) from public, anon, authenticated;
