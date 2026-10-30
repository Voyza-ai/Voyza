-- ============================================================================
-- DRY RUN — 013_preset_marketplace.sql + 014_record_preset_event.sql
-- ============================================================================
-- Changes NOTHING. Paste this whole file into the Supabase SQL editor and
-- Run. It applies both migrations inside one transaction, probes every
-- behaviour they add — the happy path, the SECOND write, a bad value, an
-- unknown preset, the cascade, who may call the RPC, running 014 twice, and
-- a live function definition that differs from 014's — then ROLLS BACK.
-- The Results tab shows one table; every row's status column must say PASS.
--
-- Lives in dry-runs/, not migrations/: it is a rehearsal, and anything in
-- migrations/ is a candidate for `supabase db push`.
--
-- Keep the APPLY sections in sync with the two migration files (statements
-- copied verbatim; their comments are in the files). On production both
-- APPLY sections are expected to be no-ops: the tables, indexes and policy
-- exist (013 was written from the live DB) and the function most likely
-- does (see 014's header).
--
-- Probes run as the SQL editor's role. Privileges are checked with
-- has_function_privilege() rather than SET ROLE, so the file never needs to
-- assume membership in anon / service_role.
-- ============================================================================

begin;

-- ═══ APPLY 013_preset_marketplace.sql ═══════════════════════════════════════

create table if not exists public.preset_trips (
  slug             text        not null primary key,
  data             jsonb       not null,
  vibes            text[]      not null default '{}'::text[],
  region           text        not null,
  duration_bucket  text        not null check (duration_bucket in ('weekend', 'one-week', 'two-weeks', 'month')),
  budget_tier      text        not null check (budget_tier in ('$', '$$', '$$$', '$$$$')),
  origin_region    text        not null default 'us-east'::text,
  nights           integer     not null,
  est_cost         numeric     not null,
  categories       text[]      not null default '{}'::text[],
  hero_image_url   text,
  staff_pick       boolean     not null default false,
  status           text        not null default 'published'::text check (status in ('draft', 'published')),
  source           text        not null default 'curated'::text check (source in ('curated', 'generated')),
  refresh_status   text        not null default 'fresh'::text check (refresh_status in ('fresh', 'refreshing', 'failed')),
  refreshed_at     timestamptz,
  clone_count      integer     not null default 0,
  impression_count integer     not null default 0,
  view_count       integer     not null default 0,
  created_at       timestamptz not null default now()
);

create table if not exists public.preset_events (
  id          bigint      not null generated always as identity primary key,
  preset_slug text        not null references public.preset_trips (slug) on delete cascade,
  kind        text        not null check (kind in ('impression', 'view', 'use')),
  created_at  timestamptz not null default now()
);

create index if not exists preset_trips_categories_idx
  on public.preset_trips using gin (categories);

create index if not exists preset_events_recent_idx
  on public.preset_events using btree (created_at desc, preset_slug);

alter table public.preset_trips  enable row level security;
alter table public.preset_events enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policy
     where polrelid = 'public.preset_trips'::regclass
       and polname  = 'preset_trips_public_read'
  ) then
    create policy preset_trips_public_read on public.preset_trips
      for select using (status = 'published'::text);
  end if;
end $$;

-- ═══ APPLY 014_record_preset_event.sql ══════════════════════════════════════

do $do$
begin
  if to_regprocedure('public.record_preset_event(text, text)') is null then
    execute $create$
      create function public.record_preset_event(p_slug text, p_kind text)
      returns void
      language plpgsql security definer set search_path to 'public' as $fn$
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
      $fn$
    $create$;
  end if;
end
$do$;

revoke execute on function public.record_preset_event(text, text) from public;
revoke execute on function public.record_preset_event(text, text) from anon, authenticated;

-- ═══ PROBES ═════════════════════════════════════════════════════════════════
-- Each check writes one row to a scratch table; the final SELECT shows them
-- (the Supabase editor does not display NOTICE messages).

create temp table _checks (n int, check_name text, result text, expected text);

insert into _checks
  select 1, 'record_preset_event exists',
         (to_regprocedure('public.record_preset_event(text, text)') is not null)::text, 'true';

-- Who may call it: the backend (service_role) yes; the public API no.
insert into _checks values
  (2, 'service_role may execute (the backend)',
      has_function_privilege('service_role', 'public.record_preset_event(text, text)', 'execute')::text, 'true'),
  (3, 'anon may NOT execute',
      has_function_privilege('anon', 'public.record_preset_event(text, text)', 'execute')::text, 'false'),
  (4, 'authenticated may NOT execute',
      has_function_privilege('authenticated', 'public.record_preset_event(text, text)', 'execute')::text, 'false');

