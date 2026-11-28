-- ============================================================================
-- 016: Text-your-trip assistant "Blue" (iMessage / SMS) — verified phones,
--      threads linked to trips, one-time codes, opt-outs, the nudge ledger
-- ============================================================================
-- APPLIED + VERIFIED 2026-11-28 with the owner's OK, this exact file, via the
-- Supabase Management API (POST /v1/projects/{ref}/database/query):
--   1. rehearsal supabase/dry-runs/016_text_threads.dry-run.sql on the real
--      project inside begin … rollback: 39/39 PASS, nothing left behind;
--   2. applied; 3. the same 39 checks re-run live (rolled back): 39/39 PASS;
--      all 6 tables RLS on, 1 policy (user_phones owner read), browser roles
--      cannot insert, 0 rows in every new table.
-- Re-running is safe (every statement is `if not exists` / guarded).
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
-- the last 12 bot turns per linked thread (text_threads.history), which go
-- when the thread is unlinked or the trip is deleted.
--
-- WHY EACH TABLE / COLUMN (nothing here that today's feature doesn't use):
--   user_phones.user_id, phone_e164  who is texting: a text arrives as a
--       phone number; this maps it to a BlueMurr account so the bot knows
--       which trips the sender may see. One phone per user, one user per phone.
--   user_phones.verified_at          shown in Settings ("verified on …").
--   text_threads.provider, provider_thread_id  which chat (a 1:1 or group on
--       Sendblue/Twilio) a text came from; unique per provider.
--   text_threads.trip_id             the trip that chat asks about / edits.
--   text_threads.linked_by, linked_at  who linked it and when (audit; only
--       owner/editor may link).
--   text_threads.history             the last 12 turns, so "do the first one"
--       works across texts and across a container restart.
--   text_threads.participants        who was in the chat at its latest text;
--       every proactive text re-checks it, so trip details never go to a
--       number that isn't a verified member of the trip.
--   text_threads.muted_until         "BlueMurr mute 2h" / "mute".
--   text_link_codes.*                the one-time code that proves "this phone
--       belongs to this signed-in account" (and, for kind=link, picks the
--       trip). expires_at/used_at make it 15-min single use.
--   text_phone_prefs.opted_out_at    STOP / START, per PHONE (anyone can text
--       STOP, account or not); must survive a restart to stay legal.
--   text_phone_prefs.proactive_consent_at  "BlueMurr alerts on": explicit
--       consent for Blue to text FIRST (verifying a phone is not consent).
--   blue_nudges.*                    claim-first ledger of proactive texts:
--       a row is inserted BEFORE sending and (trip_id, nudge_key) is the
--       primary key, so a restart or a second worker can never send the same
--       nudge twice. local_day + status drive the daily budget.
--   text_legs_booked.*               "BlueMurr booked": a leg booked outside
--       the app, so Blue stops asking about it and sends leave-now instead.
-- Deferred (NOT created): pending edits and delivery dedupe stay in memory
-- until texted edits are saved to trips; they get their own migration then.
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
  participants        text[]      not null default '{}',
  muted_until         timestamptz,
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

-- 4) Opt-out and consent, per phone number.
-- SAFE ON PRODUCTION: new, empty table.
create table if not exists public.text_phone_prefs (
  phone_e164            text        primary key check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  opted_out_at          timestamptz,
  proactive_consent_at  timestamptz,
  updated_at            timestamptz not null default now()
);

-- 5) Ledger of proactive texts ("Blue texts first"), claim-first.
-- SAFE ON PRODUCTION: new, empty table. Deleting a trip deletes its rows;
-- unlinking a thread keeps the row (so the nudge still never repeats).
create table if not exists public.blue_nudges (
  trip_id     uuid        not null references public.trips(id) on delete cascade,
  nudge_key   text        not null check (char_length(nudge_key) between 1 and 200),
  thread_id   uuid        references public.text_threads(id) on delete set null,
  local_day   date        not null,
  status      text        not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  claimed_at  timestamptz not null default now(),
  primary key (trip_id, nudge_key)
);
create index if not exists blue_nudges_trip_day_idx on public.blue_nudges (trip_id, local_day);

-- 6) Legs a traveller said are booked elsewhere.
-- SAFE ON PRODUCTION: new, empty table.
create table if not exists public.text_legs_booked (
  trip_id    uuid        not null references public.trips(id) on delete cascade,
  leg_id     text        not null check (char_length(leg_id) between 1 and 200),
  marked_by  uuid        references auth.users(id) on delete set null,
  marked_at  timestamptz not null default now(),
  primary key (trip_id, leg_id)
);

-- 7) RLS on all six. The rls_auto_enable event trigger would do this anyway;
--    declared for intent.
-- SAFE ON PRODUCTION: affects only the new tables.
alter table public.user_phones        enable row level security;
alter table public.text_threads       enable row level security;
alter table public.text_link_codes    enable row level security;
alter table public.text_phone_prefs   enable row level security;
alter table public.blue_nudges        enable row level security;
alter table public.text_legs_booked   enable row level security;

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

-- 8) Browser roles: read own phone only; never write anything here.
-- SAFE ON PRODUCTION: revokes on the new tables only; service_role keeps all.
revoke insert, update, delete, truncate on public.user_phones from anon, authenticated;
revoke all on public.text_threads, public.text_link_codes, public.text_phone_prefs,
              public.blue_nudges, public.text_legs_booked from anon, authenticated;

-- ============================================================================
-- Housekeeping (run from the backend, not here): delete text_link_codes
-- rows older than 7 days.
-- ============================================================================

-- ============================================================================
-- REVERSAL (run only to undo; unlinks every texting thread and forgets every
-- verified phone — users would re-verify by texting a new code):
--
--   drop table if exists public.text_legs_booked;
--   drop table if exists public.blue_nudges;
--   drop table if exists public.text_phone_prefs;
--   drop table if exists public.text_link_codes;
--   drop table if exists public.text_threads;
--   drop table if exists public.user_phones;
-- ============================================================================
