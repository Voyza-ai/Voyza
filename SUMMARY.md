# Build Summary

## What Is Built

### Backend Services (all in `backend/src/services/`)

| Service | File | Status | Notes |
|---------|------|--------|-------|
| Flight search | `flights.ts` | Real | Uses Duffel SDK. IATA code lookup + caching. Retry on 429. |
| Train search | `trains.ts` | Real | Uses DB REST API (free, no key). Limited coverage flag for non-DACH cities. |
| Hotel search | `hotels.ts` | Real | Uses Booking.com via RapidAPI. Rating >= 7.0 filter. |
| Leg compare | `compareLeg.ts` | Real | Runs flight + train in parallel. Door-to-door time. Recommendation engine. |
| Route optimizer | `optimizer.ts` | Real | Full permutation (<=5 cities) or heuristic (6+). Savings calculation. |

### Backend Routes (all in `backend/src/routes/`)

| Route | Method | Endpoint | Auth |
|-------|--------|----------|------|
| Flight search | POST | `/api/flights/search` | No (public) |
| Flight IATA | POST | `/api/flights/iata` | No |
| Train search | POST | `/api/trains/search` | No |
| Hotel search | POST | `/api/hotels/search` | No |
| Compare leg | POST | `/api/search/compare-leg` | No |
| Optimize | POST | `/api/optimize` | No |
| Plan interpret | POST | `/api/plan/interpret` | No |
| Plan suggest | POST | `/api/plan/suggest-destinations` | No |
| Plan edit | POST | `/api/plan/edit` | No |
| Canvas session | POST | `/api/canvas/:tripId/session` | JWT |
| Canvas save | POST | `/api/canvas/:tripId/save` | JWT (owner) |
| Canvas suggestions GET | GET | `/api/canvas/:tripId/suggestions` | JWT |
| Canvas suggestions POST | POST | `/api/canvas/:tripId/suggestions` | JWT (>=suggester) |
| Canvas suggestions PATCH | PATCH | `/api/canvas/:tripId/suggestions/:id` | JWT (owner) |
| Canvas invite | POST | `/api/canvas/:tripId/invite` | JWT (owner) |
| Canvas join | GET | `/api/canvas/join/:token` | Optional JWT |

### Database Schema (`backend/supabase/migrations/`)

- `001_create_tables.sql`: 10 tables (trips, cities, transports, group_members, canvas_sessions, canvas_suggestions, leg_price_cache, airport_codes, db_stops, booking_locations)
- `002_rls_policies.sql`: Full RLS policies for all tables

### Frontend

| Component/File | Status | Notes |
|----------------|--------|-------|
| `lib/api.ts` | New | Typed API client for all backend endpoints. JWT auth. |
| `hooks/useCanvasRealtime.ts` | New | Supabase Realtime hook for canvas sync. |
| `app/canvas/[tripId]/page.tsx` | New | Full-screen canvas workspace page. |
| `components/canvas/CanvasCityCard.tsx` | New | Canvas-specific city card with edit/remove. |
| `components/canvas/SuggestedCitiesPanel.tsx` | New | Collapsible right panel with AI suggestions. |
| `components/canvas/SuggestionsPanel.tsx` | New | Floating panel for pending suggestions. |
| `components/canvas/InviteModal.tsx` | New | Share/invite modal with role selector. |
| `components/results/Flowchart.tsx` | Modified | Added "Edit in Canvas" button. |
| `components/results/AIChatPanel.tsx` | Modified | Wired to `/api/plan/edit` backend. |
| `components/planning/PlanningChat.tsx` | Modified | Wired to `/api/plan/interpret` + `/api/optimize`. |
| `lib/optimizer.ts` | Modified | Added `optimizeRoute()` that calls backend. |

### Tests (27 passing, 6 suites)

- `flights.test.ts`: Normalization, IATA caching, 429 retry
- `trains.test.ts`: Normalization, stop caching, limitedCoverage, graceful failure
- `hotels.test.ts`: Rating filter, missing key, maxPrice filter
- `compareLeg.test.ts`: Door-to-door overhead, recommendation logic, limitedCoverage preference
- `optimizer.test.ts`: Permutation count, savings calculation, date assignment, heuristic path
- `canvas.test.ts`: Auth (401/403), role-based access (owner/editor/suggester/viewer)

## What Is Mocked

- **AI Planning** (`/api/plan/*`): Returns mock responses when `ANTHROPIC_API_KEY` is absent
- **Frontend trip building**: `handleFindTrip` still falls back to `mockTrip` if backend optimization fails

## What Needs a Real Key to Go Live

| Key | Service | Where to set |
|-----|---------|--------------|
| `DUFFEL_ACCESS_TOKEN` | Flight search | `backend/.env` |
| `RAPIDAPI_KEY` | Hotel search | `backend/.env` |
| `ANTHROPIC_API_KEY` | AI planning | `backend/.env` |
| `SUPABASE_URL` | Database | `backend/.env` |
| `SUPABASE_SERVICE_ROLE_KEY` | Database (admin) | `backend/.env` |

Deutsche Bahn train API requires no key.
