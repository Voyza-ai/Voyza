-- ============================================================================
-- DRY RUN — 015_bookings.sql
-- ============================================================================
-- Changes NOTHING. Paste this whole file into the Supabase SQL editor and
-- Run. It applies 015 inside one transaction, probes every behaviour it adds
-- — the happy path, the SECOND write with the same payment intent / order,
-- the stale-row retry, bad values, RLS for the owner vs another user vs a
-- browser write, the foreign-key delete rules, and running 015 twice — then
-- ROLLS BACK. The Results tab shows one table; every row's status must say
-- PASS.
--
-- Rows are written for the booking TEST account only
-- (14eb5557-76aa-4986-8dee-dc9e3daab35e) and vanish with the rollback.
-- Lives in dry-runs/, not migrations/, so `supabase db push` never runs it.
-- ============================================================================

begin;

create temp table _checks (n int, check_name text, result text, expected text);
-- Probes 10–12 run as `authenticated` and still need to record results.
grant all on _checks to authenticated;

-- 0) Nothing on `dev` owns this name yet (the DB may move ahead of the branch).
insert into _checks
  select 0, 'public.bookings absent before apply', (to_regclass('public.bookings') is null)::text, 'true';

-- ═══ APPLY 015_bookings.sql (verbatim) ══════════════════════════════════════

create table if not exists public.bookings (
  id                        uuid        primary key default gen_random_uuid(),
  user_id                   uuid        not null references auth.users(id) on delete cascade,
  trip_id                   uuid        references public.trips(id) on delete set null,
  duffel_offer_id           text        not null,
  duffel_payment_intent_id  text        not null unique,
  duffel_order_id           text        unique,
  booking_reference         text,
  status                    text        not null default 'payment_pending'
                              check (status in ('payment_pending', 'confirmed', 'failed', 'refunded')),
  total_amount              numeric(12,2) not null check (total_amount >= 0),
  total_currency            text        not null check (char_length(total_currency) = 3),
  passengers                jsonb       not null default '[]'::jsonb,
  slices                    jsonb       not null default '[]'::jsonb,
  live_mode                 boolean     not null default false,
  failure_reason            text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint bookings_confirmed_has_order
    check (status <> 'confirmed' or duffel_order_id is not null)
);
create index if not exists bookings_user_created_idx on public.bookings (user_id, created_at desc);
alter table public.bookings enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bookings' and policyname = 'bookings_owner_select') then
    create policy "bookings_owner_select" on public.bookings for select using (auth.uid() = user_id);
  end if;
end $$;
revoke insert, update, delete, truncate on public.bookings from anon, authenticated;

-- ═══ PROBES ═════════════════════════════════════════════════════════════════

-- 1) Happy path, exactly as services/bookingStore.ts writes it.
insert into public.bookings (user_id, duffel_offer_id, duffel_payment_intent_id, total_amount, total_currency, passengers)
values ('14eb5557-76aa-4986-8dee-dc9e3daab35e', 'off_dry', 'pit_dry_1', 214.34, 'USD',
        '[{"given_name":"Test","family_name":"Traveller","type":"adult"}]');
update public.bookings set status = 'confirmed', duffel_order_id = 'ord_dry_1', booking_reference = 'DRY001'
 where duffel_payment_intent_id = 'pit_dry_1';
insert into _checks
  select 1, 'pending → confirmed', status, 'confirmed' from public.bookings where duffel_payment_intent_id = 'pit_dry_1';

-- 2) SECOND write with the same payment intent must fail.
do $$ begin
  insert into public.bookings (user_id, duffel_offer_id, duffel_payment_intent_id, total_amount, total_currency)
  values ('14eb5557-76aa-4986-8dee-dc9e3daab35e', 'off_dry', 'pit_dry_1', 1, 'USD');
  insert into _checks values (2, 'duplicate payment intent', 'ACCEPTED', 'rejected');
exception when unique_violation then
  insert into _checks values (2, 'duplicate payment intent', 'rejected', 'rejected');
end $$;

-- 3) Stale-row retry: a failed attempt, then a new intent for the SAME offer
--    (traveller fixed their card and tried again) must be accepted.
insert into public.bookings (user_id, duffel_offer_id, duffel_payment_intent_id, total_amount, total_currency, status, failure_reason)
values ('14eb5557-76aa-4986-8dee-dc9e3daab35e', 'off_dry_2', 'pit_dry_2', 99, 'USD', 'failed', 'payment_failed');
do $$ begin
  insert into public.bookings (user_id, duffel_offer_id, duffel_payment_intent_id, total_amount, total_currency)
  values ('14eb5557-76aa-4986-8dee-dc9e3daab35e', 'off_dry_2', 'pit_dry_3', 99, 'USD');
  insert into _checks values (3, 'retry same offer, new intent', 'accepted', 'accepted');
