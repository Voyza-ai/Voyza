# Decisions & Assumptions

## Architecture

- **Monorepo structure preserved**: frontend/ (Next.js 14) + backend/ (Express 4). No changes to existing app structure.
- **Backend as API gateway**: All external API calls (Duffel, DB REST, RapidAPI) go through the backend. Frontend never calls third-party APIs directly.
- **Service role Supabase client**: Backend uses service role key (bypasses RLS) for cache tables. Frontend uses anon key with RLS enforced.

## Flight Integration (Duffel)

- **Duffel SDK v3**: Uses `offerRequests.create` with `return_offers: true` for single-request flow.
- **IATA lookup via `suggestions.list`**: Duffel's airport search endpoint. Results cached in `airport_codes` table.
- **Retry on 429**: Exponential backoff (2s, 4s, 8s), max 3 attempts. Other errors thrown immediately.
- **Booking URL format**: `https://duffel.com/redirect/offers/{offerId}` — Duffel's managed booking redirect.

## Train Integration (Deutsche Bahn)

- **DB REST API v6** (`v6.db.transport.rest`): Free, no API key needed. Community-maintained.
- **Limited coverage flag**: Set `limitedCoverage: true` for origin/destination outside DE/AT/CH. DB API returns results but fares are unreliable outside DACH.
- **Non-fatal failures**: Train search never throws — returns `[]` on any error. Trains are a supplementary option.
- **Price data**: DB API has limited fare data. `price` can be `null` for many journeys.

## Hotel Integration (Booking.com via RapidAPI)

- **RapidAPI proxy**: Uses `booking-com.p.rapidapi.com` endpoints. Requires `RAPIDAPI_KEY`.
- **Rating filter**: Only hotels with `review_score >= 7.0` are returned.
- **Graceful degradation**: Returns `[]` if `RAPIDAPI_KEY` is not set, with a warning log.
- **Destination ID caching**: `booking_locations` table caches city-to-dest_id mappings.

## Price Optimizer

- **Full permutation for <= 5 cities**: Fix first city, permute rest → (N-1)! orderings.
- **Nearest-neighbor heuristic for 6+ cities**: 3 random starting seeds, keep best. Avoids factorial blowup.
- **Door-to-door time**: Flights get +180 min overhead (airport transit, security, boarding). Trains use raw duration.
- **Recommendation logic**: Cheapest wins. If prices within 10%, fastest wins. If train has limitedCoverage, prefer flight.
- **2-hour cache**: `leg_price_cache` entries expire after 2 hours.

## AI Planning

- **Graceful without ANTHROPIC_API_KEY**: All three endpoints (`/interpret`, `/suggest-destinations`, `/edit`) return meaningful mock responses.
- **Suggest destinations works without AI**: Uses hardcoded popularity map + budget filtering. AI enhances rankings when available.
- **ANTHROPIC_API_KEY made optional**: Changed from required to optional in Zod schema so backend boots without it.

## Canvas Workspace

- **No custom WebSocket server**: Uses Supabase Realtime for live sync. Subscriptions on `canvas_sessions` and `canvas_suggestions` tables.
- **Owner-wins conflict model**: When owner saves, their canvas state overwrites the DB. Other editors' unsaved changes are lost.
- **Card-level presence**: Shows which card a user last interacted with, not pixel-level cursor tracking. Simpler and sufficient.
- **Invite via token**: `group_members.invite_token` is a UUID string. Invite link format: `{FRONTEND_URL}/canvas/join/{token}`.

## Testing

- **ts-jest for TypeScript**: Tests run through ts-jest transformer. No separate compile step needed.
- **Deep mock chains**: Supabase client mock returns chainable objects that mimic `.from().select().eq().eq().gte().limit()` patterns.
- **supertest for route tests**: Canvas route tests use Express app instance with supertest.
- **No integration tests**: All tests mock external dependencies. Real API keys needed for integration testing.

## Workarounds

- **Duffel `slices` type cast**: `as any` on slice object because `@duffel/api` v3 types require `arrival_time`/`departure_time` which are optional in practice.
- **`data: any` for fetch responses**: TypeScript strict mode requires explicit typing of `res.json()` results from fetch.
- **Express params cast**: `req.params.tripId as string` because Express types return `string | string[]`.
