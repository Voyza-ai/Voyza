-- 011 — break the trips ⇄ group_members RLS policy cycle.
--
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → paste → Run).
--
-- WHY: `group_members_owner_all` decides "is the caller this trip's owner" by
-- selecting from `trips`. That SELECT runs under trips' own RLS, whose
-- `trips_group_select` / `trips_group_edit` policies select from
-- `group_members` — which evaluates `group_members_owner_all` again, which
-- selects from `trips`… Postgres detects the loop and aborts EVERY
-- authenticated-role statement on `trips` with
--   42P17 infinite recursion detected in policy for relation "trips"
-- before any USING / WITH CHECK is reached. Measured on production on
-- 2026-09-12: an owner's ordinary UPDATE and an editor's ordinary UPDATE both
-- failed this way, with the pre-008 policy and with the 008 one alike. The
-- app has only worked because every write goes through the backend's
-- service-role client, which bypasses RLS entirely.
--
-- FIX: answer "is the caller the owner" with a SECURITY DEFINER function.
-- It reads `trips` as the function owner (RLS is not evaluated), so the
-- chain trips → group_members → is_trip_owner() terminates.
--
-- SAFE ON PRODUCTION: no rows are touched. The policy's meaning is
-- unchanged — the same predicate, evaluated without recursing. Reversal is
-- the pre-011 policy text at the bottom of this file.

create or replace function public.is_trip_owner(p_trip_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.trips t
    where t.id = p_trip_id
      and t.user_id = auth.uid()
  );
$$;

-- Policies evaluate as the calling role, so the API roles need EXECUTE.
-- (anon gets auth.uid() = null → false; granting it avoids a "permission
-- denied for function" error on anonymous reads of group_members.)
revoke execute on function public.is_trip_owner(uuid) from public;
grant execute on function public.is_trip_owner(uuid) to authenticated, anon;

drop policy if exists "group_members_owner_all" on public.group_members;
create policy "group_members_owner_all" on public.group_members
  for all
  using (public.is_trip_owner(trip_id))
  with check (public.is_trip_owner(trip_id));

-- ── Reversal ────────────────────────────────────────────────────────────
-- drop policy if exists "group_members_owner_all" on public.group_members;
-- create policy "group_members_owner_all" on public.group_members
--   for all using (
--     exists (select 1 from public.trips t
--             where t.id = group_members.trip_id and t.user_id = auth.uid())
--   );
-- drop function if exists public.is_trip_owner(uuid);
