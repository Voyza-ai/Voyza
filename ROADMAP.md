# Voyza Roadmap & Feature Checklist

Living checklist of everything we want to build, organized by feature.
Update as we go — tick boxes, move items between sections, add new ideas.

Legend: `[x]` done · `[~]` in progress · `[ ]` not started · `[?]` open question

---

## ✅ Done (shipped to `claude_code_backend`)

### Planning flow & AI
- [x] AI-driven intent parsing (Claude) — `/api/plan/interpret`
- [x] Early city picker — appears as soon as user types a country, not at end
- [x] "Type another city" input in picker
- [x] Sequential country picker for mixed city+country inputs
- [x] Vague-input fallback via `suggestDestinations`
- [x] Skip-answered-steps — AI extracts budget/vibe/travelers, skip those questions
- [x] Travelers-ambiguity flag ("traveling with 3 people" → confirm 3 or 4?)
- [x] Budget per-person vs total clarification
- [x] Freeform date parsing ("next week", "summer", "in 2 weeks" → YYYY-MM-DD)
- [x] Activities AI curation — `/api/plan/activities`
- [x] Restaurants AI curation — `/api/plan/restaurants`
- [x] Cursor-based calendar scheduling (no event overlaps)

### Optimizer
- [x] Brute-force permutations ≤5 cities, nearest-neighbor heuristic >5
- [x] Country-clustering (prevents Japan→China→Japan→China routing)
- [x] Sequential per-leg dates
- [x] Date-shift probe (±1/±2 day offsets to save money)
- [x] Past-date clamping
- [x] Static train tables (Japan/Korea/China/Taiwan/India)
- [x] Expanded DB REST rail-coverage country list (Europe)

### Pricing & data
- [x] Currency conversion — all flights/hotels/trains → USD
- [x] Hotel 429 rate-limit retry + concurrency cap
- [x] Budget-over warning banner on results
- [x] Date-shift savings banner
- [x] Book button real URLs (Google Flights deep-links)

### Auth
- [x] Supabase email/password login
- [x] Google OAuth provider configured in Supabase

---

## 🚧 In-flight (this branch: `feat/voyza-ai-chat`)

All major work on this branch is committed and pushed. See the
"Previously shipped" section below for the full breakdown. Branch
currently has 4 commits, not yet merged to `claude_code_backend`:

```
d4007d9  polish: fixed-size transport pills + home card refinements
984a553  feat: home anchor — origin, multi-airport, full permutations, round-trip
1704365  feat: AI chat refreshes flowchart transport card (leg_refresh)
0fbbd20  feat: Voyza AI chat with trip-aware prompts + constraint proposals
```

Remaining on the branch:
- [ ] Top-4 options per between-city leg (swap `compareLeg()` →
  `searchLegOptions(limit: 4)` in `scoreRoute`). Home legs already
  use searchLegOptions; this extends it to inter-city legs so every
  Connector card has 4 alternatives out of the box.
- [ ] Backfill UI for pre-home-anchor trips without `origin_city`
  (old trips render without a home card — graceful but unsettable).

---

## 📦 Previously shipped (ordered recent → older)

### Voyza AI chat + home anchor (on `feat/voyza-ai-chat`, not yet merged)

Voyza AI chat v1 — constraint proposals (0fbbd20)
- [x] Schema: `trips.constraints` jsonb
- [x] `POST /api/plan/chat` with Claude tool-use (answer_only, pin_city_dates, set_min_days, set_transport_window)
- [x] `POST /api/plan/chat-suggestions` — trip-specific dynamic prompts
- [x] `services/constraints.ts` — `applyDateConstraints` + `mergeConstraints`
- [x] `AIChatPanel` rebuild: multi-turn history, date-shift proposal cards, Accept/Reject
- [x] 129/129 frontend tests pass

Leg options — card-refresh pattern (1704365)
- [x] `services/legOptions.ts` — `searchLegOptions(window?, limit)` with HH:MM filter + multi-origin fan-out
- [x] `show_transport_options` tool (no window — just show alternatives)
- [x] Clarifying-question flow for ambiguous multi-leg queries ("which leg — Venice→Rome or Rome→Florence?")
- [x] Chat `leg_refresh` response — updates the flowchart's Connector alternatives directly, no inline card in chat
- [x] `Trip.constraints` type on frontend

