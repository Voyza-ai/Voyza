# BlueMurr (Voyza)

AI multi-modal travel planner. `frontend/` is Next.js 14 (app router, Zustand,
Supabase, MapLibre GL, framer-motion); `backend/` is Express + TypeScript on a
Supabase service-role client.

## Branches

- Branch flow is **feature branch → `dev` → `voyza_main`** (production).
- **Never edit on `dev`.** Branch off it first, even for a one-line change.
  If you notice you are on `dev` with edits, stop and move them to a branch.
- There is ONE Supabase project. The database the dev app talks to is the same
  one holding real trips — there is no separate test instance.

## Working agreements

- **Manually test every change before asking to push**, and ask before
  committing and pushing. Do not commit unprompted.
- **Test the actual functionality**, not just that it compiles or that the
  structure looks right, before saying something works. Drive the real
  interaction in the state a user would hit, and measure it.
- **Say so when data gets edited** — any write, delete, or migration against
  the database, before it happens.
- **Do not work on mobile.** Narrow-screen layout is deferred by the owner.
- Production is a long way off. Keep advice scoped to dev/testing; don't raise
  deploys, prod keys, or launch readiness unasked.

## Database migrations

- SQL files live in `backend/supabase/migrations/`. House style is
  `backend/supabase/security_fixes.sql`: a header saying how to run it, a
  `SAFE ON PRODUCTION:` note per statement, and the reversal at the bottom.
- Before applying anything: run the behaviours it changes inside
  `begin; … rollback;`, then apply, then re-run the same checks live.
- A dry run that only exercises the happy path is not a test. For a uniqueness
  or constraint migration, probe the SECOND write and the stale-row case — and
  check the migration doesn't break the code currently on `dev`, since the
  database moves ahead of the merged branch.

## Design

- No "AI slop" — no glass morphism, no glows, no generic gradient-purple AI
  look. Derive from the existing product's own DNA: dark `#0f0f1a` AI
  surfaces, pastel city cards, the dashed-route motif, blue brand.
- Get design changes approved before committing them.

## Reporting

- Short, one-sentence bullets. The owner does not want long write-ups.
- Put **current open issues last**, in their own section, and list only what is
  still open — don't mix fixed things in where they read as outstanding.
- Lead with the direct answer when asked a direct question.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- Rebuild from scratch with: `brew install uv && uv tool install "graphifyy[sql]" && graphify update .`
