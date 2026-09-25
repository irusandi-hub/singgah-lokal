-- 0018: Place cover image.
--
-- Adds an optional, public, URL-based cover image to `places` so Place detail
-- can render a hero image. The field is a plain URL (no storage bucket, no
-- auth-gated object), read by anyone who can read the Place row — the same
-- visibility rule as the other Place profile fields (public read of
-- published Places). Producers manage it through the existing Place form;
-- the editor-restricted-change trigger (0004) is intentionally NOT extended:
-- a cover image is presentation metadata, not an operations-restricted field.
alter table public.places
  add column if not exists cover_image_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'places_cover_image_url_https'
  ) then
    alter table public.places
      add constraint places_cover_image_url_https
      check (cover_image_url is null or cover_image_url ~* '^https://');
  end if;
end
$$;
