-- Voyza core schema — mirrors frontend/lib/types.ts
-- Run via: supabase db push or supabase migration up

-- ─── Trips ───────────────────────────────────────────────────
create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  title text not null,
  status text not null default 'active'
    check (status in ('active', 'completed', 'archived')),
  travelers integer not null default 1,
  total_cost numeric,
  savings_vs_alternative numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─── Cities ──────────────────────────────────────────────────
create table if not exists cities (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  name text not null,
  country text,
  arrival_date date,
  departure_date date,
  color_index integer default 0,
  position integer,
  hotel jsonb,
  activities jsonb default '[]'::jsonb,
  restaurants jsonb default '[]'::jsonb,
  schedule jsonb default '{}'::jsonb
);

-- ─── Transports ──────────────────────────────────────────────
create table if not exists transports (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  from_city_id uuid references cities(id),
  to_city_id uuid references cities(id),
  mode text check (mode in ('flight', 'train', 'mixed')),
  operator text,
  price numeric,
  journey_time_minutes integer,
  door_to_door_minutes integer,
  booking_url text
);

-- ─── Group Members ───────────────────────────────────────────
create table if not exists group_members (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  user_id uuid references auth.users,
  invited_email text,
  invite_token text unique default gen_random_uuid()::text,
  role text not null default 'viewer'
    check (role in ('owner', 'editor', 'suggester', 'viewer')),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

-- ─── Canvas Sessions ─────────────────────────────────────────
create table if not exists canvas_sessions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  state jsonb,
  last_saved_by uuid references auth.users,
  saved_at timestamptz not null default now()
);

-- ─── Canvas Suggestions ──────────────────────────────────────
create table if not exists canvas_suggestions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  suggested_by uuid references auth.users,
  type text check (type in ('add_city', 'comment', 'reaction')),
  payload jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

-- ─── Leg Price Cache ─────────────────────────────────────────
create table if not exists leg_price_cache (
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

-- ─── Airport Codes Cache ─────────────────────────────────────
create table if not exists airport_codes (
  city_name text primary key,
  iata_code text not null,
  country text
);

-- ─── DB Stops Cache (Deutsche Bahn) ──────────────────────────
create table if not exists db_stops (
  city_name text primary key,
  stop_id text not null,
  cached_at timestamptz not null default now()
);

-- ─── Booking Locations Cache ─────────────────────────────────
create table if not exists booking_locations (
  city_name text primary key,
  dest_id text not null,
  dest_type text
);

-- Indices for common lookups
create index if not exists idx_cities_trip on cities(trip_id);
create index if not exists idx_transports_trip on transports(trip_id);
create index if not exists idx_group_members_trip on group_members(trip_id);
create index if not exists idx_group_members_token on group_members(invite_token);
create index if not exists idx_canvas_sessions_trip on canvas_sessions(trip_id);
create index if not exists idx_canvas_suggestions_trip on canvas_suggestions(trip_id);
create index if not exists idx_leg_cache_lookup on leg_price_cache(origin, destination, travel_date, mode);
