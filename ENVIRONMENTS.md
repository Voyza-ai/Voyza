# Environments

How Voyza is deployed. (Set up 2026-06-16. Minimal-cost prod + dev.)

## Repository
- **GitHub:** `Voyza-ai/Voyza` (org repo). Local `origin` points here.

## Branches → environments

| Branch | Environment | Frontend (Vercel) | Backend | Database |
|---|---|---|---|---|
| `voyza_main` | **Production** | `voyza-nine.vercel.app` | Railway (`voyza-production.up.railway.app`) | Supabase `vzptwvrgiaqveckrdmke` |
| `dev` | **Development** | `voyza-dev.vercel.app` (preview) | **same** prod Railway | **same** prod Supabase |

> ⚠️ `dev` shares the production backend + database (this is the free, minimal-cost
> setup). It exists for **frontend iteration** — a separate URL to test UI changes —
> but writes still hit production data. For backend/DB-affecting work, run locally.

## Workflow

```
frontend change → commit to dev → push → auto-deploys to voyza-dev.vercel.app
               → test there → happy? → merge dev → voyza_main → ships to production
```

- Day-to-day frontend work happens on `dev`.
- Backend changes are deliberate: they only go live when `dev` is merged into
  `voyza_main` (the branch Railway + Vercel production deploy from).

## Vercel configuration
- **Production Branch:** `voyza_main`  *(Settings → Git)*
- **Domain `voyza-dev.vercel.app`** → assigned to the `dev` branch  *(Settings → Domains)*
- **Env vars** *(Settings → Environment Variables)*:
  - `NEXT_PUBLIC_API_URL` = `https://voyza-production.up.railway.app` — in **both**
    Production and Preview scopes (dev uses the prod backend)
  - `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` — both scopes

## Railway configuration
- `CORS_ORIGIN` must list every frontend origin that calls the backend:
  ```
  https://voyza-nine.vercel.app,https://voyza-dev.vercel.app,http://localhost:3000
  ```

## Supabase Auth — Google sign-in redirect URLs
Google OAuth **must** return the user to the SAME domain they started on, or the
PKCE session fails (the code-verifier is stored per-domain). Supabase honors the
app's `redirectTo` only if it matches the **Redirect URLs allowlist**; otherwise it
silently falls back to the **Site URL** (prod) — landing OAuth on the wrong domain,
so the user appears logged-out even though Supabase recorded the sign-in.

- **Site URL:** `https://voyza-nine.vercel.app/`
- **Redirect URLs allowlist** *(Authentication → URL Configuration)*:
  ```
  http://localhost:3000/**
  http://localhost:3001/**
  https://voyza-nine.vercel.app/**
  https://voyza-dev.vercel.app/**
  ```

> ⚠️ **Rule: every new environment (domain) must be added here**, or Google sign-in
> from it bounces to prod and fails to log in. Set it in the dashboard, or via the
> Management API:
> `PATCH https://api.supabase.com/v1/projects/vzptwvrgiaqveckrdmke/config/auth`
> with body `{"uri_allow_list": "<comma-separated urls>"}`.

## Local development
- Frontend: `cd frontend && npm run dev` (localhost:3000, falls back to 3001)
- Backend: `cd backend && npm run dev` (localhost:4000)
- `frontend/.env.local` sets `NEXT_PUBLIC_API_URL=http://localhost:4000` for local

## Upgrading to full isolation (later)
True dev/qa isolation (separate dev backend + dev database, so dev can't touch prod
data) needs a dedicated dev Railway service + a 2nd Supabase project (Supabase Pro
for >2 projects, ~$25/mo). Skip until there are real users to protect.
