-- 006: close the ownership-escalation hole on trips
--
-- `trips_group_edit` (002_rls_policies.sql, and the live definition in
-- ../SCHEMA_SNAPSHOT.sql) is an UPDATE policy with a USING clause and NO
-- WITH CHECK. Postgres reuses USING as the new-row check in that case, so a
-- group EDITOR can go straight at the REST API with their own browser JWT:
--
--   PATCH /rest/v1/trips?id=eq.<trip>   {"user_id": "<their own uid>"}
--
-- and seize the trip — the rewritten row still satisfies USING, so the
-- write is accepted. Nothing in the app does this; it does not have to.
-- The anon key and the user's JWT both live in the browser
-- (frontend/lib/supabase.ts), and every server-side write goes through the
-- service-role client, so RLS is the *only* thing standing in front of
-- trips.user_id for a logged-in collaborator.
--
-- A WITH CHECK on this one policy does NOT close it, for two reasons:
--
--   (a) Permissive policies are OR-ed. `trips_owner_all` is
--       `for all using (auth.uid() = user_id)` with no WITH CHECK either,
--       so its implied new-row check is `auth.uid() = user_id` — exactly
--       true for the seized row. Tightening only trips_group_edit leaves
--       trips_owner_all waving the same row through.
--   (b) An RLS WITH CHECK can only see the NEW row. There is no OLD inside
--       a policy, so "user_id must keep the value it already had" is not
--       expressible as a policy at all.
--
-- So this migration does both halves: the policy gets the strongest WITH
-- CHECK it can carry (an editor's write may never leave the row owned by
-- that editor), and a BEFORE UPDATE trigger — which does see OLD and NEW —
-- pins the owner-only columns for any caller that is not the row's current
-- owner.
--
-- Owner-only, pinned by the trigger:
--   user_id, id, created_at, status, is_public, allow_clones,
--   allow_recommendations, cloned_from_trip_id, clone_count
-- Editor-writable, untouched:
--   title, travelers, total_cost, savings_vs_alternative, updated_at,
--   budget, budget_per_person, vibe, start_date, date_shift_suggestion,
--   constraints, origin_city, origin_airports, return_to_home,
--   outbound_leg, return_leg, return_city, return_airports
-- That editor-writable set is exactly the union of what the two trip-level
-- writers in the app actually set: `tripUpdate` in the canvas save path
-- (backend/src/routes/canvas.ts) and the sparse update in
-- PATCH /api/trips/:id (backend/src/routes/trips.ts). Neither ever writes
-- an owner-only column, so neither can trip the guard.
--
-- Ownership transfer keeps working. Both transfer endpoints —
-- POST /api/canvas/:tripId/transfer-ownership (the one the UI calls, via
-- frontend/lib/api.ts transferOwnership) and
-- POST /api/trips/:id/transfer-ownership — write through the service-role
-- client (backend/src/services/supabase.ts), which bypasses RLS entirely
-- and is skipped by the trigger's role guard below.
--
-- BEFORE RUNNING: this drops and recreates trips_group_edit by name. The
-- text below is the live definition as of ../SCHEMA_SNAPSHOT.sql
-- (generated 2026-06-16 from prod). Confirm prod still matches, and that no
-- extra UPDATE policy on trips has appeared since, with verification query
-- (1) at the bottom of this file. If it has drifted, reconcile first.
--
-- Run in the Supabase SQL editor (same as 001/002), or:
--   supabase db push

-- ─── 1. Policy — give trips_group_edit an explicit WITH CHECK ─
-- Dropped and recreated by name (guarded) rather than altered, so the file
-- is re-runnable.
drop policy if exists "trips_group_edit" on public.trips;

create policy "trips_group_edit" on public.trips
  for update
  using (
    exists (
      select 1 from public.group_members gm
      where gm.trip_id = trips.id
        and gm.user_id = auth.uid()
        and gm.role = 'editor'
    )
  )
  with check (
    exists (
      select 1 from public.group_members gm
      where gm.trip_id = trips.id
        and gm.user_id = auth.uid()
        and gm.role = 'editor'
    )
    -- An editor's write may never leave the trip owned by the editor.
    -- This cannot break an owner who also holds an 'editor' membership row:
    -- for them trips_owner_all's check (auth.uid() = user_id) is true, and
    -- permissive checks are OR-ed.
    and user_id <> auth.uid()
  );