Home anchor / origin model (984a553 + d4007d9)
- [x] Schema: `trips.origin_city`, `trips.origin_airports jsonb`, `trips.return_to_home bool`, `trips.outbound_leg jsonb`, `trips.return_leg jsonb`
- [x] Planning flow: "Where are you flying from?" + "One-way or round-trip?" steps across all three paths (place/vibe/budget)
- [x] Chat-mode `/api/plan/interpret` extracts `origin` + `returnToHome` from one-shot natural input
- [x] `buildRemainingSteps` asks origin + roundtrip if AI missed them
- [x] Optimizer tests FULL destination permutations when origin is set (no more fixed-first hack)
- [x] `searchHomeFlights` bidirectional multi-airport search (home airport fan-out for outbound, destination airport fan-out for return)
- [x] Perf: estimate pass uses 1 airport; full fan-out only for winner's `buildHomeLeg`
- [x] Multi-airport lookup: top-3 airports for ~55 metros (NYC, London, Tokyo, etc.)
- [x] HomeCard + HomeLegPill via Connector reuse — identical styling to between-city pills
- [x] Alignment: HomeCard + Connector share one `flex items-stretch` motion.div; parent row uses items-stretch
- [x] `airportNames.ts` — IATA → human-readable airport lookup
- [x] Fixed-size transport pills (120×64) with placeholder rows so every Connector is dimensionally uniform
- [x] Trip persistence: origin_city, origin_airports, return_to_home, outbound_leg, return_leg all survive save/reload
- [x] Graceful degradation: trips without origin render unchanged

### DB persistence (merged in PR #1)
- [x] Schema migration: `trips` (+5 cols), `cities` (+4), `transports` (+10)
- [x] Fix `duration_minutes` bug (`parseInt("3h 37m") = 3` → proper parser)
- [x] POST `/api/trips` writes all new columns
- [x] GET `/api/trips/:id` returns complete Trip shape via `buildTripFromDb()`
- [x] Results page trusts Zustand when `currentTrip.id` matches URL `tripId`
- [x] URL updates via `history.replaceState` after save
- [x] Canvas save handler fixed (same duration bug)
- [x] Google OAuth frontend wiring (button in LoginModal, callback page)

### User CRUD — core
- [x] GET `/api/users/me` — profile + email + preferences
- [x] PATCH `/api/users/me` — partial update with preferences merge
- [x] PATCH `/api/trips/:id` — rename, update budget/vibe/status
- [x] GET `/api/canvas/:tripId/members` — list collaborators
- [x] PATCH `/api/canvas/:tripId/members/:memberId` — change role
- [x] DELETE `/api/canvas/:tripId/members/:memberId` — remove / self-leave
- [x] Safety rails: can't demote owner, owner can't leave own trip

### Account lifecycle (this session's work)
- [x] Migration: `user_profiles.deleted_at`, `anonymized_at`, `deletion_reason`
- [x] Migration: `trips.cloned_from_trip_id`, `trips.allow_clones`, `trips.allow_recommendations`, `trips.is_public`, `trips.clone_count`
- [x] SQL function `anonymize_expired_deletions()` + pg_cron daily schedule
- [x] Soft-delete `DELETE /api/users/me` (replaces current hard delete)
- [x] `POST /api/users/me/cancel-deletion`
- [x] `GET /api/users/me` returns `accountStatus` + `scheduledDeletionAt`
- [x] `POST /api/trips/:id/clone` with selective-copy body
- [x] `POST /api/trips/:id/transfer-ownership`
- [x] `PATCH /api/trips/:id/permissions` (allow_clones, allow_recommendations, is_public)
- [x] `GET /api/users/me/export` — GDPR JSON download of all their data

---

## 📋 Backlog

