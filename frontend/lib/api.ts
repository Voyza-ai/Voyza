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
export type DateShiftSuggestion = {
  dayOffset: number;
  newStartDate: string;
  newTotalCost: number;
  savings: number;
};

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
  /** Present when shifting the trip by ±1 or ±2 days saves meaningful money. */
  dateShiftSuggestion?: DateShiftSuggestion;
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

// ─── Plan Edit (legacy — kept for tests; new code uses planChat) ─
export async function editPlan(params: {
  message: string;
  currentTrip: any;
}): Promise<any> {
  // Route through the new /chat endpoint but preserve the old return
  // shape so the existing AIChatPanel fallback path keeps working until
  // the refactor lands.
  return apiFetch('/api/plan/chat', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// ─── Voyza AI chat ───────────────────────────────────────────
// Send a message to the trip's AI assistant. Response is either a
// plain-text answer or a proposal the user can Accept/Reject.
export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export type ChatProposalDiff = {
  city: string;
  oldArrival: string | null;
  newArrival: string;
  oldDeparture: string | null;
  newDeparture: string;
};

/** One concrete flight/train option for the leg-options proposal card. */
export type LegOption = {
  mode: 'flight' | 'train';
  operator: string;
  flightNumber?: string | null;
  price: number;
  currency: string;
  /** HH:MM local time. */
  departTime: string | null;
  arriveTime: string | null;
  duration: string;
  durationMinutes: number;
  stops?: number;
  bookingUrl?: string | null;
  priceDelta: number;
};

/**
 * Proposal card = user needs to Accept/Reject a set of trip-wide changes.
 * Currently used only for date-bearing tools (pin_city_dates, set_min_days)
 * because those move several cities at once and we don't want to apply
 * without confirmation.
 *
 * Transport changes (show_transport_options, set_transport_window) use a
 * different pattern: type='leg_refresh'. See ChatResponse below.
 */
export type ChatProposal = {
  kind: 'date_shift';
  toolName: 'pin_city_dates' | 'set_min_days';
  toolInput: any;
  diff: ChatProposalDiff[];
  proposedConstraints: any;
  proposedTrip: any;
};

/**
 * Leg-refresh response — the chat updated the transport options for a
 * specific leg. The frontend directly overwrites
 * trip.cities[i].transport.alternatives and swaps the main transport
 * to the cheapest of the new options. No Accept/Reject — the user picks
 * a different one by clicking on the transport card itself.
 */
export type LegRefresh = {
  fromCity: string;
  toCity: string;
  date: string;
  options: LegOption[];
  totalFound: number;
  updatedConstraints: any;
};

export type ChatResponse =
  | { type: 'answer'; reply: string }
  | { type: 'proposal'; reply: string; proposal: ChatProposal }
  | { type: 'leg_refresh'; reply: string; refresh: LegRefresh };

export async function planChat(params: {
  message: string;
  currentTrip: any;
  history?: ChatTurn[];
}): Promise<ChatResponse> {
  return apiFetch<ChatResponse>('/api/plan/chat', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function planChatSuggestions(params: {
  currentTrip: any;
}): Promise<{ suggestions: string[] }> {
  return apiFetch<{ suggestions: string[] }>('/api/plan/chat-suggestions', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// ─── Activities (Claude-picked) ──────────────────────────────
export type ActivitySuggestion = {
  name: string;
  category: 'landmark' | 'museum' | 'food' | 'nature' | 'nightlife' | 'experience' | 'shopping';
  timeOfDay: 'morning' | 'afternoon' | 'evening';
  durationHours: number;
  reason: string;
};

export async function searchActivities(params: {
  city: string;
  country?: string;
  vibe?: string;
  travelers?: number;
  nights?: number;
}): Promise<ActivitySuggestion[]> {
  const data = await apiFetch<{ activities: ActivitySuggestion[] }>('/api/plan/activities', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return data.activities;
}

// ─── Restaurants (Claude-picked) ─────────────────────────────
export type RestaurantSuggestion = {
  name: string;
  cuisine: string;
  priceRange: '$' | '$$' | '$$$' | '$$$$';
  mealType: 'breakfast' | 'lunch' | 'dinner' | 'any';
  reason: string;
};

export async function searchRestaurants(params: {
  city: string;
  country?: string;
  vibe?: string;
  travelers?: number;
  budget?: number;
}): Promise<RestaurantSuggestion[]> {
  const data = await apiFetch<{ restaurants: RestaurantSuggestion[] }>('/api/plan/restaurants', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return data.restaurants;
}

// ─── Canvas API ──────────────────────────────────────────────
export async function getCanvasSession(tripId: string, cities?: any[]) {
  return apiFetch<{ session: any; role: string }>(`/api/canvas/${tripId}/session`, {
    method: 'POST',
    body: JSON.stringify(cities ? { cities } : {}),
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

// ─── Trip CRUD ──────────────────────────────────────────────
export async function saveTrip(trip: any): Promise<{ tripId: string; trip: any }> {
  return apiFetch<{ tripId: string; trip: any }>('/api/trips', {
    method: 'POST',
    body: JSON.stringify({
      title: trip.title,
      travelers: trip.travelers,
      totalCost: trip.totalCost,
      savingsVsAlternative: trip.savings,
      cities: trip.cities,
      // New optional fields — backend accepts nullable/undefined for each.
      // Sending everything so the full trip survives a save/reload cycle.
      budget: trip.budget ?? null,
      budgetPerPerson: trip.budgetPerPerson ?? null,
      vibe: trip.vibe ?? null,
      startDate: trip.startDate ?? trip.cities?.[0]?.dates?.arrival ?? null,
      dateShiftSuggestion: trip.dateShiftSuggestion ?? null,
    }),
  });
}

export async function getTrips(): Promise<{ trips: any[] }> {
  return apiFetch<{ trips: any[] }>('/api/trips');
}

export async function getTrip(tripId: string): Promise<any> {
  return apiFetch<any>(`/api/trips/${tripId}`);
}

export async function deleteTrip(tripId: string): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/trips/${tripId}`, {
    method: 'DELETE',
  });
}

// Partial trip update — rename, change status, update budget/vibe, etc.
// City/transport edits still go through the canvas save endpoint.
export type PatchTripBody = {
  title?: string;
  status?: 'active' | 'completed' | 'archived';
  travelers?: number;
  totalCost?: number;
  savingsVsAlternative?: number;
  budget?: number | null;
  budgetPerPerson?: boolean | null;
  vibe?: string | null;
  startDate?: string | null;
  dateShiftSuggestion?: any;
};

export async function updateTrip(tripId: string, patch: PatchTripBody): Promise<{ trip: any }> {
  return apiFetch<{ trip: any }>(`/api/trips/${tripId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

// ─── User profile CRUD ──────────────────────────────────────
export type UserProfile = {
  id: string;
  email: string;
  emailConfirmed?: boolean;
  createdAt?: string;
  fullName: string | null;
  avatarUrl: string | null;
  isPremium: boolean;
  preferences: {
    homeAirport?: string;
    homeCity?: string;
    preferredCurrency?: string;
    defaultTravelers?: number;
    emailNotifications?: boolean;
  };
};

export async function getCurrentUser(): Promise<UserProfile> {
  return apiFetch<UserProfile>('/api/users/me');
}

export async function updateCurrentUser(
  patch: Partial<Pick<UserProfile, 'fullName' | 'avatarUrl' | 'preferences'>>,
): Promise<UserProfile> {
  return apiFetch<UserProfile>('/api/users/me', {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export async function deleteCurrentUser(): Promise<{ success: boolean; deletedUserId: string }> {
  return apiFetch<{ success: boolean; deletedUserId: string }>('/api/users/me', {
    method: 'DELETE',
  });
}

// ─── Trip collaboration members ─────────────────────────────
export type TripMember = {
  id: string;
  user_id: string | null;
  invited_email: string | null;
  role: 'owner' | 'editor' | 'suggester' | 'viewer';
  accepted_at: string | null;
  created_at: string;
};

export async function listTripMembers(tripId: string): Promise<{ members: TripMember[] }> {
  return apiFetch<{ members: TripMember[] }>(`/api/canvas/${tripId}/members`);
}

export async function updateMemberRole(
  tripId: string,
  memberId: string,
  role: 'editor' | 'suggester' | 'viewer',
): Promise<{ member: TripMember }> {
  return apiFetch<{ member: TripMember }>(`/api/canvas/${tripId}/members/${memberId}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}

export async function removeMember(tripId: string, memberId: string): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/canvas/${tripId}/members/${memberId}`, {
    method: 'DELETE',
  });
}