-- ─── 2. Trigger — pin the owner-only columns ──────────────────
-- SECURITY INVOKER (the default) on purpose: the function compares OLD to
-- NEW and needs no privileges of its own.
create or replace function public.guard_trip_owner_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  offending text;
begin
  -- Only the API roles are constrained. service_role (every backend write,
  -- transfer-ownership included) and the table owner are left alone, so no
  -- server-side flow can be broken by this. Deliberately a negative test:
  -- an unrecognised role fails open rather than breaking the backend.
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  -- The current owner may change anything, ownership included — that is
  -- what a transfer would look like if it ever moved off the service role.
  if old.user_id = auth.uid() then
    return new;
  end if;

  offending := case
    when new.user_id               is distinct from old.user_id               then 'user_id'
    when new.id                    is distinct from old.id                    then 'id'
    when new.created_at            is distinct from old.created_at            then 'created_at'
    when new.status                is distinct from old.status                then 'status'
    when new.is_public             is distinct from old.is_public             then 'is_public'
    when new.allow_clones          is distinct from old.allow_clones          then 'allow_clones'
    when new.allow_recommendations is distinct from old.allow_recommendations then 'allow_recommendations'
    when new.cloned_from_trip_id   is distinct from old.cloned_from_trip_id   then 'cloned_from_trip_id'
    when new.clone_count           is distinct from old.clone_count           then 'clone_count'
    else null
  end;

  if offending is not null then
    raise exception
      'trips.% is owner-only and cannot be changed by a collaborator', offending
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- `update of <columns>` fires only when one of those columns appears in the
-- statement's SET list. PostgREST builds SET from the request body's keys
-- and the canvas save path writes none of them, so the hot path pays
-- nothing and every attempt to touch an ownership column is still caught.
drop trigger if exists trips_owner_columns_guard on public.trips;

create trigger trips_owner_columns_guard
  before update of
    user_id, id, created_at, status, is_public,
    allow_clones, allow_recommendations, cloned_from_trip_id, clone_count
  on public.trips
  for each row
  execute function public.guard_trip_owner_columns();

-- Same stance as security_fixes.sql: keep it off the public API. EXECUTE is
-- only checked at CREATE TRIGGER time, never when the trigger fires, so
-- revoking here does not stop the guard from running.
revoke execute on function public.guard_trip_owner_columns() from public;

-- ─── 3. Verify ────────────────────────────────────────────────
-- (1) Policy shape — trips_group_edit's with_check_expr must be non-null,
--     and this is also the drift check: no other UPDATE/ALL policy on trips
--     should be present beyond trips_owner_all and trips_group_edit.
-- select polname, polcmd,
--        pg_get_expr(polqual, polrelid)      as using_expr,
--        pg_get_expr(polwithcheck, polrelid) as with_check_expr
--   from pg_policy
--  where polrelid = 'public.trips'::regclass
--  order by polname;
--
-- (2) Guard trigger is attached:
-- select tgname, pg_get_triggerdef(oid)
--   from pg_trigger
--  where tgrelid = 'public.trips'::regclass and not tgisinternal;
--
-- (3) Pick a real trip that has an editor, for (4)–(7):
-- select t.id as trip_id, t.user_id as owner_id, gm.user_id as editor_id
--   from public.trips t
--   join public.group_members gm
--     on gm.trip_id = t.id and gm.role = 'editor' and gm.user_id is not null
--  limit 5;
--
-- (4) THE ESCALATION — must now fail with 42501. Before this migration the
--     same block reported UPDATE 1 and the editor owned the trip:
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<EDITOR_ID>","role":"authenticated"}';
--   select auth.uid();   -- sanity: must print <EDITOR_ID>. If it prints
--                        -- null, this build of auth.uid() reads the older
--                        -- GUC — add:
--                        -- select set_config('request.jwt.claim.sub','<EDITOR_ID>',true);
--   update public.trips set user_id = auth.uid() where id = '<TRIP_ID>';
-- rollback;
--
-- (5) THE LEGITIMATE EDITOR WRITE — must still report UPDATE 1:
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<EDITOR_ID>","role":"authenticated"}';
--   update public.trips
--      set title = title, total_cost = total_cost, updated_at = now()
--    where id = '<TRIP_ID>';
-- rollback;
--
-- (6) THE OWNER'S OWN WRITES — must still report UPDATE 1:
-- begin;
--   set local role authenticated;
--   set local request.jwt.claims = '{"sub":"<OWNER_ID>","role":"authenticated"}';
--   update public.trips set updated_at = now() where id = '<TRIP_ID>';
-- rollback;
--
-- (7) TRANSFER — the path the app actually uses. service_role bypasses RLS
--     and the trigger's role guard, so this must report UPDATE 1:
-- begin;
--   set local role service_role;
--   update public.trips set user_id = '<EDITOR_ID>' where id = '<TRIP_ID>';
-- rollback;
--
-- After applying, ../SCHEMA_SNAPSHOT.sql is out of date for trips (it still
-- shows trips_group_edit without a WITH CHECK and no triggers on trips).
-- Refresh it, or note the drift, so the snapshot keeps describing the live DB.
