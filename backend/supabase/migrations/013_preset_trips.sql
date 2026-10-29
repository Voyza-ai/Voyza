-- ============================================================================
-- 013: Browse preset trips catalog
-- ============================================================================
-- Run in the Supabase SQL editor (Dashboard → SQL Editor → paste → Run), in
-- three steps:
--   STEP A — rehearse: paste 013_preset_trips.dry-run.sql (begin … rollback)
--            and Run. All 7 Results rows must say PASS; nothing is kept.
--   STEP B — apply:    paste THIS whole file and Run.
--   STEP C — seed:     cd backend && npx tsx src/scripts/seedPresets.ts
--            (writes the 20 presets into preset_trips; safe to re-run).
--
-- What it adds: two NEW tables + one function. It does not touch any existing
-- table, row, or policy, so it cannot break the code currently on `dev`:
-- until this runs, the backend serves the same catalog from the bundled JSON
-- (backend/src/data/presets/*.json).
--
--   preset_trips  — one row per preset; `data` = full itinerary (frontend
--                   PresetItinerary shape), other columns = derived facts.
--   preset_events — append-only impression / view / use log; feeds the
--                   "Trending this week" row (last-7-day activity).
-- ============================================================================

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

-- ═══ VERIFY (after APPLY + seed) ═════════════════════════════════════════════
-- select count(*) from public.preset_trips;                      -- expect 20
-- select slug, staff_pick, categories from public.preset_trips order by slug;
-- select grantee from information_schema.routine_privileges
--  where routine_name = 'record_preset_event';                   -- postgres, service_role only

-- ═══ REVERSAL (undo everything above) ════════════════════════════════════════
-- drop function if exists public.record_preset_event(text, text);
-- drop table if exists public.preset_events;
-- drop table if exists public.preset_trips;
