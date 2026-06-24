-- ============================================================================
-- Voyza — LIVE SCHEMA SNAPSHOT (reference)
-- ============================================================================
-- Generated 2026-06-16 by reading the live production DB (project
-- vzptwvrgiaqveckrdmke) via read-only queries. This documents what is
-- ACTUALLY deployed, because the repo's migrations/ (001_create_tables.sql,
-- 002_rls_policies.sql) drifted far behind the live database.
--
-- The live DB has 7 applied migrations not represented in the repo:
--   extend_trip_schema_for_full_persistence, user_profiles_crud_support,
--   account_lifecycle_and_trip_permissions, index_cleanup_and_member_lookups,
--   add_trip_constraints, add_trip_origin_anchor, add_trip_home_leg_details
--
-- ⚠️  THIS FILE IS REFERENCE DOCUMENTATION — do NOT place it in migrations/
--     and do NOT `supabase db push` it (the tables already exist).
--     The AUTHORITATIVE reconciliation is `supabase db pull` (see notes at end),
--     which produces a tooling-recognized migration. Use this snapshot to
--     review/verify that output.
-- ============================================================================

-- ─── Tables ────────────────────────────────────────────────────────────────

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  title text not null,
  status text not null default 'active',
  travelers integer not null default 1,
  total_cost numeric,
  savings_vs_alternative numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  budget numeric,
  budget_per_person boolean,
  vibe text,
  start_date date,
  date_shift_suggestion jsonb,
  allow_clones boolean not null default true,
  allow_recommendations boolean not null default true,
  is_public boolean not null default false,
  cloned_from_trip_id uuid references public.trips(id) on delete set null,
  clone_count integer not null default 0,
  constraints jsonb not null default '{}'::jsonb,
  origin_city text,
  origin_airports jsonb default '[]'::jsonb,
  return_to_home boolean default true,
  outbound_leg jsonb,
  return_leg jsonb
);

create table public.cities (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  name text not null,
  country text,
  arrival_date date,
  departure_date date,
  color_index integer default 0,
  position integer,
  hotel jsonb,
  activities jsonb default '[]'::jsonb,
  restaurants jsonb default '[]'::jsonb,
  schedule jsonb default '{}'::jsonb,
  hotels jsonb not null default '[]'::jsonb,
  selected_hotel_index integer not null default 0,
  custom_hotel jsonb,
  vibes jsonb not null default '[]'::jsonb
);

create table public.transports (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  from_city_id uuid references public.cities(id),
  to_city_id uuid references public.cities(id),
  mode text,
  operator text,
  price numeric,
  journey_time_minutes integer,
  door_to_door_minutes integer,
  booking_url text,
  duration_minutes integer,
  depart_time text,
  arrive_time text,
  depart_date date,
  layovers integer,
  stops integer,
  currency text default 'USD',
  carrier_code text,
  flight_number text,
  alternatives jsonb
);

create table public.group_members (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid references auth.users(id),
  invited_email text,
  invite_token text default (gen_random_uuid())::text,
  role text not null default 'viewer',
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (invite_token)
);

create table public.canvas_sessions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  state jsonb,
  last_saved_by uuid references auth.users(id),
  saved_at timestamptz not null default now()
);

create table public.canvas_suggestions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  suggested_by uuid references auth.users(id),
  type text,
  payload jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  is_premium boolean default false,
  stripe_customer_id text,
  stripe_subscription_id text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  preferences jsonb not null default '{}'::jsonb,
  avatar_url text,
  deleted_at timestamptz,
  anonymized_at timestamptz,
  deletion_reason text
);

-- API cache tables (service-role only; RLS denies all to anon/authenticated)
create table public.airport_codes (
  city_name text primary key,
  iata_code text not null,
  country text
);

create table public.booking_locations (
  city_name text primary key,
  dest_id text not null,
  dest_type text
);

create table public.db_stops (
  city_name text primary key,
  stop_id text not null,
  cached_at timestamptz not null default now()
);

create table public.leg_price_cache (
  id uuid primary key default gen_random_uuid(),
  origin text not null,
  destination text not null,
  travel_date date not null,
  mode text not null,
  price numeric,
  duration_minutes integer,
  operator text,
  raw_response jsonb,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz
);

