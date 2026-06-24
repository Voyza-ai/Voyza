-- ============================================================================
-- Voyza — Security hardening
-- ============================================================================
-- Run this in the Supabase SQL editor (Dashboard → SQL Editor → paste → Run).
-- Addresses the advisor findings from 2026-06-16.
--
-- SAFE ON PRODUCTION: revoking EXECUTE does NOT break anything — triggers and
-- pg_cron run the functions as their owner, not via a caller's EXECUTE grant.
-- (The on_auth_user_created trigger keeps firing; the daily anonymize cron
--  keeps working. We're only removing the ability to call them from the
--  public REST API.)
-- ============================================================================

-- 1) SECURITY DEFINER functions must not be callable from the public API.
--    anonymize_expired_deletions() wipes user PII + deletes OAuth identities —
--    it being anon-callable via /rest/v1/rpc/ is the critical fix here.
--    NOTE: Postgres grants function EXECUTE to PUBLIC by default, and anon /
--    authenticated INHERIT from PUBLIC. Revoking only from anon/authenticated
--    leaves the PUBLIC grant intact (they still have access). Revoke from
--    PUBLIC. Owner (postgres) + service_role keep EXECUTE, so the trigger and
--    the pg_cron anonymize job keep working.
revoke execute on function public.anonymize_expired_deletions() from public;
revoke execute on function public.handle_new_user()             from public;
revoke execute on function public.rls_auto_enable()             from public;

-- 2) Pin search_path on the SECURITY DEFINER trigger function (stops a
--    search_path-hijack attack). Its body uses fully-qualified names, so an
--    empty search_path is both safe and the strongest setting.
alter function public.handle_new_user() set search_path = '';

-- 3) Verify (optional) — after running, this should list ONLY postgres and
--    service_role (NOT anon, authenticated, or PUBLIC):
-- select routine_name, grantee, privilege_type
--   from information_schema.routine_privileges
--  where specific_schema = 'public'
--    and routine_name in ('anonymize_expired_deletions','handle_new_user','rls_auto_enable')
--  order by routine_name, grantee;
--
-- APPLIED + VERIFIED via MCP on 2026-06-16: grants now postgres + service_role only.
