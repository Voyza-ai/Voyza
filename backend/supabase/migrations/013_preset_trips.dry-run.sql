-- ============================================================================
-- 013 DRY RUN — rehearses 013_preset_trips.sql and changes NOTHING.
-- ============================================================================
-- Paste this whole file into the Supabase SQL editor and Run. It applies the
-- migration inside a transaction, probes every behaviour it adds (happy path,
-- the second write with the same slug, a bad value, an unknown preset, and the
-- cascade on delete), then ROLLS BACK. The Results tab shows a 7-row table:
-- every row's status column should say PASS.
-- Keep in sync with 013_preset_trips.sql (the APPLY section is copied below).
-- ============================================================================

begin;

-- ═══ APPLY ══════════════════════════════════════════════════════════════════

-- 1) Catalog table.
--    SAFE ON PRODUCTION: new table, `if not exists`; no existing data touched.
create table if not exists public.preset_trips (
  slug             text primary key,
  data             jsonb not null,
  -- Taxonomy (see backend/src/services/presetTaxonomy.ts)
  vibes            text[] not null default '{}',
  region           text not null,
  duration_bucket  text not null check (duration_bucket in ('weekend','one-week','two-weeks','month')),
  budget_tier      text not null check (budget_tier in ('$','$$','$$$','$$$$')),
  origin_region    text not null default 'us-east',
  nights           integer not null,
  est_cost         numeric not null,
  categories       text[] not null default '{}',
  hero_image_url   text,
  -- Editorial
  staff_pick       boolean not null default false,
  status           text not null default 'published' check (status in ('draft','published')),
  source           text not null default 'curated' check (source in ('curated','generated')),
  -- Weekly price refresh
  refresh_status   text not null default 'fresh' check (refresh_status in ('fresh','refreshing','failed')),
  refreshed_at     timestamptz,
  -- Engagement (all-time)
  clone_count      integer not null default 0,   -- uses: Save + "Plan a similar trip"
  impression_count integer not null default 0,
  view_count       integer not null default 0,
  created_at       timestamptz not null default now()
);

-- SAFE ON PRODUCTION: index on the new table only.
create index if not exists preset_trips_categories_idx
  on public.preset_trips using gin (categories);

-- 2) Engagement log.
--    SAFE ON PRODUCTION: new table; rows cascade-delete with their preset.
create table if not exists public.preset_events (
  id          bigint generated always as identity primary key,
  preset_slug text not null references public.preset_trips(slug) on delete cascade,
  kind        text not null check (kind in ('impression','view','use')),
  created_at  timestamptz not null default now()
);

-- SAFE ON PRODUCTION: index on the new table only.
create index if not exists preset_events_recent_idx
  on public.preset_events (created_at desc, preset_slug);

-- 3) RLS. The published catalog is public (anon + signed-in) because it backs
--    the SEO pages; all writes go through the service-role backend.
--    SAFE ON PRODUCTION: policies on the new tables only. preset_events gets
--    NO client policy at all (service role only).
alter table public.preset_trips  enable row level security;
alter table public.preset_events enable row level security;

drop policy if exists "preset_trips_public_read" on public.preset_trips;
create policy "preset_trips_public_read" on public.preset_trips
  for select using (status = 'published');

-- 4) Record one event + bump the matching all-time counter atomically.
--    SAFE ON PRODUCTION: new function; EXECUTE revoked from PUBLIC (which
--    anon/authenticated inherit — see security_fixes.sql), so only the
--    service-role backend can call it.
create or replace function public.record_preset_event(p_slug text, p_kind text)
returns void
language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.preset_events (preset_slug, kind) values (p_slug, p_kind);
  if p_kind = 'impression' then
    update public.preset_trips set impression_count = impression_count + 1 where slug = p_slug;
  elsif p_kind = 'view' then
    update public.preset_trips set view_count = view_count + 1 where slug = p_slug;
  elsif p_kind = 'use' then
    update public.preset_trips set clone_count = clone_count + 1 where slug = p_slug;
  end if;
end;
$$;

revoke execute on function public.record_preset_event(text, text) from public;
revoke execute on function public.record_preset_event(text, text) from anon, authenticated;

-- ═══ PROBES ═════════════════════════════════════════════════════════════════
-- Each check writes one row to a scratch table; the final SELECT shows them in
-- the Results tab (the Supabase editor does not display NOTICE messages).

create temp table _checks (n int, check_name text, result text, expected text);

insert into public.preset_trips (slug, data, region, duration_bucket, budget_tier, nights, est_cost)
values ('dry-run', '{}'::jsonb, 'europe', 'weekend', '$', 3, 500);

-- counters bump once per event, per kind
do $$ declare v int; c int; e int; begin
  perform public.record_preset_event('dry-run', 'view');
  perform public.record_preset_event('dry-run', 'view');
  perform public.record_preset_event('dry-run', 'use');
  select view_count, clone_count into v, c from public.preset_trips where slug = 'dry-run';
  select count(*) into e from public.preset_events where preset_slug = 'dry-run';
  insert into _checks values (1, 'view counter', v::text, '2'),
                             (2, 'use counter', c::text, '1'),
                             (3, 'events logged', e::text, '3');
end $$;

-- second write with the same slug must fail (primary key)
do $$ begin
  insert into public.preset_trips (slug, data, region, duration_bucket, budget_tier, nights, est_cost)
  values ('dry-run', '{}'::jsonb, 'europe', 'weekend', '$', 3, 500);
  insert into _checks values (4, 'duplicate slug', 'ACCEPTED', 'rejected');
exception when unique_violation then
  insert into _checks values (4, 'duplicate slug', 'rejected', 'rejected');
end $$;

-- bad bucket must fail (check constraint)
do $$ begin
  insert into public.preset_trips (slug, data, region, duration_bucket, budget_tier, nights, est_cost)
  values ('dry-run-2', '{}'::jsonb, 'europe', 'fortnight', '$', 3, 500);
  insert into _checks values (5, 'bad duration_bucket', 'ACCEPTED', 'rejected');
exception when check_violation then
  insert into _checks values (5, 'bad duration_bucket', 'rejected', 'rejected');
end $$;

-- events for an unknown preset must fail (foreign key)
do $$ begin
  perform public.record_preset_event('no-such-preset', 'view');
  insert into _checks values (6, 'unknown preset event', 'ACCEPTED', 'rejected');
exception when foreign_key_violation then
  insert into _checks values (6, 'unknown preset event', 'rejected', 'rejected');
end $$;

-- deleting a preset cascades its events
delete from public.preset_trips where slug = 'dry-run';
insert into _checks
  select 7, 'events left after delete', count(*)::text, '0'
  from public.preset_events where preset_slug = 'dry-run';

-- ═══ RESULT ═════════════════════════════════════════════════════════════════
-- Every row should say PASS.
select n, check_name, result, expected,
       case when result = expected then 'PASS' else 'FAIL' end as status
from _checks order by n;

rollback;
