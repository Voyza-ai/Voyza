# Voyza / BlueMurr — database ER reference

Verified against the live Supabase project and this repo on **2026-10-26**.
Written to be imported into a diagramming tool (Lucidchart accepts Mermaid) and
to settle the questions a diagram of this schema keeps running into.

## Read this first

**There is exactly ONE database.** A single Supabase Postgres project, shared by
dev and production. There is no separate test instance — the dev app talks to
the same database that holds real trips.

**No single file in this repo describes it.** Three sources, all partial:

| Source | What it is | Caveat |
|---|---|---|
| `migrations/001`–`013` | the ordered migrations | three tables were never captured here |
| `SCHEMA_SNAPSHOT.sql` | a read of the live DB | taken **2026-06-16**, has drifted since |
| the live database | the truth | only reachable with credentials |

**Three tables have no migration file of their own:**

- `user_profiles` — live, **used by application code**, created via Supabase auth
  wiring (`handle_new_user` trigger). No migration anywhere.
- `preset_trips`, `preset_events` — live with data, captured only by `013`
  (added 2026-10-26 by PR #28, as a catch-up record of what already existed).

**One table that looks real and is not:** `trips_allow_clones_backup_007`
appears in `009` only inside a commented-out backfill block that was
deliberately never run. It does not exist. Do not diagram it.

**`preset_trips` and `preset_events` are live but unreferenced.** They hold 20
and 36 rows respectively, and *nothing in the codebase reads or writes either
one* — `grep` across `backend/src` and `frontend` returns nothing. The Browse
tab reads a static TypeScript catalog at `frontend/data/presetItineraries`.
They belong in a diagram of the **database**; they do not belong in a diagram of
what the **backend uses**.

## Entity relationships

```mermaid
erDiagram
    auth_users ||--o{ trips : owns
    auth_users ||--|| user_profiles : has
    auth_users ||--o{ group_members : "is"
    trips ||--o{ cities : contains
    trips ||--o{ transports : contains
    trips ||--o{ group_members : "shared with"
    trips ||--o{ canvas_sessions : has
    trips ||--o{ canvas_suggestions : has
    trips ||--o{ trips : "cloned from"
    cities ||--o{ transports : "from/to"
    preset_trips ||--o{ preset_events : logs

    auth_users {
        uuid id PK "Supabase auth schema"
    }
    user_profiles {
        uuid id PK_FK "references auth.users, cascade"
        jsonb preferences
    }
    trips {
        uuid id PK
        uuid user_id FK "auth.users"
        uuid cloned_from_trip_id FK "self, set null"
        text title
        text status
        int travelers
        numeric total_cost
        numeric budget
        bool allow_clones "default false since 009"
        bool is_public
        text origin_city
        jsonb origin_airports
        jsonb outbound_leg
        jsonb return_leg
        text return_city "003, hand-applied"
        jsonb return_airports "003, hand-applied"
    }
    cities {
        uuid id PK
        uuid trip_id FK "cascade"
        text name
        jsonb hotels
        jsonb vibes
    }
    transports {
        uuid id PK
        uuid trip_id FK "cascade"
        uuid from_city_id FK
        uuid to_city_id FK
    }
    group_members {
        uuid id PK
        uuid trip_id FK "cascade"
        uuid user_id FK "auth.users"
        text role "default viewer"
    }
    canvas_sessions {
        uuid id PK
        uuid trip_id FK "cascade"
        uuid last_saved_by FK
        text share_mode "004"
        text share_token "004"
    }
    canvas_suggestions {
        uuid id PK
        uuid trip_id FK "cascade"
        uuid suggested_by FK
        text type "add_city|comment|reaction|edit (005)"
        text status
    }
    notifications {
        uuid id PK "012, hand-applied"
    }
    preset_trips {
        text slug PK
        jsonb data
        text status "draft|published"
        text region
        text duration_bucket
        text budget_tier
        int nights
        numeric est_cost
        text_array categories "GIN indexed"
        text_array vibes "NOT indexed"
    }
    preset_events {
        bigint id PK "generated always as identity"
        text preset_slug FK "preset_trips, cascade"
        text kind "impression|view|use"
    }
    airport_codes {
        text iata PK
    }
    booking_locations {
        text id PK
    }
    db_stops {
        text id PK
    }
    leg_price_cache {
        uuid id PK
        int travelers "006, part of the cache key"
    }
```

## Standalone tables (no foreign keys)

`airport_codes`, `booking_locations`, `db_stops`, `leg_price_cache` are
service-role-only caches and lookups. Each has an RLS policy of
`using (false)`, so no client reaches them at all.

## Row Level Security

| Table | Policy shape |
|---|---|
| `trips` | owner-all via `auth.uid() = user_id`; group edit carries a `WITH CHECK` (008) plus the `trips_owner_columns_guard` trigger |
| `group_members` | `group_members_owner_all` calls `is_trip_owner()` (011) — rewritten to break a policy recursion cycle with `trips` |
| `preset_trips` | one policy: public read where `status = 'published'`. Writes are service-role only |
| `preset_events` | **RLS enabled, ZERO policies** — denies all anon/authenticated access. Deliberate; do not "fix" it |
| caches above | `using (false)` — service role only |

On `preset_events`, the table-level grants show anon holding
INSERT/SELECT/UPDATE/DELETE. Those come from Supabase's
`alter default privileges` on schema `public`, not from any migration, and are
inert — RLS is what actually gates access.

## Migration ledger

`supabase_migrations.schema_migrations` holds 21 rows and does **not** record
`003`, `012` or `013`: all three were applied by hand in the SQL editor. A
`supabase db push` therefore has no record of them. Reconciling that is a
`supabase migration repair` decision.

## Known drift in `SCHEMA_SNAPSHOT.sql`

Everything outside the preset tables is still the 2026-06-16 read. Since then:

- `trips` gained `return_city` / `return_airports` (003)
- `trips_group_edit` gained a `WITH CHECK`, `trips` gained the
  `trips_owner_columns_guard` trigger (008)
- `trips.allow_clones` now defaults `false` (009)
- `group_members_owner_all` now calls `is_trip_owner()` (011)
- `notifications`, `get_user_id_by_email()` and a rewritten
  `anonymize_expired_deletions()` exist (012)
