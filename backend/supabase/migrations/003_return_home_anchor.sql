-- Independent back-home anchor for trips.
--
-- The canvas home cards are editable per-direction: users can fly out of
-- one city/airport and return to a different one (open-jaw trips). The
-- outbound anchor lives in origin_city / origin_airports; these columns
-- hold the return-side overrides. NULL means "same as origin" — which is
-- every trip created before this migration, so no backfill is needed.
--
-- Run in the Supabase SQL editor (same as 001/002), or:
--   supabase db push

alter table trips add column if not exists return_city text;
alter table trips add column if not exists return_airports jsonb;
