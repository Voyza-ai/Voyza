-- 007 — leg_price_cache: one row per (leg, mode, party size), and drop expired ballast.
--
-- Depends on 006_leg_cache_travelers.sql: `travelers` is part of the cache
-- key (every cached price is a party total), so it is part of this key too.
--
-- ⚠️  NOT APPLIED. Review before running. Steps 1 and 2 DELETE rows from
--     leg_price_cache. That table is a pure price cache — 2h TTL, service-role
--     only (RLS policy leg_cache_service_only), rebuilt on the next search —
--     so no user data lives in it, but the delete is real and is deliberately
--     left for a human to run.
--
-- Why this exists: compareLeg writes leg_price_cache with `insert`, never
-- `upsert`, because the table has no unique key to conflict on (001 only
-- created the NON-unique idx_leg_cache_lookup). Every repeat search of the
-- same leg inside the 2h window therefore left another flight+train pair
-- behind, and the unordered `.limit(2)` read could then miss one mode
-- entirely. The code fix (compareLeg.ts) reads the NEWEST row per mode and
-- prunes superseded rows after each insert, so duplicates are no longer a
-- correctness problem and growth is bounded. This migration finishes the
-- job at the schema level: it removes the duplicates that already
-- accumulated and enforces the key, which is what makes the simpler
-- `upsert(..., { onConflict: 'origin,destination,travel_date,mode,travelers' })`
-- write possible.
--
-- Order matters: dedupe BEFORE creating the unique index, or step 3 fails
-- on the existing duplicates.

-- 1. Expired rows are never read (every lookup filters expires_at >= now())
--    and nothing has ever deleted them. Pure ballast.
delete from public.leg_price_cache
where expires_at is null or expires_at < now();

-- 2. Collapse duplicates, keeping the freshest row per (leg, mode). The
--    (fetched_at, id) tuple breaks ties between rows written in the same
--    millisecond so exactly one survivor remains per key.
delete from public.leg_price_cache c
using public.leg_price_cache newer
where c.origin      = newer.origin
  and c.destination = newer.destination
  and c.travel_date = newer.travel_date
  and c.mode        = newer.mode
  and c.travelers   is not distinct from newer.travelers
  and (c.fetched_at, c.id) < (newer.fetched_at, newer.id);

-- 3. Now the key is unique — enforce it so `upsert` has something to
--    conflict on. Same column prefix as the lookup, so reads stay indexed.
create unique index if not exists leg_price_cache_leg_mode_key
  on public.leg_price_cache (origin, destination, travel_date, mode, travelers);

-- 4. The old non-unique lookup index is now fully redundant (identical
--    column list). Safe to drop; harmless if the live DB no longer has it
--    (SCHEMA_SNAPSHOT.sql does not capture indexes, and the live
--    "index_cleanup_and_member_lookups" migration is not in this repo).
drop index if exists public.idx_leg_cache_lookup;

-- ── After applying ──────────────────────────────────────────────────────────
-- compareLeg.ts can then replace its insert + supersede-prune with a single
-- upsert. Do NOT make that code change before this migration is applied:
-- Postgres rejects ON CONFLICT without a matching unique index (42P10),
-- supabase-js reports it in `error` rather than throwing, and the cache
-- would silently stop being written.
--
--   await supabase
--     .from('leg_price_cache')
--     .upsert(cacheRows, { onConflict: 'origin,destination,travel_date,mode' });
--
-- Optional: expired rows still accumulate slowly across days (one row per
-- distinct leg+date+mode ever searched). If pg_cron is enabled on the
-- project (SCHEMA_SNAPSHOT.sql says anonymize_expired_deletions is
-- pg_cron-driven), a nightly reaper keeps the table small:
--
--   select cron.schedule(
--     'reap_leg_price_cache', '17 3 * * *',
--     $$ delete from public.leg_price_cache where expires_at < now() - interval '1 day' $$
--   );
