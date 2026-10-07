-- 012: In-app notifications
--
-- ⚠️ Apply manually in the Supabase SQL editor (like 003–005). This migration
-- references objects that exist in PROD but not in this repo's earlier
-- migration files (user_profiles, anonymize_expired_deletions — see
-- SCHEMA_SNAPSHOT.sql). It will NOT run on a from-scratch local DB built
-- from 001–005 alone.
--
-- What this adds:
--   1. notifications table + indexes + RLS (recipients read/update/delete
--      their own rows; INSERT is service-role / SECURITY DEFINER only)
--   2. Realtime publication so the navbar bell updates live
--   3. get_user_id_by_email() RPC — invite notifications need to resolve an
--      email to a user id, and auth.users isn't queryable via PostgREST
--   4. anonymize_expired_deletions() replaced: same PII wipe as before, now
--      also notifies each trip's collaborators (with a clone action) when
--      the trip owner's account is anonymized

-- ── 1. Table ────────────────────────────────────────────────────────────────

create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  type       text not null check (type in (
               'account_deletion_scheduled',
               'trip_owner_anonymized',
               'ownership_transferred',
               'suggestion_decided',
               'canvas_invite'
             )),
  title      text not null,
  body       text,
  data       jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

-- Partial index: the unread badge count is the hottest query.
create index notifications_user_unread_idx
  on public.notifications (user_id) where read_at is null;

-- TODO (retention, deferred): a pg_cron job alongside the existing 03:00 UTC
-- anonymize job — delete from notifications
--   where read_at is not null and created_at < now() - interval '90 days';

-- ── 2. RLS ──────────────────────────────────────────────────────────────────
-- The rls_auto_enable event trigger would enable this anyway; declared
-- explicitly for intent. The SELECT policy is load-bearing for Realtime:
-- postgres_changes respects RLS, so without it the browser gets nothing.

alter table public.notifications enable row level security;

create policy "notifications_owner_select" on public.notifications
  for select using (auth.uid() = user_id);

create policy "notifications_owner_update" on public.notifications
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "notifications_owner_delete" on public.notifications
  for delete using (auth.uid() = user_id);

-- Deliberately NO insert policy: only the service-role backend and the
-- SECURITY DEFINER function below create notifications.

-- ── 3. Realtime ─────────────────────────────────────────────────────────────

alter publication supabase_realtime add table public.notifications;

-- ── 4. Email → user id lookup (for invite notifications) ───────────────────
-- SECURITY DEFINER because auth.users is not reachable via PostgREST. The
-- revoke is mandatory: exposed to clients this would leak whether an email
-- has an account.

create or replace function public.get_user_id_by_email(p_email text)
returns uuid
language sql security definer set search_path to 'auth','public' as $$
  select id from auth.users where lower(email) = lower(p_email) limit 1;
$$;

revoke execute on function public.get_user_id_by_email(text) from public;
revoke execute on function public.get_user_id_by_email(text) from anon, authenticated;

-- ── 5. Anonymize + notify collaborators ────────────────────────────────────
-- Identical to the deployed function (SCHEMA_SNAPSHOT.sql) plus one insert:
-- before wiping the owner's PII, every accepted collaborator on the owner's
-- trips gets a 'trip_owner_anonymized' notification carrying a clone action,
-- unless they opted out (preferences.notifications.trip_owner_anonymized =
-- false) or are pending deletion themselves. Runs in the same transaction
-- as the wipe.

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
    -- NEW: notify collaborators of this owner's trips (clone action).
    insert into public.notifications (user_id, type, title, body, data)
    select gm.user_id,
           'trip_owner_anonymized',
           'A trip owner deleted their account',
           'The owner of "' || coalesce(t.title, 'a shared trip')
             || '" deleted their account. Clone the trip to keep your own editable copy.',
           jsonb_build_object('tripId', t.id, 'tripTitle', t.title, 'action', 'clone')
    from public.trips t
    join public.group_members gm on gm.trip_id = t.id
    join public.user_profiles up on up.id = gm.user_id
    where t.user_id = target.id
      and gm.user_id is not null
      and gm.user_id <> target.id
      and gm.accepted_at is not null
      and up.deleted_at is null
      and coalesce((up.preferences #>> '{notifications,trip_owner_anonymized}')::boolean, true);

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

-- Folds in the standing security-advisor TODO for this function while we're
-- touching it (clients must not be able to run the wipe).
revoke execute on function public.anonymize_expired_deletions() from public;
revoke execute on function public.anonymize_expired_deletions() from anon, authenticated;
