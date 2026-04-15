import { supabase } from './supabase';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

async function getAuthHeader(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (token) return { Authorization: `Bearer ${token}` };
  return {};
}

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const authHeaders = await getAuthHeader();
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
      ...options.headers,
    },
  });

  if (res.status === 401) {
    if (typeof window !== 'undefined') {
      window.location.href = '/login';
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `API error ${res.status}`);
  }

  return res.json();
}

// ─── Flight Search ───────────────────────────────────────────
export type FlightOffer = {
  id: string;
  price: number;
  currency: string;
  departure: string;
  arrival: string;
  durationMinutes: number;
  stops: number;
  carrier: string;
  carrierCode: string;
  bookingUrl: string;
};

export async function searchFlights(params: {
  origin: string;
  destination: string;
  date: string;
  travelers?: number;
  cabinClass?: string;
}): Promise<FlightOffer[]> {
  const data = await apiFetch<{ offers: FlightOffer[] }>('/api/flights/search', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return data.offers;
}

// ─── Hotel Search ────────────────────────────────────────────
export type HotelResult = {
  id: string;
  name: string;
  price: number;
  pricePerNight: number;
  currency: string;
  rating: number;
  reviewCount: number;
  stars: number;
  thumbnail: string;
  bookingUrl: string;
  amenities: string[];
};

export async function searchHotels(params: {
  city: string;
  checkin: string;
  checkout: string;
  adults?: number;
  rooms?: number;
  maxPrice?: number;
}): Promise<HotelResult[]> {
  const data = await apiFetch<{ hotels: HotelResult[] }>('/api/hotels/search', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return data.hotels;
}

// ─── Train Search ────────────────────────────────────────────
export type TrainOffer = {
  id: string;
  price: number | null;
  currency: string;
  departure: string;
  arrival: string;
  durationMinutes: number;
  operator: string;
  trainType: string;
  bookingUrl: string;
  limitedCoverage: boolean;
};

export async function searchTrains(params: {
  origin: string;
  destination: string;
  date: string;
  travelers?: number;
}): Promise<TrainOffer[]> {
  const data = await apiFetch<{ offers: TrainOffer[] }>('/api/trains/search', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return data.offers;
}

// ─── Optimize ────────────────────────────────────────────────
export type OptimizeResult = {
  routes: Array<{
    ordering: string[];
    totalCost: number;
    legs: any[];
  }>;
  bestRoute: {
    ordering: string[];
    totalCost: number;
    legs: any[];
  };
  savingsVsNaive: number;
  iataCodes: Record<string, string>;
  dates: Record<string, { arrival: string; departure: string }>;
};

export async function optimizeTrip(params: {
  cities: string[] | Array<{ name: string; country?: string }>;
  startDate: string;
  travelers?: number;
  budget?: number;
}): Promise<OptimizeResult> {
  return apiFetch<OptimizeResult>('/api/optimize', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// ─── Compare Leg ─────────────────────────────────────────────
export type LegComparison = {
  flightOption: FlightOffer | null;
  trainOption: TrainOffer | null;
  cheapest: 'flight' | 'train' | 'same' | 'unavailable';
  fastest: 'flight' | 'train' | 'same' | 'unavailable';
  recommendation: 'flight' | 'train' | 'unavailable';
  priceDifference: number;
  timeDifference: number;
};

export async function compareLeg(params: {
  origin: string;
  destination: string;
  date: string;
  travelers?: number;
}): Promise<LegComparison> {
  return apiFetch<LegComparison>('/api/search/compare-leg', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// ─── Suggest Destinations ────────────────────────────────────
export type Destination = {
  name: string;
  estimatedCost: number;
  reason: string;
};

export async function suggestDestinations(params: {
  budget?: number;
  vibe?: string;
  userLocation?: string;
  currentCities?: string[];
}): Promise<Destination[]> {
  const data = await apiFetch<{ destinations: Destination[] }>(
    '/api/plan/suggest-destinations',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
  );
  return data.destinations;
}

// ─── Plan Interpret ──────────────────────────────────────────
export async function interpretPlan(params: {
  rawInput: string;
  userLocation?: string;
}): Promise<any> {
  return apiFetch('/api/plan/interpret', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// ─── Plan Edit ───────────────────────────────────────────────
export async function editPlan(params: {
  message: string;
  currentTrip: any;
}): Promise<any> {
  return apiFetch('/api/plan/edit', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// ─── Canvas API ──────────────────────────────────────────────
export async function getCanvasSession(tripId: string) {
  return apiFetch<{ session: any; role: string }>(`/api/canvas/${tripId}/session`, {
    method: 'POST',
  });
}

export async function saveCanvas(tripId: string, state: any) {
  return apiFetch<{ saved: boolean; savedAt: string }>(
    `/api/canvas/${tripId}/save`,
    {
      method: 'POST',
      body: JSON.stringify({ state }),
    },
  );
}

export async function getCanvasSuggestions(tripId: string) {
  return apiFetch<{ suggestions: any[] }>(`/api/canvas/${tripId}/suggestions`);
}

export async function postCanvasSuggestion(
  tripId: string,
  type: 'add_city' | 'comment' | 'reaction',
  payload: any,
) {
  return apiFetch<{ suggestion: any }>(`/api/canvas/${tripId}/suggestions`, {
    method: 'POST',
    body: JSON.stringify({ type, payload }),
  });
}

export async function updateSuggestionStatus(
  tripId: string,
  suggestionId: string,
  status: 'approved' | 'rejected',
) {
  return apiFetch<{ suggestion: any }>(
    `/api/canvas/${tripId}/suggestions/${suggestionId}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    },
  );
}

export async function inviteToCanvas(
  tripId: string,
  email: string,
  role: 'editor' | 'suggester' | 'viewer',
) {
  return apiFetch<{ member: any; inviteLink: string }>(
    `/api/canvas/${tripId}/invite`,
    {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    },
  );
}
