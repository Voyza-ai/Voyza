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

### Map tab rebuild (on `feat/map-redesign`, not yet merged)

Five phases, all landed. The organising idea is a **drill-down**: the map
shows the level of detail the camera is at, and the panel always agrees with
the map.

- [x] **1. MapLibre + vector tiles** (OpenFreeMap, free, no key). Raster tiles
      bake roads and labels into the image, which makes per-zoom control
      impossible — this swap is what the rest depends on.
- [x] **2. Zoom level-of-detail** on the basemap — country lines → city
      boundaries → roads → labels, tuned per `source-layer`. Brand-blue
      recolour so the map reads as BlueMurr, not generic OSM.
- [x] **3. Typed itinerary pins** inside a city — airport / hotel / restaurant
      / sight / activity, each with its own colour and glyph, names always
      visible, collision-nudged so they don't stack.
- [x] **4. Recommended pins** — "Also worth seeing": places in the city that
      are NOT in the itinerary, drawn hollow + dashed + starred so a
      suggestion never reads as a plan. Opt-in per city, cached.
- [x] **5. Country tier** — zoomed out past z5, cities collapse into one pill
      per country, numbered 1..n in visit order. Click drills down to that
      country's cities.

**Zoom thresholds** (`CITY_ENTER_ZOOM` 10 / `CITY_EXIT_ZOOM` 9 / `COUNTRY_ZOOM`
5): the enter/exit pair differ on purpose — one shared threshold makes the view
flap between tiers while the camera sits on the boundary.

Bugs found and fixed while building, worth not regressing:
- City geocoding was unqualified, so "Nara" resolved to the **US National
  Archives** in Washington DC and dragged the map across the Atlantic. Now
  country-scoped.
- Spot cache was keyed by array **index**, so reordering the trip served one
  city another's places (Osaka showing Kyoto's temples). Now keyed by identity.
- Map bounds took the long way round the globe on intercontinental trips —
  Philadelphia → Japan framed the Atlantic (215°) instead of the Pacific
  (149°). Fixed in `lib/mapBounds.ts`, unit-tested.
- All-capitalised place names never resolved ("Todai-ji Great Buddha Hall"),
  because the proper-noun trim had no descriptive tail to cut. Two-word head
  fallback added — deliberately never one word, since "Tokyo" resolves to
  Tokyo Station and would pin the wrong place convincingly.

Known remaining:
- [ ] Recommendations currently source candidates from Claude, which is the
      wrong tool for recall. Measured **~85s** for one city (Milan) from click
      to pins — a Claude call plus one rate-limited geocode per returned name.
      Cached per city, so only the first open pays it, but that first open is
      long enough that the feature reads as broken. See "Taste-based
      recommendations" in the backlog for the intended architecture.
- [ ] Some places genuinely aren't in OpenStreetMap. Root cause is the data,
      not the query: "Kamameshi Shizuka" (a real Nara restaurant) was probed
      live against Nominatim in four forms — `", Nara, Japan"`, `", Japan"`,
      `"Shizuka, Nara, Japan"`, and the full name — and every one missed. No
      query engineering reaches data that isn't there. The map reports these
      honestly as "couldn't place", which is the right behaviour; the
      alternative is pinning a guess. Fixing it properly needs a second
      geocoding source with commercial POI coverage (Google Places /
      Foursquare) — an API key and a per-call cost, so a real decision rather
      than a tweak. Restaurants are the weakest category; landmarks are
      generally fine in OSM.
- [?] Saw the camera fail to re-frame once: the panel listed Paris / Amsterdam
      / Lyon while the map still showed Iceland from a previous trip. Pins had
      updated, the camera had not. Happened during rapid successive trip swaps
      (three `setTrip` calls, ~20s apart, while the Map tab was open). Tried to
      reproduce with a deliberate swap and the map re-framed correctly, so the
      trigger is unknown — possibly a geocode still in flight when the next
      trip landed. Worth re-checking whenever the AI chat gains the ability to
      rewrite a whole itinerary, since that is the real path that would hit it.
