-- Allow 'edit' as a canvas_suggestions.type.
--
-- The app submits suggestions of type 'edit' for the "owner confirms edits"
-- flow (see backend/src/routes/canvas.ts — the suggestion schema accepts
-- add_city | comment | reaction | edit), but the original check constraint
-- only permitted add_city/comment/reaction. Every proposed edit therefore
-- failed with a 400 ("violates check constraint canvas_suggestions_type_check")
-- and the "propose changes" feature was broken in production.
--
-- This was hotfixed directly on the prod database during the incident; this
-- migration records it so the schema is reproducible from source. Purely
-- additive (widens the allowed set) and idempotent.
ALTER TABLE public.canvas_suggestions
  DROP CONSTRAINT IF EXISTS canvas_suggestions_type_check;

ALTER TABLE public.canvas_suggestions
  ADD CONSTRAINT canvas_suggestions_type_check
  CHECK (type = ANY (ARRAY['add_city'::text, 'comment'::text, 'reaction'::text, 'edit'::text]));