exception when others then
  insert into _checks values (3, 'retry same offer, new intent', 'REJECTED: ' || sqlerrm, 'accepted');
end $$;

-- 4) The same Duffel order on a second row must fail.
do $$ begin
  update public.bookings set status = 'confirmed', duffel_order_id = 'ord_dry_1' where duffel_payment_intent_id = 'pit_dry_3';
  insert into _checks values (4, 'duplicate order id', 'ACCEPTED', 'rejected');
exception when unique_violation then
  insert into _checks values (4, 'duplicate order id', 'rejected', 'rejected');
end $$;

-- 5) Confirmed without an order must fail.
do $$ begin
  update public.bookings set status = 'confirmed' where duffel_payment_intent_id = 'pit_dry_3';
  insert into _checks values (5, 'confirmed without order', 'ACCEPTED', 'rejected');
exception when check_violation then
  insert into _checks values (5, 'confirmed without order', 'rejected', 'rejected');
end $$;

-- 6) Unknown status must fail.
do $$ begin
  update public.bookings set status = 'paid' where duffel_payment_intent_id = 'pit_dry_3';
  insert into _checks values (6, 'bad status', 'ACCEPTED', 'rejected');
exception when check_violation then
  insert into _checks values (6, 'bad status', 'rejected', 'rejected');
end $$;

-- 7–9) Privileges: browser roles read only; the backend writes.
insert into _checks values
  (7, 'authenticated may NOT insert', has_table_privilege('authenticated', 'public.bookings', 'insert')::text, 'false'),
  (8, 'anon may NOT update',          has_table_privilege('anon', 'public.bookings', 'update')::text, 'false'),
  (9, 'service_role may insert',      has_table_privilege('service_role', 'public.bookings', 'insert')::text, 'true');

-- 10–12) RLS as the browser would see it.
set local role authenticated;
set local request.jwt.claims = '{"sub":"14eb5557-76aa-4986-8dee-dc9e3daab35e","role":"authenticated"}';
insert into _checks select 10, 'owner sees own bookings', count(*)::text, '3' from public.bookings;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-000000000000","role":"authenticated"}';
insert into _checks select 11, 'another user sees none', count(*)::text, '0' from public.bookings;
do $$ begin
  insert into public.bookings (user_id, duffel_offer_id, duffel_payment_intent_id, total_amount, total_currency)
  values ('00000000-0000-0000-0000-000000000000', 'off_x', 'pit_x', 1, 'USD');
  insert into _checks values (12, 'browser insert', 'ACCEPTED', 'rejected');
exception when insufficient_privilege then
  insert into _checks values (12, 'browser insert', 'rejected', 'rejected');
end $$;
reset role;

-- 13–14) Delete rules: deleting a trip keeps the booking; deleting the user removes it.
insert into _checks
  select 13, 'trip delete → set null', confdeltype::text, 'n'
    from pg_constraint where conrelid = 'public.bookings'::regclass and contype = 'f'
     and confrelid = 'public.trips'::regclass;
insert into _checks
  select 14, 'user delete → cascade', confdeltype::text, 'c'
    from pg_constraint where conrelid = 'public.bookings'::regclass and contype = 'f'
     and confrelid = 'auth.users'::regclass;

-- 15) Running 015 a SECOND time is a no-op and does not error.
do $$ begin
  create table if not exists public.bookings (id uuid primary key);
  create index if not exists bookings_user_created_idx on public.bookings (user_id, created_at desc);
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bookings' and policyname = 'bookings_owner_select') then
    create policy "bookings_owner_select" on public.bookings for select using (auth.uid() = user_id);
  end if;
  revoke insert, update, delete, truncate on public.bookings from anon, authenticated;
  insert into _checks values (15, 'second run', 'ok', 'ok');
exception when others then
  insert into _checks values (15, 'second run', 'ERROR: ' || sqlerrm, 'ok');
end $$;
insert into _checks
  select 16, 'exactly one policy', count(*)::text, '1' from pg_policies where tablename = 'bookings';

select n, check_name, result, expected,
       case when result = expected then 'PASS' else 'FAIL' end as status
  from _checks order by n;

rollback;
