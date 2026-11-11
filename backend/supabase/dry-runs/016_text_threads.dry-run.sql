-- ============================================================================
-- DRY RUN — 016_text_threads.sql
-- ============================================================================
-- Changes NOTHING. Paste this whole file into the Supabase SQL editor and
-- Run. It applies 016 inside one transaction, probes every behaviour it adds
-- — happy paths, the SECOND write (same phone, same thread, same code, same
-- pending edit, same delivery), the stale-row cases (a phone moving
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
          and to_regclass('public.text_link_codes') is null and to_regclass('public.text_pending_edits') is null
          and to_regclass('public.text_inbound_seen') is null)::text, 'true';

-- ═══ APPLY 016_text_threads.sql (verbatim, comments trimmed) ═══════════════

create table if not exists public.user_phones (
  user_id uuid primary key references auth.users(id) on delete cascade,
  phone_e164 text not null unique check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  verified_at timestamptz not null default now()
);
create table if not exists public.text_threads (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('sendblue', 'twilio', 'simulator')),
  provider_thread_id text not null,
  trip_id uuid not null references public.trips(id) on delete cascade,
  linked_by uuid references auth.users(id) on delete set null,
  linked_at timestamptz not null default now(),
  history jsonb not null default '[]'::jsonb,
  unique (provider, provider_thread_id)
);
create index if not exists text_threads_trip_idx on public.text_threads (trip_id);
create table if not exists public.text_link_codes (
  code text primary key check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  kind text not null check (kind in ('link', 'verify')),
  trip_id uuid not null references public.trips(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  check (expires_at > created_at)
);
create index if not exists text_link_codes_expiry_idx on public.text_link_codes (expires_at);
create table if not exists public.text_pending_edits (
  thread_id uuid primary key references public.text_threads(id) on delete cascade,
  trip_id uuid not null references public.trips(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  result jsonb not null,
  summary text not null,
  trip_updated_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists public.text_inbound_seen (
  provider text not null,
  provider_message_id text not null,
  seen_at timestamptz not null default now(),
  primary key (provider, provider_message_id)
);
create index if not exists text_inbound_seen_at_idx on public.text_inbound_seen (seen_at);
alter table public.user_phones        enable row level security;
alter table public.text_threads       enable row level security;
alter table public.text_link_codes    enable row level security;
alter table public.text_pending_edits enable row level security;
alter table public.text_inbound_seen  enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'user_phones' and policyname = 'user_phones_owner_select') then
    create policy "user_phones_owner_select" on public.user_phones for select using (auth.uid() = user_id);
  end if;
end $$;
revoke insert, update, delete, truncate on public.user_phones from anon, authenticated;
revoke all on public.text_threads, public.text_link_codes, public.text_pending_edits,
              public.text_inbound_seen from anon, authenticated;

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

-- 15) Pending edit: second insert for a thread fails; the upsert replaces it.
insert into public.text_pending_edits (thread_id, trip_id, requested_by, result, summary, expires_at)
  select t.id, trip_b, u1, '{"type":"proposal"}', 'first', now() + interval '10 minutes'
    from public.text_threads t, _ids where t.provider = 'sendblue' and t.provider_thread_id = 'grp_dry';
do $$ begin
  insert into public.text_pending_edits (thread_id, trip_id, result, summary, expires_at)
    select t.id, trip_b, '{}', 'second', now() + interval '10 minutes'
      from public.text_threads t, _ids where t.provider = 'sendblue' and t.provider_thread_id = 'grp_dry';
  insert into _checks values (15, 'second pending edit, same thread', 'ACCEPTED', 'rejected');
exception when unique_violation then
  insert into _checks values (15, 'second pending edit, same thread', 'rejected', 'rejected');
end $$;
insert into public.text_pending_edits (thread_id, trip_id, result, summary, expires_at)
  select t.id, trip_b, '{}', 'second', now() + interval '10 minutes'
    from public.text_threads t, _ids where t.provider = 'sendblue' and t.provider_thread_id = 'grp_dry'
  on conflict (thread_id) do update set summary = excluded.summary, result = excluded.result;
insert into _checks select 16, 'pending upsert keeps one row', string_agg(summary, ','), 'second' from public.text_pending_edits;

-- 17) Dedupe: the second delivery of a message id inserts nothing.
insert into public.text_inbound_seen (provider, provider_message_id) values ('sendblue', 'msg_dry');
with s as (insert into public.text_inbound_seen (provider, provider_message_id) values ('sendblue', 'msg_dry')
           on conflict do nothing returning 1)
insert into _checks select 17, 'redelivered message id', count(*)::text, '0' from s;

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

-- 24) Delete rules: deleting a trip removes its threads, codes and pending edits.
delete from public.trips t using _ids where t.id = _ids.trip_b;
insert into _checks select 24, 'trip delete cascades thread + pending',
       ((select count(*) from public.text_threads where provider = 'sendblue' and provider_thread_id = 'grp_dry') = 0
        and (select count(*) from public.text_pending_edits) = 0)::text, 'true';
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
   where tablename in ('user_phones','text_threads','text_link_codes','text_pending_edits','text_inbound_seen');

select n, check_name, result, expected,
       case when result = expected then 'PASS' else 'FAIL' end as status
  from _checks order by n;

rollback;
