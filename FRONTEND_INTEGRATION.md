# Frontend Integration Guide

## API Client (`frontend/lib/api.ts`)

All functions include Supabase JWT in `Authorization: Bearer` header automatically.
On 401, redirects to `/login`. On error, throws with message from response body.

Base URL: `process.env.NEXT_PUBLIC_API_URL` (default: `http://localhost:4000`)

---

## Flight Search

```typescript
import { searchFlights, FlightOffer } from '@/lib/api';

const offers: FlightOffer[] = await searchFlights({
  origin: 'FCO',        // 3-letter IATA
  destination: 'FLR',
  departureDate: '2026-06-01',
  passengers: 2,         // optional, default 1
  cabinClass: 'economy', // optional
});
```

**Response shape:**
```typescript
type FlightOffer = {
  id: string;
  price: number;
  currency: string;
  departure: string;   // ISO datetime
  arrival: string;
  durationMinutes: number;
  stops: number;
  carrier: string;
  carrierCode: string;
  bookingUrl: string;
};
```

---

## Hotel Search

```typescript
import { searchHotels, HotelResult } from '@/lib/api';

const hotels: HotelResult[] = await searchHotels({
  city: 'Rome',
  checkin: '2026-06-01',
  checkout: '2026-06-04',
  adults: 2,
  rooms: 1,
  maxPrice: 500,  // optional
});
```

**Response shape:**
```typescript
type HotelResult = {
  id: string;
  name: string;
  price: number;         // total for stay
  pricePerNight: number;
  currency: string;
  rating: number;        // >= 7.0 guaranteed
  reviewCount: number;
  stars: number;
  thumbnail: string;
  bookingUrl: string;
  amenities: string[];
};
```

---

## Train Search

```typescript
import { searchTrains, TrainOffer } from '@/lib/api';

const offers: TrainOffer[] = await searchTrains({
  origin: 'Frankfurt',
  destination: 'Munich',
  date: '2026-06-01',
  travelers: 2,
});
```

**Response shape:**
```typescript
type TrainOffer = {
  id: string;
  price: number | null;  // null if fare unavailable
  currency: string;
  departure: string;
  arrival: string;
  durationMinutes: number;
  operator: string;
  trainType: string;
  bookingUrl: string;
  limitedCoverage: boolean; // true if outside DE/AT/CH
};
```

---

## Compare Leg (Flight vs Train)

```typescript
import { compareLeg, LegComparison } from '@/lib/api';

const result: LegComparison = await compareLeg({
  origin: 'Rome',
  destination: 'Florence',
  date: '2026-06-01',
  travelers: 1,
});
```

**Response shape:**
```typescript
type LegComparison = {
  flightOption: FlightOffer | null;
  trainOption: TrainOffer | null;
  cheapest: 'flight' | 'train' | 'same' | 'unavailable';
  fastest: 'flight' | 'train' | 'same' | 'unavailable';
  recommendation: 'flight' | 'train' | 'unavailable';
  priceDifference: number;
  timeDifference: number;
};
```

---

## Route Optimizer

```typescript
import { optimizeTrip, OptimizeResult } from '@/lib/api';

const result: OptimizeResult = await optimizeTrip({
  cities: [
    { name: 'Rome', country: 'IT' },
    { name: 'Florence', country: 'IT' },
    { name: 'Barcelona', country: 'ES' },
  ],
  startDate: '2026-06-01',
  travelers: 2,
  budget: 3000,  // optional
});
```

**Response shape:**
```typescript
type OptimizeResult = {
  routes: Array<{
    ordering: string[];
    totalCost: number;
    legs: Array<{ from: string; to: string; comparison: LegComparison; cost: number }>;
  }>;
  bestRoute: { ordering: string[]; totalCost: number; legs: any[] };
  savingsVsNaive: number;
  iataCodes: Record<string, string>;
  dates: Record<string, { arrival: string; departure: string }>;
};
```

---

## Suggest Destinations

```typescript
import { suggestDestinations, Destination } from '@/lib/api';

const destinations: Destination[] = await suggestDestinations({
  budget: 500,
  vibe: 'culture',
  currentCities: ['Rome', 'Florence'],
});
```

**Response shape:**
```typescript
type Destination = {
  name: string;
  estimatedCost: number;
  reason: string;
};
```

---

## Canvas Realtime Hook

```typescript
import { useCanvasRealtime } from '@/hooks/useCanvasRealtime';

function CanvasPage({ tripId }: { tripId: string }) {
  const { canvasState, suggestions, isConnected, updateState } = useCanvasRealtime(tripId);

  // canvasState: { trip, cities, transports } | null
  // suggestions: Suggestion[] — live-updated via Realtime
  // isConnected: boolean — Supabase Realtime connection status
  // updateState: (newState) => void — update local state
}
```

**Subscription channels:**
- `canvas_sessions` table filtered by `trip_id` — receives state updates when any user saves
- `canvas_suggestions` table filtered by `trip_id` — receives new suggestions and status updates

---

## Canvas API

```typescript
import {
  getCanvasSession,
  saveCanvas,
  getCanvasSuggestions,
  postCanvasSuggestion,
  updateSuggestionStatus,
  inviteToCanvas,
} from '@/lib/api';

// Get or create session
const { session, role } = await getCanvasSession(tripId);

// Save (owner only)
await saveCanvas(tripId, canvasState);

// Get pending suggestions
const { suggestions } = await getCanvasSuggestions(tripId);

// Submit suggestion (suggester/editor/owner)
await postCanvasSuggestion(tripId, 'add_city', { name: 'Venice' });

// Approve/reject (owner only)
await updateSuggestionStatus(tripId, suggestionId, 'approved');

// Invite member
const { inviteLink } = await inviteToCanvas(tripId, 'user@example.com', 'editor');
```

---

## Error Handling Pattern

All API functions follow the same pattern:

```typescript
try {
  const data = await searchFlights({ ... });
  // use data
} catch (err) {
  // err.message contains the error from the backend
  // On 401: automatic redirect to /login
  // On other errors: message from response body
}
```
