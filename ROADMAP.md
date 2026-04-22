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

## 🚧 In-flight (this branch: `feat/db-persistence`)

### DB persistence — core (done, tested, not yet committed)
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
- [ ] New page: `/explore` or `/popular`
- [ ] Backend: `GET /api/trips/popular` with filters (vibe, budget, cities)
  - Query: `trips WHERE allow_recommendations = TRUE ORDER BY clone_count DESC`
- [ ] Clone count stored per trip (incremented on clone)
- [ ] Tagging / vibe browsing
- [ ] "Trending this week" ranking

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

### Feature: Origin city / single-destination flights
- [ ] Add `origin` field to planning flow (place/vibe/budget paths all ask)
- [ ] `user_profiles.preferences.homeCity` / `homeAirport` auto-fills origin
- [ ] Single-destination trips now include origin→destination flight leg
- [ ] Optimizer treats origin as city[0] with no hotel, only outbound transport

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
