-- 0029 — NOTIFICATION FAN-OUT: every Master 10 event reaches its recipient.
--
-- ROOT CAUSE this migration fixes: only ONE domain event produced a
-- notification (0026, Live started → followers). Producer application,
-- Place claim, and Visit Intent state changes wrote no notification row at
-- all, so neither the Admin review queue nor the Producer inbox could show
-- that work was waiting for a decision, and the header badge never moved
-- until a manual refresh.
--
-- MASTER 10 §6 event → recipient map implemented HERE (no event, category, or
-- wording outside the Master; the six categories of 0024/0025 are the only
-- ones used):
--
--   | Master 10 §6 event                | recipient                | category        |
--   | Producer application submitted    | Platform Admin           | system          |
--   | Verification decision (approved)  | the applicant (Producer) | system          |
--   | Verification decision (rejected)  | the applicant (Producer) | system          |
--   | Place claim submitted             | Platform Admin           | system          |
--   | Place claim approved              | the claimant (Producer)  | system          |
--   | Place claim rejected              | the claimant (Producer)  | system          |
--   | Visit Intent created              | Producer of that Place   | visit_experience|
--   | Visit Intent accepted             | the User                 | visit_experience|
--   | Visit Intent declined             | the User                 | visit_experience|
--   | Visit Intent requires confirmation| the User                 | visit_experience|
--   | Visit Intent cancelled            | the OTHER party          | visit_experience|
--   | Visit Intent expired              | Producer of that Place   | visit_experience|
--   | Live started (0026, unchanged)    | Place followers          | live_place      |
--
-- NOT implemented on purpose (no Master event is invented and no existing
-- write path exists for them yet): content published/blocked, moderation
-- action, AI quota, and security/account alerts have no trigger point in the
-- current code base, so adding them here would be inventing both an event and
-- its trigger.
--
-- KNOWN GAP, deliberately not changed here: migration 0002 only allows
-- pending -> accepted | declined | requires_confirmation (and the same from
-- requires_confirmation), so no current write path can set 'cancelled' or
-- 'expired'. The routing for those two Master events is implemented and unit
-- tested (the test lifts the 0002 guard), but they stay unreachable until a
-- product decision enables those transitions. Relaxing 0002 would be a business
-- rule change, not a notification fix.
--
-- Rules honoured (MASTER 10):
-- - §5/§21 the payload references the entity (place_id, source_type,
--   source_id) instead of duplicating mutable business state;
-- - §7  Visit Intent date/time is rendered from the stored Place-timezone
--   values, and no wording implies payment, order completion, or a guaranteed
--   reservation;
-- - §12/§17 duplicate domain events are absorbed by the dedup key from 0026
--   (user_id, source_type, source_id, event_type) — this migration is a
--   prerequisite-ordered companion of 0026, not a replacement;
-- - §14  only a recipient authorized for the underlying resource is notified:
--   Admins are `public.users.platform_role = 'platform_moderator'` (B2), and a
--   Producer recipient is an existing `producer_memberships` row — the same
--   predicates the review queues and the visit_intents RLS already use;
-- - §17  a notification failure never rolls back the valid business change:
--   every fan-out runs inside an exception block that warns and continues;
-- - §10  an optional category the recipient switched off is not written; a
--   missing preference row keeps the 0024 default (ON) — identical to the
--   rule 0026 already uses for live_place, so the existing Notification
--   Settings keep meaning exactly what they mean today. `safety_account` is
--   mandatory and is never filtered.
--
-- Realtime unread (§9, and the 0010/0009 pattern): after a notification is
-- inserted, and after a recipient marks one read, the database broadcasts a
-- display-only 'unread' signal on the recipient's OWN private topic
-- `notifications:{user_id}`. The RLS policy below is the gate: a session can
-- only receive on the topic built from its own auth.uid(), so no user can
-- subscribe to anybody else's notifications. The badge still reads its count
-- from /api/notifications (canonical, RLS-scoped); the signal only tells the
-- header to update without a refresh.
--
-- Non-destructive: one new column (default 1 for existing rows), one replaced
-- submit RPC body, new helper/trigger functions, and one new Realtime SELECT
-- policy. No existing table, RLS policy, grant, or notification row is
-- altered. Idempotent (safe re-apply).

