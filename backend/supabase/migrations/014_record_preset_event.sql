-- ============================================================================
-- 014 — record_preset_event(): the Browse engagement counter RPC
-- ============================================================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → paste → Run),
-- or: supabase db push
--
-- Rehearse it first: paste ../dry-runs/013-014_preset_marketplace.dry-run.sql
-- and Run. It applies 013 + this file inside begin … rollback and probes
-- every behaviour below; every row of its Results table must say PASS, and
-- nothing is kept. Then run this file, then the Verify queries at the bottom.
--
-- WHY THIS FILE EXISTS. Two migrations were numbered 013. The catch-up
-- record 013_preset_marketplace.sql was written from the LIVE database and is
-- the record for the two tables, their indexes and RLS. The other,
-- 013_preset_trips.sql, re-declared those same tables (a duplicate, removed)
-- and was the ONLY place this function was defined. The function moves here,
-- on its own number, so nothing is defined twice.
--
-- PRODUCTION MOST LIKELY HAS IT ALREADY: preset_events held 36 rows on
-- 2026-10-26 and backend/src/services/presets.ts writes that table only
-- through this RPC. Nobody has read its live definition into the repo (it is
-- not in ../SCHEMA_SNAPSHOT.sql), so this file does not assume it matches.
--
-- SAFE ON PRODUCTION: every statement is idempotent and none replaces a live
-- object. The function is created only if no record_preset_event(text, text)
-- exists — deliberately NOT `create or replace`, which would silently
-- overwrite a live definition this repo has never seen (the same rule
-- 013_preset_marketplace.sql applies to its policy). The revokes only ever
-- remove access, and removing access already removed is a no-op. No row is
-- read or written.
-- ============================================================================

-- ── 1. The function ────────────────────────────────────────────────────────
-- Record one engagement event and bump the matching all-time counter on
-- preset_trips in the same statement. SECURITY DEFINER because preset_events
-- has RLS with no policies (service role only); search_path pinned so the
-- definer function can't be hijacked by a caller's search_path.
--
-- SAFE ON PRODUCTION: guarded by to_regprocedure — if a function with this
-- signature exists, nothing at all happens, whatever its body. The body is in
-- an EXECUTE so the guard can skip it.
do $do$
begin
  if to_regprocedure('public.record_preset_event(text, text)') is null then
    execute $create$
      create function public.record_preset_event(p_slug text, p_kind text)
      returns void
      language plpgsql security definer set search_path to 'public' as $fn$
      begin
        insert into public.preset_events (preset_slug, kind) values (p_slug, p_kind);
        if p_kind = 'impression' then
          update public.preset_trips set impression_count = impression_count + 1 where slug = p_slug;
        elsif p_kind = 'view' then
          update public.preset_trips set view_count = view_count + 1 where slug = p_slug;
        elsif p_kind = 'use' then
          update public.preset_trips set clone_count = clone_count + 1 where slug = p_slug;
        end if;
      end;
      $fn$
    $create$;
  end if;
end
$do$;

-- ── 2. Who may call it ─────────────────────────────────────────────────────
-- Only the service-role backend. Postgres grants EXECUTE to PUBLIC by
-- default and anon / authenticated inherit from PUBLIC, so revoking from
-- anon / authenticated alone would leave them able to call it through
-- /rest/v1/rpc/ — revoke from PUBLIC too (see ../security_fixes.sql). The
-- owner and service_role keep EXECUTE, so the backend's
-- supabase.rpc('record_preset_event') is unaffected.
--
-- SAFE ON PRODUCTION: a REVOKE only removes a privilege; revoking one that is
-- not held changes nothing. It cannot break the backend, which calls as
-- service_role. Without it, any visitor could inflate the Trending row.
revoke execute on function public.record_preset_event(text, text) from public;
revoke execute on function public.record_preset_event(text, text) from anon, authenticated;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- After running:
--
-- select pg_get_functiondef('public.record_preset_event(text, text)'::regprocedure);
--   -- the live body; if it differs from section 1, the live one was kept —
--   -- decide by hand, this file will not overwrite it
--
-- select grantee, privilege_type from information_schema.routine_privileges
--  where routine_schema = 'public' and routine_name = 'record_preset_event'
--  order by grantee;
--   -- postgres and service_role only — NOT anon, authenticated or PUBLIC
--
-- select has_function_privilege('anon', 'public.record_preset_event(text, text)', 'execute');
--   -- false

-- ============================================================================
-- REVERSAL
-- ============================================================================
-- Re-granting EXECUTE to anon / authenticated would reopen a public write
-- path onto the Trending counters; it is not a reversal anyone should want,
-- so it is not written here.
--
-- Dropping the function only reverses a FROM-SCRATCH build of this file.
-- On production the function most likely predates 014 (see the header), and
-- dropping it would silently stop all engagement recording — the backend
-- swallows the RPC error. Check pg_get_functiondef above first.
--
-- drop function if exists public.record_preset_event(text, text);