- [~] Map rendered blank once. **Size mechanism root-caused**, the rest not.
      MapLibre measures its container ONCE at construction; mount it with no
      layout box and it falls back to a built-in 400x300 canvas and stays
      there. Reproduced deliberately by forcing the cards area to 0x0 before
      switching to the Map tab — canvas came back 800x600 (400x300 CSS at DPR
      2), exactly the size seen in the original failure.
      Now recovers: with `ready` also listening to `idle` (not just `load`) and
      the ResizeObserver always calling `map.resize()` — including on its first
      observation, which used to be skipped and was precisely the event that
      would have fixed it — a 0x0 mount resizes correctly once the container
      gains a box (verified: canvas 1236x1280, markers render).
      STILL UNEXPLAINED: the original also had `ready` false, zero markers and
      **no tile requests at all**. In the reproduction `load` fires and markers
      render even at 0x0, so something additionally prevented the style from
      loading that day — possibly the style fetch to OpenFreeMap failing right
      after a dev-server restart. If it recurs, check the network panel for the
      style request before anything else.


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

### Feature: Map on mobile (needs design)

The Map tab is effectively unusable below `md`. Not a bug with a fix — a
layout that was designed for desktop and never given a mobile treatment.

Measured on a 375×812 viewport:
- Map canvas came out **77px tall** (now 156px after capping the stacked chat
  at 45vh, still unusable). The header, title and cost cards take ~530px of
  the 812px screen before the map gets any.
- The tile attribution wraps to two lines and covers most of what's left.
- The itinerary panel is `hidden md:flex`, so there is no way to see the stop
  list or open a city at all — the entire drill-down is desktop-only.
- Map controls (zoom, Show home, theme) overlap the country pills.

Decisions needed before building:
- [?] Should the Map tab go full-bleed on mobile — collapse the header and
      cost cards while it is active?
- [?] What replaces the floating itinerary panel — a bottom sheet?
- [?] Does the AI chat belong on the Map tab on mobile at all, or should it be
      a tab of its own?

Separately, and not map-specific: the navbar overlaps itself at 375px —
"BlueMurr" collides with "Flowchart", and "Schedule" collides with "Log in".

### Feature: Taste-based recommendations (map suggestions → personalized)

The map's "Also worth seeing" layer today shows *general* picks for a city.
The intent is that it becomes personal: Claude reads a user's past trips and
infers what they actually like, so the same city suggests different places to
different people. General picks are the cold start, not the destination.

**Architecture (decided — see the note below on why):**
- [ ] Candidates from a places API (Overpass/OSM, or Google Places), NOT from
      Claude's recall. Returns names *and* coordinates in one call.
- [ ] Claude ranks the candidate list against the user's taste and writes the
      one-line reason. Small, cheap, grounded call over a known list.
- [ ] Cold start (no history) = same pipeline with an empty taste input.

**Capture the training signal — do this EARLY, it cannot be backfilled:**
- [ ] "Add to trip" action on suggested map pins
- [ ] Log every suggestion *shown* alongside whether it was added or ignored,
      with city + vibe context. Six suggestions shown = six labelled examples.
- [ ] Without this the DB only stores outcomes (what ended up in the trip),
      never choices (what was offered and passed over). Taste lives mostly in
      the rejections.

**Taste signals already in the schema (usable on day one):**
- `trips.vibe`, `cities.vibes` — stated preference
- `trips.budget` + `budget_per_person`, `restaurants[].priceRange` — price tier
- `cities.restaurants[].cuisine` — food preference
- `cities.activities` — what they actually planned
- nights per city — pace (fast-moving vs. slow traveller)
- `cities.selected_hotel_index` — REVEALED preference: shown five ranked
  hotels, picked one. Worth more than anything self-reported.
- `cities.custom_hotel` — louder still: rejected all five and typed their own.

**Open questions:**
- [?] Cross-user ("people like you also liked…") is a much bigger step than
      per-user history, and raises privacy questions the current model avoids.
      Gated on `allow_recommendations` (already in the schema) if pursued.
- [?] Needs real usage before it means anything — the DB currently holds a
      handful of users and mostly duplicate test trips. No corpus yet.