-- ─── Row Level Security ──────────────────────────────────────────────────────
alter table public.trips              enable row level security;
alter table public.cities             enable row level security;
alter table public.transports         enable row level security;
alter table public.group_members      enable row level security;
alter table public.canvas_sessions    enable row level security;
alter table public.canvas_suggestions enable row level security;
alter table public.user_profiles      enable row level security;
alter table public.airport_codes      enable row level security;
alter table public.booking_locations  enable row level security;
alter table public.db_stops           enable row level security;
alter table public.leg_price_cache    enable row level security;

-- trips
create policy trips_owner_all   on public.trips for all    using (auth.uid() = user_id);
create policy trips_group_select on public.trips for select using (exists (select 1 from public.group_members gm where gm.trip_id = trips.id and gm.user_id = auth.uid()));
create policy trips_group_edit  on public.trips for update using (exists (select 1 from public.group_members gm where gm.trip_id = trips.id and gm.user_id = auth.uid() and gm.role = 'editor'));
create policy trips_public_select on public.trips for select using (is_public = true and status = 'active');

-- cities
create policy cities_owner_all    on public.cities for all    using (exists (select 1 from public.trips t where t.id = cities.trip_id and t.user_id = auth.uid()));
create policy cities_group_select on public.cities for select using (exists (select 1 from public.group_members gm where gm.trip_id = cities.trip_id and gm.user_id = auth.uid()));
create policy cities_group_edit   on public.cities for all    using (exists (select 1 from public.group_members gm where gm.trip_id = cities.trip_id and gm.user_id = auth.uid() and gm.role = any (array['editor','owner'])));
create policy cities_public_select on public.cities for select using (exists (select 1 from public.trips t where t.id = cities.trip_id and t.is_public = true and t.status = 'active'));

-- transports
create policy transports_owner_all    on public.transports for all    using (exists (select 1 from public.trips t where t.id = transports.trip_id and t.user_id = auth.uid()));
create policy transports_group_select on public.transports for select using (exists (select 1 from public.group_members gm where gm.trip_id = transports.trip_id and gm.user_id = auth.uid()));
create policy transports_group_edit   on public.transports for all    using (exists (select 1 from public.group_members gm where gm.trip_id = transports.trip_id and gm.user_id = auth.uid() and gm.role = any (array['editor','owner'])));
create policy transports_public_select on public.transports for select using (exists (select 1 from public.trips t where t.id = transports.trip_id and t.is_public = true and t.status = 'active'));

-- group_members
create policy group_members_owner_all   on public.group_members for all    using (exists (select 1 from public.trips t where t.id = group_members.trip_id and t.user_id = auth.uid()));
create policy group_members_self_select on public.group_members for select using (user_id = auth.uid());

-- canvas_sessions
create policy canvas_sessions_owner  on public.canvas_sessions for all    using (exists (select 1 from public.trips t where t.id = canvas_sessions.trip_id and t.user_id = auth.uid()));
create policy canvas_sessions_select on public.canvas_sessions for select using (exists (select 1 from public.group_members gm where gm.trip_id = canvas_sessions.trip_id and gm.user_id = auth.uid()));
create policy canvas_sessions_write  on public.canvas_sessions for all    using (exists (select 1 from public.group_members gm where gm.trip_id = canvas_sessions.trip_id and gm.user_id = auth.uid() and gm.role = any (array['owner','editor'])));

-- canvas_suggestions
create policy canvas_suggestions_insert       on public.canvas_suggestions for insert with check (exists (select 1 from public.group_members gm where gm.trip_id = canvas_suggestions.trip_id and gm.user_id = auth.uid() and gm.role = any (array['owner','editor','suggester'])));
create policy canvas_suggestions_owner_insert on public.canvas_suggestions for insert with check (exists (select 1 from public.trips t where t.id = canvas_suggestions.trip_id and t.user_id = auth.uid()));
create policy canvas_suggestions_owner_update on public.canvas_suggestions for update using (exists (select 1 from public.trips t where t.id = canvas_suggestions.trip_id and t.user_id = auth.uid()));
create policy canvas_suggestions_select       on public.canvas_suggestions for select using ((exists (select 1 from public.group_members gm where gm.trip_id = canvas_suggestions.trip_id and gm.user_id = auth.uid())) or (exists (select 1 from public.trips t where t.id = canvas_suggestions.trip_id and t.user_id = auth.uid())));

