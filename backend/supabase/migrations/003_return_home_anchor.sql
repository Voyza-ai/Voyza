-- Independent back-home anchor for trips.
--
-- The canvas home cards are editable per-direction: users can fly out of
-- one city/airport and return to a different one (open-jaw trips). The
-- outbound anchor lives in origin_city / origin_airports; these columns
-- hold the return-side overrides. NULL means "same as origin" — which is
-- every trip created before this migration, so no backfill is needed.
--
-- APPLIED, by hand in the Supabase SQL editor. trips.return_city and
-- trips.return_airports were both confirmed present on 2026-10-26. Because it
-- was run by hand it is NOT in the migration ledger
-- (supabase_migrations.schema_migrations), so `supabase db push` has no record
-- of it. (The ledger's add_trip_origin_anchor is a different, earlier
-- migration: it added origin_city / origin_airports, not the return-side
-- columns.)
--
-- Run in the Supabase SQL editor (same as 001/002), or:
--   supabase db push

alter table trips add column if not exists return_city text;
alter table trips add column if not exists return_airports jsonb;
