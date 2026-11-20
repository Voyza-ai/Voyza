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

- **Manually test every change before pushing.** Commit freely on feature
  branches, no need to ask. Push a feature branch without asking too —
  except when the unpushed work spans 3 or more of the owner's requests;
  then ask first. Never push to or merge into `dev` or `voyza_main` without
  asking.
- **Test the actual functionality**, not just that it compiles or that the
  structure looks right, before saying something works. Drive the real
  interaction in the state a user would hit, and measure it.
- **Say so when data gets edited** — any write, delete, or migration against
  the database, before it happens.
- **Do not work on mobile.** Narrow-screen layout is deferred by the owner.
- Production is a long way off. Keep advice scoped to dev/testing; don't raise
  deploys, prod keys, or launch readiness unasked.

## Testing in the browser

- **Don't build test trips through the planning chat** — every run spends
  API credits (Booking, flights, AI). Load a saved trip or a Browse preset
  into the results page instead (sessionStorage key `bluemurr-current-trip`),
  which gives the same flowchart. Use the planning chat only when testing
  planning-chat changes.
- Block writes while testing: route-intercept non-GET calls to `*.supabase.co`
  and to `/api/(trips|canvas|users|bookings|email|notifications)`.

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
- Get design changes approved before merging them into `dev`; show screenshots or a video while they are on the feature branch.
- **Look at it as a user first, then build it as an engineer.** Before
  showing or pushing any visual change, screenshot it in the real app at the
  owner's size (1440×900) and check it the way a traveller would: overlapping
  labels or markers, text cut off or truncated, things clipped at an edge,
  lists squeezed to a sliver. Fix what you find, then send the screenshots
  without being asked.

## Reporting

- Short, one-sentence bullets. The owner does not want long write-ups.
- Put **current open issues last**, in their own section, and list only what is
  still open — don't mix fixed things in where they read as outstanding.
- Lead with the direct answer when asked a direct question.

## graphify (optional)

graphify can build a knowledge graph of the repo into `graphify-out/`
(gitignored). It is **optional** — use grep/ripgrep for finding code. Measured
here, `graphify query` missed `countryGroupedOrderings` in
`backend/src/services/optimizer.ts` that a one-line grep found, and it
truncates results at a token budget.

- If you do use it: `graphify query "<question>"`, `graphify path "<A>" "<B>"`,
  `graphify explain "<concept>"`; `graphify-out/GRAPH_REPORT.md` for a broad
  architecture overview.
- Build or refresh with: `brew install uv && uv tool install "graphifyy[sql]" && graphify update .`