**Why candidates come from a places API rather than Claude:**
Asking an LLM to list a city's landmarks is asking it to *recall*, which is
what it is weakest at — it occasionally returns places that are renamed,
closed, or absent from OSM, which then silently fail to geocode and get
dropped. It also returns names only, so each one costs a separate rate-limited
geocode (~1/sec). Measured end-to-end on Milan: **~85 seconds** from clicking
"Also worth seeing" to pins on the map. (An earlier note in this file said
~40s; that was an under-estimate from a city whose places were already in the
geocode cache.)
A places API answers the question actually being asked ("what is near these
coordinates") and hands back coordinates for free. Claude's real value here is
taste and explanation, not recall.

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

### Feature: Running trip summary on the conversation page
A floating "trip card" on the conversation page that updates as the
user answers each question — shows what's been collected so far in a
clean, readable summary. Helps the user see their inputs accumulating
before the final "Find my trip" click.

- [ ] Component: small card above the chat input bar (Option 3 from
  design discussion). Doesn't show until the first answer.
- [ ] Updates per answer: appends new facts in natural language
  (e.g. "Adventure trip from NYC · 2 people · $3k budget · June 15-22")
- [ ] Smart formatting: combines fields into readable phrases rather
  than a bullet list (e.g. "$3k budget per person · 7 nights" not
  "budget: 3000\nnights: 7")
- [ ] Inline editable: clicking a fact lets user revise (deferred —
  the AI chat can already revise; UI affordance later)

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

### Feature: Ferry coverage (multi-modal — islands)
Ferries are a first-class transport mode, not an add-on. Europe-first makes
them essential: many island destinations are reachable cheapest (or only) by
sea, and ferry often beats a short flight on price + door-to-door time for the
Balearics, Greek islands, Italian islands, and Croatia. Fits the transport
provider registry as a third `mode` — see TRANSPORT_ARCHITECTURE.md.
- [ ] Add `ferry` as a third mode in the provider registry; optimizer's
      compareLeg considers flight / train / ferry on every leg
- [ ] Integrate a ferry source. Options:
  - Direct Ferries (aggregator — widest EU coverage, affiliate/API)
  - AFerry / Ferryhopper (Greece-strong) as alternates
  - Per-operator: Balearia & Trasmediterránea (Spain/Balearics), Blue Star &
    Hellenic Seaways (Greece), Grimaldi / Tirrenia (Italy → Sardinia/Sicily),
    Jadrolinija (Croatia)
- [ ] Priority island corridors: Barcelona / Valencia / Dénia → Ibiza & Mallorca;
      Athens (Piraeus) → Santorini / Mykonos / Crete; Naples → Capri / Ischia;
      mainland Italy → Sicily / Sardinia; Split → Hvar
- [ ] Static fallback table for top island routes (same pattern as rail stopgap)
- [ ] Use foot-passenger fares (not vehicle) for pricing
- [ ] Ferry pill + icon styling in the flowchart Connector (new mode visual)

### Feature: Calendar reacts to transport changes (calendar view just like flowchart view)
- [ ] Tag auto-generated travel events ("head to airport" / flight / arrive) with an `auto` flag on `ScheduledEvent`
- [ ] DayPlanner reconciles tagged events from current `transportIn`/`transportOut` on each open
- [ ] Live update while planner is open if user swaps a flight on the flowchart
- [ ] Restaurants, activities, and user-added events stay untouched
- [ ] Decide: snap user-edited transport blocks back to new flight times, or honor manual edits
- [ ] Affected dates: arrival day (uses `transportIn`) and departure day (uses `transportOut`)

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
- [ ] Origin-location lookup misses non-city inputs (states, regions, neighborhoods). User typing "from New Jersey" / "Newark" / "Long Island" / "Connecticut" → AI returns the literal string → `getOriginAirports()` lookup misses → empty `originAirports` → home flight search never runs → schedule view shows no transport blocks for day 1. Already partially fixed for "<City> City" suffix variants (commit `0f24996`). Need: state-name aliases (NJ → EWR or NYC metro, CT → BDL, etc.), region aliases (Long Island → JFK/LGA, Bay Area is already in), and a smarter normalization layer at the AI-parse step that resolves vague locations to canonical metro keys before the lookup table is queried. Affects both `frontend/lib/originAirports.ts` and `backend/src/data/originAirports.ts`.
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
