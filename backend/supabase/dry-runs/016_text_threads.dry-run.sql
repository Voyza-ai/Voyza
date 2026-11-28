-- ============================================================================
-- DRY RUN — 016_text_threads.sql
-- ============================================================================
-- Changes NOTHING. Paste this whole file into the Supabase SQL editor and
-- Run. It applies 016 inside one transaction, probes every behaviour it adds
-- — happy paths, the SECOND write (same phone, same thread, same code),
-- the stale-row cases (a phone moving
-- accounts, a thread re-linked to another trip), bad values, privileges and
-- RLS, the delete rules, and running 016 twice — then ROLLS BACK. Every row
-- in the Results tab must say PASS.
--
-- Rows are written for the booking TEST account
-- (14eb5557-76aa-4986-8dee-dc9e3daab35e) plus one other existing user (read
-- by id, never changed), on a throwaway trip created here; all vanish with
-- the rollback. Lives in dry-runs/, not migrations/, so `supabase db push`
-- never runs it.
-- ============================================================================

begin;

create temp table _checks (n int, check_name text, result text, expected text);
grant all on _checks to authenticated;

-- 0) Nothing on `dev` owns these names yet (the DB may move ahead of the branch).
insert into _checks
  select 0, 'no 016 tables before apply',
         (to_regclass('public.user_phones') is null and to_regclass('public.text_threads') is null
          and to_regclass('public.text_link_codes') is null and to_regclass('public.text_phone_prefs') is null
          and to_regclass('public.blue_nudges') is null and to_regclass('public.text_legs_booked') is null)::text, 'true';

-- ═══ APPLY 016_text_threads.sql (VERBATIM — regenerate this block if the file changes) ═══

-- ============================================================================
-- 016: Text-your-trip assistant "Blue" (iMessage / SMS) — verified phones,
--      threads linked to trips, one-time codes, opt-outs, the nudge ledger
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

-- ═══ FIXTURES (rolled back) ═════════════════════════════════════════════════

create temp table _ids as
  select '14eb5557-76aa-4986-8dee-dc9e3daab35e'::uuid as u1,
         (select id from auth.users where id <> '14eb5557-76aa-4986-8dee-dc9e3daab35e' order by created_at limit 1) as u2,
         gen_random_uuid() as trip_a,
         gen_random_uuid() as trip_b;
grant all on _ids to authenticated;
insert into public.trips (id, user_id, title) select trip_a, u1, 'DRY RUN 016 A' from _ids;
insert into public.trips (id, user_id, title) select trip_b, u1, 'DRY RUN 016 B' from _ids;

-- ═══ PROBES ═════════════════════════════════════════════════════════════════

-- 1) Phone: happy path.
insert into public.user_phones (user_id, phone_e164) select u1, '+14155550001' from _ids;
insert into _checks select 1, 'phone saved', count(*)::text, '1' from public.user_phones where phone_e164 = '+14155550001';

-- 2) SECOND write: the same phone for another user must fail.
do $$ begin
  insert into public.user_phones (user_id, phone_e164) select u2, '+14155550001' from _ids;
  insert into _checks values (2, 'same phone, second user', 'ACCEPTED', 'rejected');
exception when unique_violation then
  insert into _checks values (2, 'same phone, second user', 'rejected', 'rejected');
end $$;

-- 3) SECOND write: a second phone for the same user must fail (one per user)…
do $$ begin
  insert into public.user_phones (user_id, phone_e164) select u1, '+14155550002' from _ids;
  insert into _checks values (3, 'second phone, same user', 'ACCEPTED', 'rejected');
exception when unique_violation then
  insert into _checks values (3, 'second phone, same user', 'rejected', 'rejected');
end $$;

-- 4) …and the backend's upsert (change my number) replaces it.
insert into public.user_phones (user_id, phone_e164) select u1, '+14155550002' from _ids
  on conflict (user_id) do update set phone_e164 = excluded.phone_e164, verified_at = now();
insert into _checks select 4, 'change number via upsert', phone_e164, '+14155550002'
  from public.user_phones, _ids where user_id = u1;