-- ---------------------------------------------------------------------------
-- 1. Submission counter for Producer applications
-- ---------------------------------------------------------------------------
-- 0016/0017 store ONE application row per account: a refile after a rejection
-- resets that same row to 'pending'. Without a per-submission marker the dedup
-- key (which is keyed on the application id) would swallow the refile — the
-- Admin would never learn a new submission is waiting. The counter is the
-- occurrence id of that one row, so every submission and every decision on it
-- is a distinct, deduplicated domain event.
alter table public.producer_applications
  add column if not exists submission_seq integer not null default 1;

create or replace function public.submit_producer_application(
  p_user_id uuid,
  p_contact_email text,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then
    raise exception 'user_required';
  end if;
  -- Refuse to duplicate an active application (0016/0017 contract, unchanged).
  if exists (
    select 1 from public.producer_applications
    where user_id = p_user_id and status in ('pending', 'approved')
  ) then
    raise exception 'application_already_active';
  end if;
  -- One row per account, ever (user_id UNIQUE, 0016): a refile resets that row
  -- and advances the submission counter so the new submission is its own
  -- notification event.
  insert into public.producer_applications (user_id, status, contact_email, note)
  values (p_user_id, 'pending', p_contact_email, p_note)
  on conflict (user_id) do update
    set status = 'pending',
        contact_email = excluded.contact_email,
        note = excluded.note,
        reviewed_at = null,
        submission_seq = public.producer_applications.submission_seq + 1,
        updated_at = now();
end;
$$;

revoke all on function public.submit_producer_application(uuid, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Single server-side writer (recipient resolution, preference gate, dedup)
-- ---------------------------------------------------------------------------
create or replace function public.notify_recipient(
  p_user_id uuid,
  p_category text,
  p_event_type text,
  p_title text,
  p_body text,
  p_place_id text default null,
  p_source_type text default null,
  p_source_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user_id is null then
    return;
  end if;

  -- Preference gate (MASTER 10 §10, same rule as 0026): a stored OFF flag on
  -- this exact category suppresses the row; no row at all means the 0024
  -- default (ON) applies. The mandatory safety/account category is never
  -- filtered, so preferences can never suppress a security-critical event.
  if p_category in ('live_place', 'visit_experience', 'help_support', 'system', 'promotional')
    and exists (
      select 1
      from public.notification_preferences np
      where np.user_id = p_user_id
        and (
          case p_category
            when 'live_place' then np.live_place
            when 'visit_experience' then np.visit_experience
            when 'help_support' then np.help_support
            when 'system' then np.system
            when 'promotional' then np.promotional
          end
        ) = false
    )
  then
    return;
  end if;

  -- Idempotency (MASTER 10 §12): a duplicate domain event is absorbed here.
  -- A suppressed duplicate does not raise an AFTER INSERT trigger, so it also
  -- never produces a second realtime unread signal.
  insert into public.notifications (
    user_id, category, event_type, title, body,
    place_id, source_type, source_id, metadata
  )
  values (
    p_user_id, p_category, p_event_type, p_title, p_body,
    p_place_id, p_source_type, p_source_id, coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (user_id, source_type, source_id, event_type) do nothing;
end;
$$;

-- Server-side only: the function is reached exclusively from the trigger
-- functions below, which are themselves the only writers of these rows.
revoke all on function public.notify_recipient(uuid, text, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Realtime unread signal (display transport only; the row stays canonical)
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the broadcast is not blocked by the realtime.messages
-- RLS of a client-initiated read_at update: the table owner bypasses RLS, and
-- the recipient topic is derived from the row, never from client input.
create or replace function public.broadcast_notification_unread()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_unread integer;
begin
  begin
    select count(*)::integer into v_unread
    from public.notifications n
    where n.user_id = new.user_id and n.read_at is null;

    perform realtime.send(
      jsonb_build_object('event', 'unread', 'unreadCount', v_unread),
      'unread',
      'notifications:' || new.user_id::text,
      true
    );
  exception when others then
    -- A missing realtime signal must never break the notification write or the
    -- recipient's own mark-as-read (MASTER 10 §17).
    raise warning 'notification_unread_signal_failed: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists notifications_broadcast_unread on public.notifications;
create trigger notifications_broadcast_unread
after insert or update of read_at on public.notifications
for each row
execute procedure public.broadcast_notification_unread();

-- Recipient-scoped Realtime gate (MASTER 10 §14): a session may only receive
-- on the topic built from its own auth.uid(). Private channels only; the
-- platform keeps "Allow public access" OFF.
drop policy if exists notifications_realtime_receive on realtime.messages;
create policy notifications_realtime_receive
on realtime.messages
for select
to authenticated
using (
  realtime.topic() = 'notifications:' || auth.uid()::text
  and realtime.messages.extension = 'broadcast'
);

-- ---------------------------------------------------------------------------
-- 4. Producer application → Admin, and the decision → the applicant
-- ---------------------------------------------------------------------------
create or replace function public.notify_producer_application_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin record;
  v_event text;
  v_title text;
  v_body text;
  v_source_id text;
begin
  -- One submission occurrence = one domain event id, so a refile after a
  -- rejection is a new event and a repeated fire of the same submission is not.
  v_source_id := new.id::text || ':' || new.submission_seq::text;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending' then
      return null;
    end if;
    v_event := 'producer_application_submitted';
    v_title := 'Pengajuan Producer baru';
    v_body := 'Pengajuan menunggu verifikasi admin.';
  elsif new.status is not distinct from 'pending' then
    -- A refile after a rejection resets the SAME row to 'pending' (0017), so
    -- the new submission arrives as an UPDATE: it is a new event because
    -- submission_seq advanced. An UPDATE that leaves the row pending (a note
    -- edit, a re-save) is not a submission and stays silent.
    if old.status is not distinct from 'pending' then
      return null;
    end if;
    v_event := 'producer_application_submitted';
    v_title := 'Pengajuan Producer baru';
    v_body := 'Pengajuan menunggu verifikasi admin.';
  elsif old.status = 'pending'
    and new.status in ('approved', 'rejected')
  then
    v_event := case new.status
      when 'approved' then 'producer_application_approved'
      else 'producer_application_rejected'
    end;
    -- Copy reused verbatim from the existing Producer onboarding surface
    -- (web/app/producer/onboarding/producer-application-client.tsx).
    v_title := case new.status when 'approved' then 'Pengajuan disetujui' else 'Pengajuan ditolak' end;
    v_body := case new.status
      when 'approved' then 'Pengajuan disetujui — membership Producer aktif untuk akun ini.'
      else 'Pengajuan sebelumnya ditolak. Kamu bisa mengajukan kembali.'
    end;
  else
    return null;
  end if;

  begin
    if v_event = 'producer_application_submitted' then
      -- MASTER 10 §3: Admin receives moderation/verification alerts. The
      -- recipient set is the platform moderators themselves (B2) — the same
      -- identity requirePlatformModerator() authorizes on the review route.
      for v_admin in
        select u.id from public.users u where u.platform_role = 'platform_moderator'
      loop
        perform public.notify_recipient(
          v_admin.id,
          'system',
          v_event,
          v_title,
          v_body,
          null,
          'producer_application',
          v_source_id,
          jsonb_build_object(
            'application_id', new.id,
            'applicant_user_id', new.user_id,
            'contact_email', new.contact_email,
            'submission_seq', new.submission_seq
          )
        );
      end loop;
    else
      -- The decision goes to the applicant only. The application row holds no
      -- Place (ownership is chosen at approval time), so no Place is referenced
      -- and the inbox renders it as plain text (MASTER 10 §9 graceful target).
      perform public.notify_recipient(
        new.user_id,
        'system',
        v_event,
        v_title,
        v_body,
        null,
        'producer_application',
        v_source_id,
        jsonb_build_object(
          'application_id', new.id,
          'status', new.status,
          'reviewed_at', new.reviewed_at,
          'submission_seq', new.submission_seq
        )
      );
    end if;
  exception when others then
    raise warning 'producer_application_notification_failed: %', sqlerrm;
  end;

  return null;
end;
$$;

drop trigger if exists producer_applications_notify on public.producer_applications;
create trigger producer_applications_notify
after insert or update on public.producer_applications
for each row
execute procedure public.notify_producer_application_event();

-- ---------------------------------------------------------------------------
-- 5. Place claim → Admin, and the decision → the claimant
-- ---------------------------------------------------------------------------
create or replace function public.notify_place_claim_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin record;
  v_event text;
  v_title text;
  v_body text;
  v_place_name text;
begin
  select p.name into v_place_name from public.places p where p.id = new.place_id;

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending' then
      return null;
    end if;
    v_event := 'place_claim_submitted';
    v_title := 'Klaim Place baru';
    v_body := 'Klaim Place ' || coalesce(v_place_name, new.place_id) || ' menunggu penilaian Admin.';
  elsif old.status = 'pending'
    and new.status in ('approved', 'rejected')
  then
    v_event := case new.status
      when 'approved' then 'place_claim_approved'
      else 'place_claim_rejected'
    end;
    -- Copy reused from the existing claim panel status labels
    -- (web/app/producer/places/PlaceClaimPanel.tsx). The Admin review note is
    -- shown to the claimant, the party it was written for.
    v_title := case new.status
      when 'approved' then 'Klaim Place disetujui'
      else 'Klaim Place ditolak'
    end;
    v_body := case new.status
      when 'approved' then 'Disetujui — ownership diberikan untuk ' || coalesce(v_place_name, new.place_id) || '.'
      else 'Ditolak' || case
        when new.review_note is null or btrim(new.review_note) = '' then '.'
        else ': ' || btrim(new.review_note)
      end
    end;
  else
    return null;
  end if;

  begin
    if v_event = 'place_claim_submitted' then
      for v_admin in
        select u.id from public.users u where u.platform_role = 'platform_moderator'
      loop
        perform public.notify_recipient(
          v_admin.id,
          'system',
          v_event,
          v_title,
          v_body,
          new.place_id,
          'place_claim',
          new.id::text,
          jsonb_build_object(
            'claim_id', new.id,
            'place_id', new.place_id,
            'claimant_user_id', new.user_id,
            'note', new.note
          )
        );
      end loop;
    else
      perform public.notify_recipient(
        new.user_id,
        'system',
        v_event,
        v_title,
        v_body,
        new.place_id,
        'place_claim',
        new.id::text,
        jsonb_build_object(
          'claim_id', new.id,
          'place_id', new.place_id,
          'status', new.status,
          'reviewed_at', new.reviewed_at
        )
      );
    end if;
  exception when others then
    raise warning 'place_claim_notification_failed: %', sqlerrm;
  end;

  return null;
end;
$$;

drop trigger if exists place_claims_notify on public.place_claims;
create trigger place_claims_notify
after insert or update on public.place_claims
for each row
execute procedure public.notify_place_claim_event();

-- ---------------------------------------------------------------------------
-- 6. Visit Intent: created → Producer, status → User (or the other party)
-- ---------------------------------------------------------------------------
create or replace function public.notify_visit_intent_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_place_name text;
  v_when text;
  v_event text;
  v_title text;
  v_body text;
  v_producer record;
  v_actor uuid;
  v_status text;
begin
  select p.name into v_place_name from public.places p where p.id = new.place_id;

  -- MASTER 10 §7/§21: the requested date/time is rendered from the values the
  -- Place timezone already governs (validated on write by 0003), and the zone
  -- is named explicitly so the recipient reads it in the Place's context.
  v_when := to_char(new.requested_date, 'DD/MM/YYYY')
    || ' ' || to_char(new.requested_start_time, 'HH24:MI')
    || '-' || to_char(new.requested_end_time, 'HH24:MI')
    || ' (' || new.timezone || ')';

  if tg_op = 'INSERT' then
    if new.status is distinct from 'pending' then
      return null;
    end if;
    v_event := 'visit_intent_created';
    v_title := 'Visit Intent baru';
    v_body := 'Visit Intent baru di ' || coalesce(v_place_name, new.place_id) || ' · ' || v_when;
  elsif old.status is distinct from new.status then
    v_status := new.status;
    v_event := case v_status
      when 'accepted' then 'visit_intent_accepted'
      when 'declined' then 'visit_intent_declined'
      when 'requires_confirmation' then 'visit_intent_requires_confirmation'
      when 'cancelled' then 'visit_intent_cancelled'
      when 'expired' then 'visit_intent_expired'
      else null
    end;
    if v_event is null then
      return null;
    end if;
    -- No wording below implies payment, an order, or a guaranteed reservation
    -- (MASTER 10 §2, §7): the notification only restates the status.
    v_title := case v_status
      when 'accepted' then 'Visit Intent diterima'
      when 'declined' then 'Visit Intent ditolak'
      when 'requires_confirmation' then 'Visit Intent perlu konfirmasi'
      when 'cancelled' then 'Visit Intent dibatalkan'
      else 'Visit Intent kedaluwarsa'
    end;
    v_body := case v_status
      when 'accepted' then 'Visit Intent kamu di ' || coalesce(v_place_name, new.place_id) || ' diterima.'
      when 'declined' then 'Visit Intent kamu di ' || coalesce(v_place_name, new.place_id) || ' ditolak.'
      when 'requires_confirmation' then 'Producer membutuhkan konfirmasi tambahan untuk Visit Intent di ' || coalesce(v_place_name, new.place_id) || '.'
      else 'Visit Intent di ' || coalesce(v_place_name, new.place_id) || ' ' || case v_status
        when 'cancelled' then 'dibatalkan.'
        else 'kedaluwarsa.'
      end
    end;
    -- The Producer response note is the note written for the User
    -- (MASTER 10 §7 "Producer response note when allowed").
    if new.producer_response_note is not null and btrim(new.producer_response_note) <> ''
      and v_status in ('accepted', 'declined', 'requires_confirmation')
    then
      v_body := v_body || ' Respons Producer: ' || btrim(new.producer_response_note);
    end if;
  else
    return null;
  end if;

  begin
    if v_event = 'visit_intent_created' or v_status = 'expired' then
      -- Producer recipient: the Place's owner/manager memberships, exactly the
      -- set the visit_intents RLS and the Producer inbox already authorize.
      for v_producer in
        select distinct m.user_id
        from public.producer_memberships m
        where m.place_id = new.place_id
          and m.role in ('owner', 'manager')
      loop
        perform public.notify_recipient(
          v_producer.user_id,
          'visit_experience',
          v_event,
          v_title,
          v_body,
          new.place_id,
          'visit_intent',
          new.id,
          jsonb_build_object(
            'visit_intent_id', new.id,
            'place_id', new.place_id,
            'experience_id', new.experience_id,
            'requested_date', new.requested_date,
            'requested_start_time', new.requested_start_time,
            'requested_end_time', new.requested_end_time,
            'timezone', new.timezone,
            'party_size', new.party_size,
            'status', new.status
          )
        );
      end loop;
    elsif v_event = 'visit_intent_cancelled' then
      -- Cancellation is communicated to the party who did not cancel it
      -- (MASTER 10 §7). auth.uid() is the acting session: the User's own
      -- cancel reaches the Producer, a Producer/Admin cancel reaches the User.
      v_actor := auth.uid();
      if v_actor is not null and v_actor = new.user_id then
        for v_producer in
          select distinct m.user_id
          from public.producer_memberships m
          where m.place_id = new.place_id
            and m.role in ('owner', 'manager')
        loop
          perform public.notify_recipient(
            v_producer.user_id,
            'visit_experience',
            v_event,
            v_title,
            v_body,
            new.place_id,
            'visit_intent',
            new.id,
            jsonb_build_object(
              'visit_intent_id', new.id,
              'place_id', new.place_id,
              'status', new.status,
              'cancelled_by', 'user'
            )
          );
        end loop;
      else
        perform public.notify_recipient(
          new.user_id,
          'visit_experience',
          v_event,
          v_title,
          v_body,
          new.place_id,
          'visit_intent',
          new.id,
          jsonb_build_object(
            'visit_intent_id', new.id,
            'place_id', new.place_id,
            'status', new.status,
            'cancelled_by', 'producer'
          )
        );
      end if;
    else
      -- accepted / declined / requires_confirmation → the User who filed it.
      perform public.notify_recipient(
        new.user_id,
        'visit_experience',
        v_event,
        v_title,
        v_body,
        new.place_id,
        'visit_intent',
        new.id,
        jsonb_build_object(
          'visit_intent_id', new.id,
          'place_id', new.place_id,
          'status', new.status,
          'requested_date', new.requested_date,
          'requested_start_time', new.requested_start_time,
          'requested_end_time', new.requested_end_time,
          'timezone', new.timezone,
          'experience_id', new.experience_id
        )
      );
    end if;
  exception when others then
    raise warning 'visit_intent_notification_failed: %', sqlerrm;
  end;

  return null;
end;
$$;

drop trigger if exists visit_intents_notify on public.visit_intents;
create trigger visit_intents_notify
after insert or update on public.visit_intents
for each row
execute procedure public.notify_visit_intent_event();
