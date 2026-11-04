-- ============================================================================
-- 015: In-app flight bookings (Duffel Orders + Duffel Payments)
-- ============================================================================
-- NOT APPLIED. Run by hand in the Supabase SQL editor (Dashboard → SQL
-- Editor → paste → Run), after first running the rehearsal
-- supabase/dry-runs/015_bookings.dry-run.sql (which changes nothing and must
-- report PASS on every row).
--
-- Until this is applied the backend still books: services/bookingStore.ts
-- detects the missing table, logs "bookings table missing — booking
-- persistence DISABLED" once, and keeps bookings in process memory (lost on
-- restart). Nothing currently on `dev` reads or writes public.bookings, so
-- applying this ahead of the branch merge changes no existing behaviour.
--
-- What is stored: Duffel ids, status, amounts, and a passengers SUMMARY
-- (names + passenger type). Never dates of birth, passport numbers, phone
-- numbers or card data — Duffel keeps the full order, re-read by order id.
--
-- Access: owners may SELECT their own rows. There are deliberately NO
-- insert / update / delete policies: only the service-role backend writes.
-- ============================================================================

-- 1) Table.
-- SAFE ON PRODUCTION: creates a new, empty table; touches no existing table.
-- `if not exists` makes a second run a no-op. trip_id is ON DELETE SET NULL
-- so deleting a trip never deletes the record of money taken for it.
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
  -- A confirmed booking always has its Duffel order.
  constraint bookings_confirmed_has_order
    check (status <> 'confirmed' or duffel_order_id is not null)
);

-- 2) Index for "my bookings, newest first".
-- SAFE ON PRODUCTION: index on the new (empty) table only.
create index if not exists bookings_user_created_idx
  on public.bookings (user_id, created_at desc);

-- 3) RLS: owner-only read; writes only via the service role (which bypasses
-- RLS). The rls_auto_enable event trigger would enable RLS anyway; declared
-- explicitly for intent.
-- SAFE ON PRODUCTION: affects only the new table.
alter table public.bookings enable row level security;

-- SAFE ON PRODUCTION: a SELECT policy on the new table only. Guarded so a
-- second run does not fail on "policy already exists".
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'bookings' and policyname = 'bookings_owner_select'
  ) then
    create policy "bookings_owner_select" on public.bookings
      for select using (auth.uid() = user_id);
  end if;
end $$;

-- 4) Belt and braces: the browser roles may only ever read.
-- SAFE ON PRODUCTION: revokes write privileges on the new table only; the
-- backend writes as service_role, which keeps all privileges.
revoke insert, update, delete, truncate on public.bookings from anon, authenticated;

-- ============================================================================
-- Verify (optional):
--   select policyname, cmd from pg_policies where tablename = 'bookings';
--     → exactly one row: bookings_owner_select | SELECT
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name = 'bookings' and grantee in ('anon','authenticated');
--     → SELECT only (plus REFERENCES/TRIGGER defaults), no INSERT/UPDATE/DELETE
-- ============================================================================

-- ============================================================================
-- REVERSAL (run only to undo; deletes every booking record — Duffel still
-- holds the orders, but the link between user and order is lost):
--
--   drop policy if exists "bookings_owner_select" on public.bookings;
--   drop table if exists public.bookings;
-- ============================================================================