-- 5) Stale row: a phone moving accounts (backend deletes the old owner's row
--    for that phone, then upserts) leaves exactly one owner.
delete from public.user_phones where phone_e164 = '+14155550002';
insert into public.user_phones (user_id, phone_e164) select u2, '+14155550002' from _ids
  on conflict (user_id) do update set phone_e164 = excluded.phone_e164;
insert into _checks select 5, 'phone moved accounts', (user_id = u2)::text, 'true'
  from public.user_phones, _ids where phone_e164 = '+14155550002';

-- 6) Bad phone format must fail.
do $$ begin
  insert into public.user_phones (user_id, phone_e164) select u1, '4155550003' from _ids;
  insert into _checks values (6, 'non-E.164 phone', 'ACCEPTED', 'rejected');
exception when check_violation then
  insert into _checks values (6, 'non-E.164 phone', 'rejected', 'rejected');
end $$;

-- 7) Thread: happy path, then the SECOND link of the same provider thread fails…
insert into public.text_threads (provider, provider_thread_id, trip_id, linked_by)
  select 'sendblue', 'grp_dry', trip_a, u1 from _ids;
do $$ begin
  insert into public.text_threads (provider, provider_thread_id, trip_id, linked_by)
    select 'sendblue', 'grp_dry', trip_b, u1 from _ids;
  insert into _checks values (7, 'same thread linked twice', 'ACCEPTED', 'rejected');
exception when unique_violation then
  insert into _checks values (7, 'same thread linked twice', 'rejected', 'rejected');
end $$;

-- 8) …stale row: re-linking to another trip (backend upsert) moves it and
--    resets history.
update public.text_threads set history = '[{"role":"user","content":"old"}]' where provider_thread_id = 'grp_dry';
insert into public.text_threads (provider, provider_thread_id, trip_id, linked_by)
  select 'sendblue', 'grp_dry', trip_b, u1 from _ids
  on conflict (provider, provider_thread_id)
  do update set trip_id = excluded.trip_id, linked_by = excluded.linked_by, linked_at = now(), history = '[]'::jsonb;
insert into _checks select 8, 're-link moves trip + clears history',
       ((trip_id = trip_b) and history = '[]'::jsonb)::text, 'true'
  from public.text_threads, _ids where provider_thread_id = 'grp_dry';

-- 9) Same id on another provider is a different thread.
insert into public.text_threads (provider, provider_thread_id, trip_id) select 'twilio', 'grp_dry', trip_a from _ids;
insert into _checks select 9, 'same id, other provider', count(*)::text, '2' from public.text_threads where provider_thread_id = 'grp_dry';

-- 10) Codes: the consume statement wins once, then returns nothing.
insert into public.text_link_codes (code, kind, trip_id, user_id, expires_at)
  select 'ABC234', 'link', trip_a, u1, now() + interval '15 minutes' from _ids;
with c as (update public.text_link_codes set used_at = now()
            where code = 'ABC234' and used_at is null and expires_at > now() returning 1)
insert into _checks select 10, 'first consume', count(*)::text, '1' from c;
with c as (update public.text_link_codes set used_at = now()
            where code = 'ABC234' and used_at is null and expires_at > now() returning 1)
insert into _checks select 11, 'SECOND consume of same code', count(*)::text, '0' from c;

-- 12) An expired code is not consumable. (created_at back-dated to satisfy
--     the expires_at > created_at check.)
insert into public.text_link_codes (code, kind, trip_id, user_id, created_at, expires_at)
  select 'XYZ789', 'verify', trip_a, u1, now() - interval '1 hour', now() - interval '1 minute' from _ids;
with c as (update public.text_link_codes set used_at = now()
            where code = 'XYZ789' and used_at is null and expires_at > now() returning 1)
insert into _checks select 12, 'expired code', count(*)::text, '0' from c;

-- 13) Codes with confusable characters (0, O, 1, I, L) or bad kind fail.
do $$ begin
  insert into public.text_link_codes (code, kind, trip_id, user_id, expires_at)
    select 'ABC0O1', 'link', trip_a, u1, now() + interval '1 minute' from _ids;
  insert into _checks values (13, 'confusable code chars', 'ACCEPTED', 'rejected');
exception when check_violation then
  insert into _checks values (13, 'confusable code chars', 'rejected', 'rejected');