insert into public.preset_trips (slug, data, region, duration_bucket, budget_tier, nights, est_cost)
values ('dry-run', '{}'::jsonb, 'europe', 'weekend', '$', 3, 500);

-- counters bump once per event, per kind
do $$ declare v int; c int; e int; begin
  perform public.record_preset_event('dry-run', 'view');
  perform public.record_preset_event('dry-run', 'view');
  perform public.record_preset_event('dry-run', 'use');
  select view_count, clone_count into v, c from public.preset_trips where slug = 'dry-run';
  select count(*) into e from public.preset_events where preset_slug = 'dry-run';
  insert into _checks values (5, 'view counter', v::text, '2'),
                             (6, 'use counter', c::text, '1'),
                             (7, 'events logged', e::text, '3');
end $$;

-- the SECOND write with the same slug must fail (primary key)
do $$ begin
  insert into public.preset_trips (slug, data, region, duration_bucket, budget_tier, nights, est_cost)
  values ('dry-run', '{}'::jsonb, 'europe', 'weekend', '$', 3, 500);
  insert into _checks values (8, 'duplicate slug', 'ACCEPTED', 'rejected');
exception when unique_violation then
  insert into _checks values (8, 'duplicate slug', 'rejected', 'rejected');
end $$;

-- a bad bucket must fail (check constraint)
do $$ begin
  insert into public.preset_trips (slug, data, region, duration_bucket, budget_tier, nights, est_cost)
  values ('dry-run-2', '{}'::jsonb, 'europe', 'fortnight', '$', 3, 500);
  insert into _checks values (9, 'bad duration_bucket', 'ACCEPTED', 'rejected');
exception when check_violation then
  insert into _checks values (9, 'bad duration_bucket', 'rejected', 'rejected');
end $$;

-- an event for an unknown preset must fail (foreign key)
do $$ begin
  perform public.record_preset_event('no-such-preset', 'view');
  insert into _checks values (10, 'unknown preset event', 'ACCEPTED', 'rejected');
exception when foreign_key_violation then
  insert into _checks values (10, 'unknown preset event', 'rejected', 'rejected');
end $$;

-- deleting a preset cascades its events
delete from public.preset_trips where slug = 'dry-run';
insert into _checks
  select 11, 'events left after delete', count(*)::text, '0'
  from public.preset_events where preset_slug = 'dry-run';

-- running 014 a SECOND time (verbatim) changes nothing and does not error
create temp table _def as
  select md5(pg_get_functiondef('public.record_preset_event(text, text)'::regprocedure)) as h;
do $do$
begin
  if to_regprocedure('public.record_preset_event(text, text)') is null then
    execute $create$
      create function public.record_preset_event(p_slug text, p_kind text)
      returns void
      language plpgsql security definer set search_path to 'public' as $fn$
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
      $fn$
    $create$;
  end if;
end
$do$;
revoke execute on function public.record_preset_event(text, text) from public;
revoke execute on function public.record_preset_event(text, text) from anon, authenticated;
insert into _checks
  select 12, '014 re-run leaves the definition alone',
         (md5(pg_get_functiondef('public.record_preset_event(text, text)'::regprocedure)) = (select h from _def))::text,
         'true';

-- the stale case: a live definition that DIFFERS from 014's is kept, not
-- overwritten (simulated by swapping in a marked body, then re-running
-- 014's function block verbatim)
create or replace function public.record_preset_event(p_slug text, p_kind text)
returns void language plpgsql security definer set search_path to 'public' as $fn$
begin
  -- live-definition-marker
  insert into public.preset_events (preset_slug, kind) values (p_slug, p_kind);
end;
$fn$;
do $do$
begin
  if to_regprocedure('public.record_preset_event(text, text)') is null then
    execute $create$
      create function public.record_preset_event(p_slug text, p_kind text)
      returns void
      language plpgsql security definer set search_path to 'public' as $fn$
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
      $fn$
    $create$;
  end if;
end
$do$;
insert into _checks
  select 13, 'a differing live definition is kept',
         (pg_get_functiondef('public.record_preset_event(text, text)'::regprocedure) like '%live-definition-marker%')::text,
         'true';

-- ═══ RESULT ═════════════════════════════════════════════════════════════════
-- Every row should say PASS.
select n, check_name, result, expected,
       case when result = expected then 'PASS' else 'FAIL' end as status
from _checks order by n;

rollback;
