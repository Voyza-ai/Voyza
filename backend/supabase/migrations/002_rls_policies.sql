-- Row Level Security policies for all Voyza tables

-- ─── Enable RLS ──────────────────────────────────────────────
alter table trips enable row level security;
alter table cities enable row level security;
alter table transports enable row level security;
alter table group_members enable row level security;
alter table canvas_sessions enable row level security;
alter table canvas_suggestions enable row level security;
alter table leg_price_cache enable row level security;
alter table airport_codes enable row level security;
alter table db_stops enable row level security;
alter table booking_locations enable row level security;

-- ─── Trips ───────────────────────────────────────────────────
-- Owner has full access
create policy "trips_owner_all" on trips
  for all using (auth.uid() = user_id);

-- Group members can SELECT
create policy "trips_group_select" on trips
  for select using (
    exists (
      select 1 from group_members gm
      where gm.trip_id = trips.id
        and gm.user_id = auth.uid()
    )
  );

-- Group editors can UPDATE
create policy "trips_group_edit" on trips
  for update using (
    exists (
      select 1 from group_members gm
      where gm.trip_id = trips.id
        and gm.user_id = auth.uid()
        and gm.role = 'editor'
    )
  );

-- ─── Cities ──────────────────────────────────────────────────
-- Inherit from parent trip — owner access
create policy "cities_owner_all" on cities
  for all using (
    exists (
      select 1 from trips t
      where t.id = cities.trip_id
        and t.user_id = auth.uid()
    )
  );

-- Group members can SELECT
create policy "cities_group_select" on cities
  for select using (
    exists (
      select 1 from group_members gm
      where gm.trip_id = cities.trip_id
        and gm.user_id = auth.uid()
    )
  );

-- Group editors can UPDATE/INSERT/DELETE
create policy "cities_group_edit" on cities
  for all using (
    exists (
      select 1 from group_members gm
      where gm.trip_id = cities.trip_id
        and gm.user_id = auth.uid()
        and gm.role in ('editor', 'owner')
    )
  );

-- ─── Transports ──────────────────────────────────────────────
create policy "transports_owner_all" on transports
  for all using (
    exists (
      select 1 from trips t
      where t.id = transports.trip_id
        and t.user_id = auth.uid()
    )
  );

create policy "transports_group_select" on transports
  for select using (
    exists (
      select 1 from group_members gm
      where gm.trip_id = transports.trip_id
        and gm.user_id = auth.uid()
    )
  );

create policy "transports_group_edit" on transports
  for all using (
    exists (
      select 1 from group_members gm
      where gm.trip_id = transports.trip_id
        and gm.user_id = auth.uid()
        and gm.role in ('editor', 'owner')
    )
  );

-- ─── Group Members ───────────────────────────────────────────
-- Owner manages all rows for their trips
create policy "group_members_owner_all" on group_members
  for all using (
    exists (
      select 1 from trips t
      where t.id = group_members.trip_id
        and t.user_id = auth.uid()
    )
  );

-- Members can read their own row
create policy "group_members_self_select" on group_members
  for select using (user_id = auth.uid());

-- ─── Canvas Sessions ─────────────────────────────────────────
-- Editors and owners can write
create policy "canvas_sessions_write" on canvas_sessions
  for all using (
    exists (
      select 1 from group_members gm
      where gm.trip_id = canvas_sessions.trip_id
        and gm.user_id = auth.uid()
        and gm.role in ('owner', 'editor')
    )
  );

-- Trip owner can write
create policy "canvas_sessions_owner" on canvas_sessions
  for all using (
    exists (
      select 1 from trips t
      where t.id = canvas_sessions.trip_id
        and t.user_id = auth.uid()
    )
  );

-- Viewers and suggesters can SELECT
create policy "canvas_sessions_select" on canvas_sessions
  for select using (
    exists (
      select 1 from group_members gm
      where gm.trip_id = canvas_sessions.trip_id
        and gm.user_id = auth.uid()
    )
  );

-- ─── Canvas Suggestions ─────────────────────────────────────
-- Suggesters, editors, owners can INSERT
create policy "canvas_suggestions_insert" on canvas_suggestions
  for insert with check (
    exists (
      select 1 from group_members gm
      where gm.trip_id = canvas_suggestions.trip_id
        and gm.user_id = auth.uid()
        and gm.role in ('owner', 'editor', 'suggester')
    )
  );

-- Trip owner can INSERT (if not a group_member row)
create policy "canvas_suggestions_owner_insert" on canvas_suggestions
  for insert with check (
    exists (
      select 1 from trips t
      where t.id = canvas_suggestions.trip_id
        and t.user_id = auth.uid()
    )
  );

-- Owner can UPDATE status (approve/reject)
create policy "canvas_suggestions_owner_update" on canvas_suggestions
  for update using (
    exists (
      select 1 from trips t
      where t.id = canvas_suggestions.trip_id
        and t.user_id = auth.uid()
    )
  );

-- All group members can SELECT
create policy "canvas_suggestions_select" on canvas_suggestions
  for select using (
    exists (
      select 1 from group_members gm
      where gm.trip_id = canvas_suggestions.trip_id
        and gm.user_id = auth.uid()
    )
    or exists (
      select 1 from trips t
      where t.id = canvas_suggestions.trip_id
        and t.user_id = auth.uid()
    )
  );

-- ─── Cache Tables — service role only ────────────────────────
-- No policies = only service role (backend) can access
-- RLS is enabled but no policies grant access to anon/authenticated
create policy "leg_cache_service_only" on leg_price_cache
  for all using (false);

create policy "airport_codes_service_only" on airport_codes
  for all using (false);

create policy "db_stops_service_only" on db_stops
  for all using (false);

create policy "booking_locations_service_only" on booking_locations
  for all using (false);