end $$;
do $$ begin
  insert into public.text_link_codes (code, kind, trip_id, user_id, expires_at)
    select 'DEF567', 'admin', trip_a, u1, now() + interval '1 minute' from _ids;
  insert into _checks values (14, 'bad code kind', 'ACCEPTED', 'rejected');
exception when check_violation then
  insert into _checks values (14, 'bad code kind', 'rejected', 'rejected');
end $$;

-- 18–21) Privileges: browser roles cannot write anything here or read the bot tables.
insert into _checks values
  (18, 'authenticated may NOT insert user_phones', has_table_privilege('authenticated', 'public.user_phones', 'insert')::text, 'false'),
  (19, 'authenticated may NOT read text_threads',  has_table_privilege('authenticated', 'public.text_threads', 'select')::text, 'false'),
  (20, 'anon may NOT read text_link_codes',        has_table_privilege('anon', 'public.text_link_codes', 'select')::text, 'false'),
  (21, 'service_role may write text_threads',      has_table_privilege('service_role', 'public.text_threads', 'insert')::text, 'true');

-- 22–23) RLS as the browser sees user_phones: the test user has a phone again,
--        u2 has one too; the test user must see exactly its own.
insert into public.user_phones (user_id, phone_e164) select u1, '+14155550003' from _ids;
set local role authenticated;
set local request.jwt.claims = '{"sub":"14eb5557-76aa-4986-8dee-dc9e3daab35e","role":"authenticated"}';
insert into _checks select 22, 'test user sees only own phone row', string_agg(phone_e164, ','), '+14155550003' from public.user_phones;
reset role;
insert into _checks select 23, 'u2 owns the moved phone (service view)', count(*)::text, '1'
  from public.user_phones, _ids where user_id = u2;

-- 24) Delete rules: deleting a trip removes its threads and codes.
delete from public.trips t using _ids where t.id = _ids.trip_b;
insert into _checks select 24, 'trip delete cascades thread',
       (select count(*) from public.text_threads where provider = 'sendblue' and provider_thread_id = 'grp_dry')::text, '0';
delete from public.trips t using _ids where t.id = _ids.trip_a;
insert into _checks select 25, 'trip delete cascades codes', count(*)::text, '0' from public.text_link_codes;

-- 26) user delete → phones cascade (checked on the constraint, not by deleting a real user).
insert into _checks
  select 26, 'user delete → phone cascade', confdeltype::text, 'c'
    from pg_constraint where conrelid = 'public.user_phones'::regclass and contype = 'f';

-- 27) Running 016 a SECOND time is a no-op and does not error.
do $$ begin
  create table if not exists public.user_phones (user_id uuid primary key);
  create table if not exists public.text_threads (id uuid primary key);
  create index if not exists text_threads_trip_idx on public.text_threads (trip_id);
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_phones' and policyname = 'user_phones_owner_select') then
    create policy "user_phones_owner_select" on public.user_phones for select using (auth.uid() = user_id);
  end if;
  revoke insert, update, delete, truncate on public.user_phones from anon, authenticated;
  insert into _checks values (27, 'second run', 'ok', 'ok');
exception when others then
  insert into _checks values (27, 'second run', 'ERROR: ' || sqlerrm, 'ok');
end $$;
insert into _checks
  select 28, 'exactly one policy across 016 tables', count(*)::text, '1' from pg_policies
   where tablename in ('user_phones','text_threads','text_link_codes','text_phone_prefs','blue_nudges','text_legs_booked');


-- ═══ PROBES for the tables added for "Blue texts first" ═════════════════════
-- (fresh fixtures: the trips above were deleted by probes 24–25)
insert into public.trips (id, user_id, title) select trip_a, u1, 'DRY RUN 016 A2' from _ids;
insert into public.text_threads (provider, provider_thread_id, trip_id, linked_by)
  select 'twilio', 'conv_dry', trip_a, u1 from _ids;

-- 29) New threads start with no participants and not muted.
insert into _checks select 29, 'thread defaults', (participants = '{}' and muted_until is null)::text, 'true'
  from public.text_threads where provider_thread_id = 'conv_dry';