-- user_profiles
create policy profiles_owner_all   on public.user_profiles for all    using (auth.uid() = id);
create policy profiles_self_select on public.user_profiles for select using (auth.uid() = id);
create policy profiles_self_update on public.user_profiles for update using (auth.uid() = id) with check (auth.uid() = id);

-- cache tables — deny all (only the service role, which bypasses RLS, may touch them)
create policy airport_codes_service_only     on public.airport_codes     for all using (false);
create policy booking_locations_service_only on public.booking_locations for all using (false);
create policy db_stops_service_only          on public.db_stops          for all using (false);
create policy leg_cache_service_only         on public.leg_price_cache   for all using (false);

-- ─── Functions (verbatim from live DB) ──────────────────────────────────────
-- handle_new_user: creates a user_profiles row on signup.
-- Wired as trigger:  on_auth_user_created AFTER INSERT ON auth.users.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.user_profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- anonymize_expired_deletions: pg_cron-driven PII wipe for accounts soft-deleted
-- > 30 days. KEEPS user_profiles row (trips FK to it) but clears PII.
create or replace function public.anonymize_expired_deletions()
returns table(anonymized_user_id uuid)
language plpgsql security definer set search_path to 'public','auth' as $$
declare target record;
begin
  for target in
    select id from public.user_profiles
    where deleted_at is not null and anonymized_at is null
      and deleted_at < now() - interval '30 days'
  loop
    update auth.users set
      email = 'deleted-' || target.id::text || '@voyza.deleted',
      encrypted_password = '',
      raw_user_meta_data = '{}'::jsonb,
      banned_until = 'infinity'::timestamptz
    where id = target.id;
    update public.user_profiles set
      full_name = null, avatar_url = null,
      stripe_customer_id = null, stripe_subscription_id = null,
      preferences = '{}'::jsonb, anonymized_at = now()
    where id = target.id;
    delete from auth.identities where user_id = target.id;
    anonymized_user_id := target.id;
    return next;
  end loop;
end;
$$;

-- rls_auto_enable: EVENT TRIGGER function — auto-enables RLS on any new public
-- table. (The event trigger object itself is not captured here; recreate via
-- `create event trigger ... on ddl_command_end execute function rls_auto_enable()`.)
create or replace function public.rls_auto_enable()
returns event_trigger language plpgsql security definer set search_path to 'pg_catalog' as $$
declare cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')
      and object_type in ('table','partitioned table')
  loop
    if cmd.schema_name = 'public' then
      begin execute format('alter table if exists %s enable row level security', cmd.object_identity);
      exception when others then raise log 'rls_auto_enable: failed on %', cmd.object_identity; end;
    end if;
  end loop;
end;
$$;

-- ============================================================================
-- ⚠️ SECURITY TODO (flagged by Supabase advisor 2026-06-16):
-- The three SECURITY DEFINER functions above are EXECUTE-able by anon /
-- authenticated via /rest/v1/rpc/<fn>. anonymize_expired_deletions wipes PII,
-- so it must NOT be publicly callable. Remediation migration:
--   revoke execute on function public.anonymize_expired_deletions() from anon, authenticated;
--   revoke execute on function public.handle_new_user()             from anon, authenticated;
--   revoke execute on function public.rls_auto_enable()             from anon, authenticated;
-- Also: enable Leaked Password Protection in Auth settings.
-- ============================================================================

-- ─── Authoritative reconciliation (run locally) ─────────────────────────────
-- This snapshot is for reference. To produce tooling-recognized migration files
-- that match the live DB exactly:
--   1. npm i -g supabase            (or: brew install supabase/tap/supabase)
--   2. cd backend && supabase login
--   3. supabase link --project-ref vzptwvrgiaqveckrdmke
--   4. supabase db pull             (writes a migration capturing live schema)
-- Then commit the generated file under backend/supabase/migrations/.
