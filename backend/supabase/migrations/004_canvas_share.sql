-- 004: trip-level share link for the canvas
--
-- One share link per trip (backed by its canvas session), with an
-- owner-selected access mode. Joining via the link auto-creates a
-- group_members row at the mode's role:
--   view    → viewer     (watch live, change nothing)
--   suggest → suggester  (edit locally, owner approves via suggestions)
--   edit    → editor     (full live editing)
-- The token is rotatable: regenerating it invalidates previously
-- shared links without touching existing memberships.

alter table public.canvas_sessions
  add column if not exists share_mode text not null default 'view'
    constraint canvas_sessions_share_mode_check
    check (share_mode in ('view', 'suggest', 'edit')),
  add column if not exists share_token uuid not null default gen_random_uuid();

create index if not exists canvas_sessions_share_token_idx
  on public.canvas_sessions (share_token);
