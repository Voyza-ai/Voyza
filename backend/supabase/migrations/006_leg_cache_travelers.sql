-- Key the leg price cache on the party size.
--
-- Every price in this table is a PARTY TOTAL: Duffel quotes the whole
-- passenger set, and services/trains.ts now scales rail fares to match. But
-- the lookup in services/compareLeg.ts matched only on
-- (origin, destination, travel_date, mode), so a row written for a
-- 2-traveller party was handed verbatim to a 4-traveller one — the second
-- party silently inherited the first party's bill for that leg, for the two
-- hours the row stayed live.
--
-- Additive and idempotent. Deliberately NOT backfilled: existing rows have
-- no recorded party size, so any value we invented would be a guess at whose
-- bill they are. They become unreachable by the new lookup and are deleted
-- below — this is a cache with a 2-hour TTL, so there is nothing to keep.
--
-- Run in the Supabase SQL editor (same as 001/002), or:
--   supabase db push

alter table leg_price_cache add column if not exists travelers integer;

-- Pre-migration rows: no party size recorded, so unusable. Pure cache, no
-- user data — repopulates on the next search.
delete from leg_price_cache where travelers is null;

-- The lookup index has to carry travelers now that it's part of the key.
create index if not exists idx_leg_cache_lookup_travelers
  on leg_price_cache(origin, destination, travel_date, mode, travelers);
drop index if exists idx_leg_cache_lookup;
