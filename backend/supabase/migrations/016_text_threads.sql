-- ============================================================================
-- 016: Group-text trip assistant (iMessage / SMS bot) — threads, verified
--      phones, one-time codes, pending edits, delivery dedupe
-- ============================================================================
-- NOT APPLIED. Run by hand in the Supabase SQL editor (Dashboard → SQL
-- Editor → paste → Run), after first running the rehearsal
-- supabase/dry-runs/016_text_threads.dry-run.sql (which changes nothing and
-- must report PASS on every row).
--
-- Until this is applied the bot keeps all of this in process memory
-- (services/textbot/store.ts, MemoryTextStore): links and verified phones are
-- lost on restart. Nothing currently on `dev` reads or writes these tables,
-- so applying this ahead of the branch merge changes no existing behaviour.
--
-- Personal data: a phone number per user (E.164 only). Visible to its owner
-- only; written only by the service-role backend after the user proved the
-- number by texting a one-time code from it. Deleted with the account
-- (ON DELETE CASCADE from auth.users). No message bodies are stored except
-- the last few bot turns per linked thread (text_threads.history), which go
-- when the thread is unlinked or the trip is deleted.
--
-- Access: users may SELECT their own phone row. Everything else has NO
-- policies: only the service-role backend reads or writes it.
-- ============================================================================

-- 1) Verified phones — one per user, one user per phone.
-- SAFE ON PRODUCTION: new, empty table; touches no existing table.
create table if not exists public.user_phones (
  user_id      uuid        primary key references auth.users(id) on delete cascade,
  phone_e164   text        not null unique
                 check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  verified_at  timestamptz not null default now()
);

-- 2) A provider thread (group or 1:1) linked to one trip.
-- SAFE ON PRODUCTION: new, empty table. Deleting a trip unlinks its threads.
create table if not exists public.text_threads (
  id                  uuid        primary key default gen_random_uuid(),
  provider            text        not null check (provider in ('sendblue', 'twilio', 'simulator')),
  provider_thread_id  text        not null,
  trip_id             uuid        not null references public.trips(id) on delete cascade,
  linked_by           uuid        references auth.users(id) on delete set null,
  linked_at           timestamptz not null default now(),
  history             jsonb       not null default '[]'::jsonb,
  unique (provider, provider_thread_id)
);
create index if not exists text_threads_trip_idx on public.text_threads (trip_id);

-- 3) One-time codes made in the app ("Text your trip"). Single use is
--    enforced by the backend's consume statement:
--      update text_link_codes set used_at = now()
--       where code = $1 and used_at is null and expires_at > now()
--      returning *;
--    which only one of two racing texts can win.
-- SAFE ON PRODUCTION: new, empty table.
create table if not exists public.text_link_codes (
  code        text        primary key check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  kind        text        not null check (kind in ('link', 'verify')),
  trip_id     uuid        not null references public.trips(id) on delete cascade,
  user_id     uuid        not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  check (expires_at > created_at)
);
create index if not exists text_link_codes_expiry_idx on public.text_link_codes (expires_at);

-- 4) At most one edit waiting for YES per thread.
-- SAFE ON PRODUCTION: new, empty table.
create table if not exists public.text_pending_edits (
  thread_id         uuid        primary key references public.text_threads(id) on delete cascade,
  trip_id           uuid        not null references public.trips(id) on delete cascade,
  requested_by      uuid        references auth.users(id) on delete set null,
  result            jsonb       not null,
  summary           text        not null,
  -- trips.updated_at when the edit was proposed: the apply refuses if the
  -- trip changed since (e.g. saved from an open website tab).
  trip_updated_at   timestamptz,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now()
);

-- 5) Provider message ids already handled (webhook retries / poll overlap).
-- SAFE ON PRODUCTION: new, empty table.
create table if not exists public.text_inbound_seen (
  provider             text        not null,
  provider_message_id  text        not null,
  seen_at              timestamptz not null default now(),
  primary key (provider, provider_message_id)
);
create index if not exists text_inbound_seen_at_idx on public.text_inbound_seen (seen_at);

-- 6) RLS on all five. The rls_auto_enable event trigger would do this anyway;
--    declared for intent.
-- SAFE ON PRODUCTION: affects only the new tables.
alter table public.user_phones        enable row level security;
alter table public.text_threads       enable row level security;
alter table public.text_link_codes    enable row level security;
alter table public.text_pending_edits enable row level security;
alter table public.text_inbound_seen  enable row level security;

-- SAFE ON PRODUCTION: one SELECT policy on a new table. Guarded so a second
-- run does not fail on "policy already exists".
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'user_phones' and policyname = 'user_phones_owner_select'
  ) then
    create policy "user_phones_owner_select" on public.user_phones
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- 7) Browser roles: read own phone only; never write anything here.
-- SAFE ON PRODUCTION: revokes on the new tables only; service_role keeps all.
revoke insert, update, delete, truncate on public.user_phones from anon, authenticated;
revoke all on public.text_threads, public.text_link_codes, public.text_pending_edits,
              public.text_inbound_seen from anon, authenticated;

-- ============================================================================
-- Housekeeping (run from the backend, not here): delete text_link_codes and
-- text_inbound_seen rows older than 7 days.
-- ============================================================================

-- ============================================================================
-- REVERSAL (run only to undo; unlinks every texting thread and forgets every
-- verified phone — users would re-verify by texting a new code):
--
--   drop table if exists public.text_pending_edits;
--   drop table if exists public.text_inbound_seen;
--   drop table if exists public.text_link_codes;
--   drop table if exists public.text_threads;
--   drop table if exists public.user_phones;
-- ============================================================================