-- 30) STOP: first write, then the SECOND write for the same phone upserts.
insert into public.text_phone_prefs (phone_e164, opted_out_at) values ('+12155550001', now());
insert into public.text_phone_prefs (phone_e164, opted_out_at, proactive_consent_at) values ('+12155550001', null, now())
  on conflict (phone_e164) do update set opted_out_at = excluded.opted_out_at,
    proactive_consent_at = excluded.proactive_consent_at, updated_at = now();
insert into _checks select 30, 'START + alerts on via upsert', (opted_out_at is null and proactive_consent_at is not null)::text, 'true'
  from public.text_phone_prefs where phone_e164 = '+12155550001';
do $$ begin
  insert into public.text_phone_prefs (phone_e164) values ('2155550001');
  insert into _checks values (31, 'non-E.164 pref phone', 'ACCEPTED', 'rejected');
exception when check_violation then
  insert into _checks values (31, 'non-E.164 pref phone', 'rejected', 'rejected');
end $$;

-- 32–33) Nudge ledger: the claim wins once; a SECOND claim (re-run, restart,
-- other worker) gets nothing — also while the first is still 'pending' (stale row).
with c as (insert into public.blue_nudges (trip_id, nudge_key, thread_id, local_day)
             select trip_a, 'unbooked:Venice→Rome:2027-05-22', t.id, '2027-05-20' from _ids, public.text_threads t
              where t.provider_thread_id = 'conv_dry'
           on conflict (trip_id, nudge_key) do nothing returning 1)
insert into _checks select 32, 'first claim', count(*)::text, '1' from c;
with c as (insert into public.blue_nudges (trip_id, nudge_key, local_day)
             select trip_a, 'unbooked:Venice→Rome:2027-05-22', '2027-05-21' from _ids
           on conflict (trip_id, nudge_key) do nothing returning 1)
insert into _checks select 33, 'SECOND claim while first still pending', count(*)::text, '0' from c;

-- 34) Status is constrained; the budget count reads sent rows for the day.
update public.blue_nudges set status = 'sent' where nudge_key like 'unbooked:%';
do $$ begin
  update public.blue_nudges set status = 'delivered';
  insert into _checks values (34, 'bad nudge status', 'ACCEPTED', 'rejected');
exception when check_violation then
  insert into _checks values (34, 'bad nudge status', 'rejected', 'rejected');
end $$;
insert into _checks select 35, 'sent today (budget count)', count(*)::text, '1'
  from public.blue_nudges, _ids where trip_id = trip_a and local_day = '2027-05-20' and status = 'sent';

-- 36) "booked": a second mark is a no-op.
insert into public.text_legs_booked (trip_id, leg_id, marked_by) select trip_a, 'Venice→Rome', u1 from _ids;
with c as (insert into public.text_legs_booked (trip_id, leg_id) select trip_a, 'Venice→Rome' from _ids
           on conflict do nothing returning 1)
insert into _checks select 36, 'SECOND "booked" mark', count(*)::text, '0' from c;

-- 37) Unlinking a thread keeps the ledger row (the nudge still never repeats).
delete from public.text_threads where provider_thread_id = 'conv_dry';
insert into _checks select 37, 'unlink keeps ledger, thread_id → null', (thread_id is null)::text, 'true'
  from public.blue_nudges where nudge_key like 'unbooked:%';

-- 38) Deleting the trip removes its ledger and "booked" rows.
delete from public.trips t using _ids where t.id = _ids.trip_a;
insert into _checks select 38, 'trip delete cascades ledger + booked',
  ((select count(*) from public.blue_nudges) + (select count(*) from public.text_legs_booked))::text, '0';

-- 39–41) Browser roles can't touch the new tables.
insert into _checks values
  (39, 'authenticated may NOT read text_phone_prefs', has_table_privilege('authenticated', 'public.text_phone_prefs', 'select')::text, 'false'),
  (40, 'anon may NOT insert blue_nudges',             has_table_privilege('anon', 'public.blue_nudges', 'insert')::text, 'false'),
  (41, 'authenticated may NOT read text_legs_booked', has_table_privilege('authenticated', 'public.text_legs_booked', 'select')::text, 'false');

select n, check_name, result, expected,
       case when result = expected then 'PASS' else 'FAIL' end as status
  from _checks order by n;

rollback;