### Feature: Notifications system (separate task — complex)
- [ ] `notifications` table with RLS
- [ ] GET/PATCH/DELETE endpoints
- [ ] Notification bell icon in navbar (frontend)
- [ ] Dropdown with unread count + list
- [ ] Mark-all-read action
- [ ] Notification triggers wired into:
  - [ ] Account deletion requested (self-notification with grace period info)
  - [ ] Trip owner anonymized → notify collaborators with clone action
  - [ ] Ownership transferred
  - [ ] Canvas suggestion approved/rejected
  - [ ] Canvas invite received
- [ ] Notification preferences in `user_profiles.preferences`

### Feature: Email transport (separate task)
- [ ] Integrate Resend or SendGrid
- [ ] Transactional email templates:
  - [ ] Account deletion requested confirmation ("your account will be deleted on X")
  - [ ] Grace period reminder (day 23 of 30)
  - [ ] Canvas invite (currently links are copy-paste)
  - [ ] Notification digest (weekly optional)
- [ ] Email preferences in `user_profiles.preferences`
- [ ] Unsubscribe link handling

### Feature: Popular trips / trip discovery
Note: this is the older "discover real user trips that opted into
recommendations" feature. Partially superseded by the new "Browse /
preset trips" feature below, which uses *pre-generated* preset trips
as the primary discovery surface (with the old "clone this real
trip" flow as a bonus row).

- [ ] New page: `/explore` or `/popular`
- [ ] Backend: `GET /api/trips/popular` with filters (vibe, budget, cities)
  - Query: `trips WHERE allow_recommendations = TRUE ORDER BY clone_count DESC`
- [ ] Clone count stored per trip (incremented on clone)
- [ ] Tagging / vibe browsing
- [ ] "Trending this week" ranking

### Feature: Browse / preset trips (3 phases)

The browse surface is where users who don't know what they want land
first. Unlike the user-generated "Popular" trips above, this is a
curated catalog of AI-generated preset trips with hero imagery,
category-level landing pages, and a one-click "Plan a similar trip"
handoff that re-runs live pricing on the current day.

Goal: be the first page a new user sees — browsable inspiration
without having to type anything — AND be the SEO surface that ranks
for long-tail queries like "adventure trips from NYC under $1500".

**Phase 1 — Decide & design (blocks everything else)**
- [ ] **Taxonomy**: lock the final list of vibes (beach, adventure, culture, romance, family, food+wine, etc.), budget tiers ($, $$, $$$, $$$$), duration buckets (weekend, 1 wk, 2 wk, month), origin regions (US-East, US-West, Europe, Asia). Decide combinatorially how many category pages we support vs. dynamic filters
- [ ] **Page structure decision**: input-at-top-of-home with browse rows below, OR separate `/browse` page linked from nav. Affects how much the landing page has to do on first paint
- [ ] **DB schema**: `preset_trips` table — inputs (vibe/budget/duration/origin-region), generated trip JSON, category tag(s), `created_at`, `refresh_status`, `hero_image_url`, `clone_count`, `impression_count`, `view_count`
- [ ] **Editorial + SEO strategy**: which categories get dedicated landing pages (`/adventure-trips-from-nyc`), category description copy style, trending-row heuristic (last-7-day impressions? clicks? handoff rate?), staff-pick criteria
- [ ] **SEO plan**: URL shape for category pages, meta tag strategy, sitemap entry, schema.org TravelAction markup

**Phase 2 — Generation pipeline**
- [ ] **Bulk-generation prompt**: single Claude prompt that takes taxonomy inputs and produces a realistic trip (cities + activities + restaurants + budget estimate). Batch-run across all taxonomy combinations to seed the catalog
- [ ] **Refresh job**: weekly cron to regenerate pricing on all preset trips (flights/hotels go stale). Separately update a "trending" row from real user impressions + click-through
- [ ] **Hero image sourcing**: either stock photos keyed by first city, or a separate image-generation pass (decide in Phase 1)

**Phase 3 — User-facing UI**
- [ ] **Preset trip card**: hero image, title, price range, duration, mini-flowchart preview (just the city sequence, no flight detail), category badge
- [ ] **Browse row layout**: horizontal scroll by category ("Adventure trips from NYC", "Romance in Europe", "Culture under $2k"), matching the landing-page structure decision
- [ ] **"Plan a similar trip" handoff**: preset click pre-fills planner answers (origin, destinations, dates, vibe, budget) and immediately runs a fresh `/api/optimize` call with today's prices. User can tweak before saving
- [ ] **Editorial surfaces**: staff-picks row, trending-this-week row, category landing pages with editorial copy
- [ ] **SEO implementation**: server-rendered category pages, sitemap generation, canonical URLs, rich snippet markup

### Feature: Settings page
- [ ] `/settings` route
- [ ] Profile tab (name, avatar, preferences)
- [ ] Account tab (change password, change email via Supabase, delete account with 2-step email confirm)
- [ ] Notifications tab (preferences)
- [ ] Privacy tab (allow trips to be used for recommendations toggle — global default)
- [ ] Data export button (calls `/api/users/me/export`)

### Feature: Intra-city geographic scheduling
- [ ] POI API integration (Google Places or Foursquare) for real coordinates
- [ ] Update activities/restaurants to include `{ lat, lng, placeId }`
- [ ] Geo-aware day scheduler: morning activity → nearest lunch spot → nearest afternoon activity
- [ ] Optional: integrate Distance Matrix for walking/transit time between slots

### Feature: In-app booking
- [ ] Duffel Orders API integration
- [ ] Passenger info form (name, DOB, gender, passport, contact)
- [ ] Payment flow (Duffel Payments or Stripe with Duffel marketplace)
- [ ] Airline T&Cs acceptance per booking
- [ ] Seller-of-travel compliance research (varies by US state, UK ATOL, etc.)
- [ ] Booking confirmation email + itinerary PDF

### Feature: Voyza AI — edits beyond current scope
Tasks deferred from the current chat work:

- [ ] **Planning-phase conversational revision** (task 4): during the planning flow, the user can type "actually Venice not Venezuela" and AI updates destinations without losing prior answers (dates/budget/vibe). New endpoint `/api/plan/revise-destinations` with Claude tools: `add_destination`, `remove_destination`, `replace_destination`, `answer_only`.
- [ ] **Post-results add/remove/replace cities** (task 5): new tools on `/api/plan/chat` — `add_city(city, afterCity?)`, `remove_city(city)`, `replace_city(old, new)`. Backend rebuilds trip with new city's hotel + transports. Shows diff card for Accept/Reject.

### Feature: Ownership transfer UX
- [ ] Frontend flow: owner picks a collaborator (or invites one) to transfer to
- [ ] "Are you sure?" confirm
- [ ] After transfer, former owner becomes editor (or leaves)
- [ ] Notification to new owner

### Feature: Clone UX
- [ ] "Clone this trip" button visible on all results pages (respecting `allow_clones`)
- [ ] Clone dialog with checkboxes: cities, hotels, activities, restaurants, schedule
- [ ] Shareable trip links (read-only) for any `is_public = TRUE` trip
- [ ] Clone count shown as a social signal ("100 travelers cloned this")

### Feature: Admin UI
- [ ] `/admin` route (auth-gated to specific user_ids)
- [ ] View all trips, users, canvas sessions
- [ ] Manual anonymize / purge
- [ ] Trigger `anonymize_expired_deletions()` on demand
- [ ] Inspect orphaned trips / abandoned canvas sessions

### Feature: Stripe subscriptions
- [ ] Stripe account setup
- [ ] Pricing page
- [ ] Subscription webhook handler
- [ ] Gate premium features (higher activity counts? offline export?)
- [ ] Cancel subscription on account deletion

### Feature: Real regional train APIs
- [ ] Replace static Japan table with real-time JR data (Navitime partner API)
- [ ] Korail integration for Korea
- [ ] 12306 / Ctrip partner integration for China
- [ ] UK Darwin API (National Rail)
- [ ] Amtrak (US) via third-party scraper or Rome2Rio

### Feature: LCC flight coverage gap
- [ ] Add Amadeus Self-Service as secondary flight source
- [ ] Flag Duffel-missing LCCs (Southwest, Ryanair) in results with "also check X" disclaimer

---

## 🐛 Bugs / tech debt

- [ ] Verbose duration format "3 hours 15 minutes" parses to 180 not 195 (low priority — not in our code paths)
- [ ] Hotel `pricePerNight` may report total-for-stay as per-night when room occupancy differs from requested adults
- [ ] Train unavailable regions (US, Canada, Australia, Africa, S. America) show flights-only silently — should flag to user
- [ ] Duplicate AI suggestions across nearby cities (Uffizi recommended for Rome + Florence)
- [ ] Activity duration clipping: 4h activities render as 2h blocks because morning slot caps at 12:00 (full duration in notes only)
- [ ] Intent picker animation timing on rapid interactions (currently fixed via StrictMode refs, watch for regressions)
- [ ] Canvas → Back → Flights gone — partially fixed by DB persistence work (pending full verification)
- [ ] Canvas save silently drops transports — FIXED in feat/db-persistence
- [ ] Planning flow: no way to correct a destination typo once submitted (Venezuela when user meant Venice). No back button, no edit-previous-message. Partial workaround exists via city picker's "+ another city" but it's awkward. Full fix = task 4 (planning-phase conversational revision).
- [x] ~~AI chat: "are there more flights?" returns an answer-only response instead of showing options~~ — FIXED in 1704365 (leg_refresh + `show_transport_options` tool + clarifying "which leg?" routing).
- [x] ~~AI chat: transport-window proposal card says "Applied the next time we re-pick this leg"~~ — FIXED in 1704365 (card-refresh pattern replaces the inline card entirely).

## 🏗️ Infrastructure / ops

- [ ] Rate limiting middleware (per-IP + per-user) on all `/api` routes
- [ ] Error monitoring (Sentry or Datadog)
- [ ] Structured logging with request IDs
- [ ] Staging environment / preview deploys
- [ ] Automated E2E tests in CI (Playwright)
- [ ] Backup & restore runbook
- [ ] Data retention policies documented

---

## Notes on architecture decisions

### Account deletion model (decided Apr 22, 2026)
Two-tier:
1. **Grace period (30 days)** — user can reactivate by logging in. `user_profiles.deleted_at` is the flag.
2. **Anonymization** — after 30 days, cron clears PII from `auth.users` and `user_profiles` but **keeps trips**. Trips stay attached to the now-anonymous `user_id` so the recommendation engine can still learn from them. Collaborators on owner-anonymized trips get a notification to clone.

### Trip permissions model
Three flags on each trip (set by owner):
- `allow_clones` (default TRUE) — whether other users can make a personal copy
- `allow_recommendations` (default TRUE) — whether Voyza can use this trip's patterns to train the recommender
- `is_public` (default FALSE) — whether the trip shows up in `/explore` and is cloneable by anyone with the URL

### Why we preserve trip data after anonymization
Trip patterns are the product's long-term value:
- Co-occurrence learning ("people who went to Tokyo also visited Kyoto")
- Budget benchmarks per vibe/duration
- Popular route orderings (optimizer ground truth)
- Most-cloned itineraries as a quality signal

All of this works on anonymous user buckets. No PII needed.

### Home anchor model (decided Apr 23, 2026)
Every trip has a persistent "home" — the city + airports the user flies
from. Previously the first destination was treated as the implicit
starting point, which forced the optimizer to fix `cities[0]` and
ignore half the permutations. With home anchor:

- **Trip shape:** `trip.origin = { city, airports, outboundLeg, returnLeg }` + `trip.returnToHome: boolean`
- **Optimizer:** tests ALL `n!` permutations of destinations (home stays anchored), adds `home → cities[0]` outbound leg cost + optional `cities[n-1] → home` return leg cost to every candidate
- **Multi-airport:** origin cities are matched against a 55-city lookup (NYC → JFK/LGA/EWR, London → LHR/LGW/STN, Tokyo → HND/NRT, etc.). Flight search fans out across all origin airports in parallel; cheapest wins
- **Perf:** estimate pass uses only the first airport per origin (cheap permutation ranking); full multi-airport fan-out runs only for the winning permutation's `buildHomeLeg`. Cuts API calls ~3x vs. a naive implementation
- **Graceful degradation:** trips saved before this change render without the home card — no migration needed
