import { getAuthHeader } from './supabase';

const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * An API error that carries the HTTP status, so callers can distinguish
 * "you're not allowed to do that" from "that failed" and say something
 * useful. Extends Error, so existing `catch`/`instanceof Error` handling
 * keeps working unchanged.
 */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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
    throw new ApiError(res.status, body.error ?? `API error ${res.status}`);
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
  /** Home anchor legs. Present when `origin` was passed to the request. */
  outboundLeg?: import('./types').HomeLeg | null;
  returnLeg?: import('./types').HomeLeg | null;
};

export async function optimizeTrip(params: {
  cities: string[] | Array<{ name: string; country?: string }>;
  startDate: string;
  travelers?: number;
  budget?: number;
  /** Home anchor — city the user is flying from (e.g. "New York"). When
   *  present, the backend tests full destination permutations and adds
   *  home→first_city (+ optional last_city→home) to every route. */
  origin?: string;
  /** IATA codes for the origin city. Fill from getOriginAirports() on
   *  the frontend, or from user preferences. */
  originAirports?: string[];
  /** Round-trip (true) or one-way (false). Defaults to true on server. */
  returnToHome?: boolean;
  /**
   * Total trip nights. Distributed across cities by the optimizer.
   * When omitted the backend uses 2 nights per city as the default.
   */
  totalNights?: number;
}): Promise<OptimizeResult> {
  return apiFetch<OptimizeResult>('/api/optimize', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// ─── Home Legs ───────────────────────────────────────────────
// Live flight search for the home→first-city and last-city→home legs of a
// trip that wasn't built by the optimizer (e.g. Browse presets). Returns
// the optimizer's HomeLeg shape (or null per direction when no offers).
export async function fetchHomeLegs(params: {
  originAirports: string[];
  /** Home city — enables the backend's metro-code fallback search. */
  originCity?: string;
  firstCity: string;
  lastCity: string;
  startDate: string;
  endDate?: string;
  travelers?: number;
  /** Search the home→first-city leg (default true). */
  outbound?: boolean;
  /** Search the last-city→home leg (default true). */
  returnToHome?: boolean;
}): Promise<{ outboundLeg: any | null; returnLeg: any | null }> {
  return apiFetch<{ outboundLeg: any | null; returnLeg: any | null }>(
    '/api/flights/home-legs',
    { method: 'POST', body: JSON.stringify(params) },
  );
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

// ─── Suggest destinations for a vibe-first trip ──────────────
// Different from `suggestDestinations` above — this endpoint is the
// *primary* way destinations get chosen when the user picks
// "I'm chasing a vibe" on the opening question. Returns a richer
// schema (why it fits, cost range, best months, caveats) so the UI
// can render a pickable card list later. Cached 7 days server-side.

import type { VibeDestinationSuggestion, VibeTierUpSuggestion } from './types';

export type SuggestDestinationsForVibeResult = {
  suggestions: VibeDestinationSuggestion[];
  reasoning_summary: string;
  /**
   * Optional "if you bump your budget by $X, here's what opens up"
   * hint. Present when Claude detects the user is one tier below
   * dramatically more aspirational options. Surfaced as a banner /
   * chat message on the results page so the user can choose to up
   * their budget or stick with the cheaper trip.
   */
  tier_up_suggestion: VibeTierUpSuggestion | null;
  meta: {
    cacheHit: boolean;
    attempts: number;
    parseSuccess: boolean;
    fallbackUsed: boolean;
    durationMs: number;
  };
};

export async function suggestDestinationsForVibe(params: {
  vibe: string;
  origin: string;
  budgetPerPerson: number;
  travelWindow: string;
  partySize: number;
  tripType: 'one-way' | 'round-trip';
  extras?: string;
}): Promise<SuggestDestinationsForVibeResult> {
  return apiFetch<SuggestDestinationsForVibeResult>(
    '/api/plan/suggest-for-vibe',
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
  );
}

// ─── Plan Interpret ──────────────────────────────────────────
// ─── Conversational planner ──────────────────────────────────
export type ConverseAction =
  | 'ask'
  | 'show_city_picker'
  | 'show_vibe_picker'
  | 'show_budget_slider'
  | 'ready'
  | 'redirect';

export type ConverseUpdates = {
  destinations?: string[];
  countries?: Array<{ country: string; cities: string[] }>;
  origin?: string | null;
  dates?: { start: string; end: string } | null;
  travelers?: number | null;
  travelersAmbiguous?: boolean;
  budget?: number | null;
  budgetPerPerson?: boolean | null;
  vibe?: string | null;
  returnToHome?: boolean | null;
  notes?: string | null;
};

export type ConverseResponse = {
  reply: string;
  updates: ConverseUpdates;
  action: ConverseAction;
  quickReplies?: string[];
};

/** One turn of the AI trip-planning conversation. Throws on failure —
 *  callers show an honest error + Retry (503 = assistant unavailable). */
export async function converse(params: {
  message: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  known: Record<string, any>;
  userLocation?: string;
}): Promise<ConverseResponse> {
  return apiFetch<ConverseResponse>('/api/plan/converse', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

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

// ─── BlueMurr AI chat ───────────────────────────────────────────
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

/**
 * One-mode summary inside a ModeComparison — just enough fields for the
 * inline side-by-side card. Not used to mutate trip state.
 */
export type ModeComparisonOption = {
  mode: 'flight' | 'train';
  operator: string;
  price: number;
  currency: string;
  duration: string;
  durationMinutes: number;
  stops?: number;
  bookingUrl?: string | null;
};

/**
 * Side-by-side flight vs train comparison for a single leg. Triggered
 * by the `compare_modes` tool when the user is curious about the OTHER
 * mode without committing to a card change yet.
 */
export type ModeComparison = {
  fromCity: string;
  toCity: string;
  date: string;
  flight: ModeComparisonOption | null;
  train: ModeComparisonOption | null;
  cheapest: 'flight' | 'train' | 'same' | 'unavailable';
  fastest: 'flight' | 'train' | 'same' | 'unavailable';
  recommendation: 'flight' | 'train' | 'unavailable';
  priceDifference: number;
  timeDifference: number;
};

export type ChatResponse =
  | { type: 'answer'; reply: string }
  | { type: 'proposal'; reply: string; proposal: ChatProposal }
  | { type: 'leg_refresh'; reply: string; refresh: LegRefresh }
  | { type: 'mode_comparison'; reply: string; comparison: ModeComparison };

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

/** Authoritative role for the current user on a trip, straight from the DB.
 *  Used to re-derive access after a realtime ownership/membership change. */
export async function getCanvasRole(tripId: string) {
  return apiFetch<{ role: string | null }>(`/api/canvas/${tripId}/role`);
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
  type: 'add_city' | 'comment' | 'reaction' | 'edit',
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
      // Home anchor — optional. Old trips save with null/empty and just
      // render without a home card on reload (graceful).
      originCity: trip.origin?.city ?? null,
      originAirports: trip.origin?.airports ?? null,
      returnToHome: typeof trip.returnToHome === 'boolean' ? trip.returnToHome : null,
      // Back-home overrides (open-jaw) — null when returning to the origin.
      returnCity: trip.origin?.returnCity ?? null,
      returnAirports: trip.origin?.returnAirports ?? null,
      // Flight detail for the pill between Home and first/last city.
      // Without these, the pill disappears after reload.
      outboundLeg: trip.origin?.outboundLeg ?? null,
      returnLeg: trip.origin?.returnLeg ?? null,
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
  /** Backfilled home-leg flights (see results-page home-leg backfill). */
  outboundLeg?: any;
  returnLeg?: any;
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
  userId: string | null;
  role: 'owner' | 'editor' | 'suggester' | 'viewer';
  acceptedAt: string | null;
  createdAt: string;
  /** Real email for accepted members; invited_email for pending invites. */
  email: string | null;
  fullName: string | null;
  avatarUrl: string | null;
  pending: boolean;
  /** Personal join-link token — non-null for the OWNER only. */
  inviteToken: string | null;
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

// ─── Canvas share link ────────────────────────────────────────
export type ShareMode = 'view' | 'suggest' | 'edit';

export async function getShareLink(
  tripId: string,
): Promise<{ mode: ShareMode; url: string; token?: string }> {
  return apiFetch<{ mode: ShareMode; url: string; token?: string }>(`/api/canvas/${tripId}/share`);
}

export async function updateShareLink(
  tripId: string,
  patch: { mode?: ShareMode; rotate?: boolean },
): Promise<{ mode: ShareMode; url: string; token?: string }> {
  return apiFetch<{ mode: ShareMode; url: string; token?: string }>(`/api/canvas/${tripId}/share`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** Join a trip via its share link token. Returns the resulting role. */
export async function joinCanvasByLink(
  tripId: string,
  token: string,
): Promise<{ role: string; joined: boolean }> {
  return apiFetch<{ role: string; joined: boolean }>(`/api/canvas/${tripId}/join-link`, {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

/** Owner hands the trip to an accepted member; old owner becomes editor. */
export async function transferOwnership(
  tripId: string,
  memberId: string,
): Promise<{ success: boolean; newOwnerUserId: string }> {
  return apiFetch<{ success: boolean; newOwnerUserId: string }>(
    `/api/canvas/${tripId}/transfer-ownership`,
    { method: 'POST', body: JSON.stringify({ memberId }) },
  );
}

/** Owner bulk-set: every collaborator gets the given role. */
export async function applyRoleToMembers(
  tripId: string,
  role: 'editor' | 'suggester' | 'viewer',
): Promise<{ updated: number; role: string }> {
  return apiFetch<{ updated: number; role: string }>(`/api/canvas/${tripId}/members/apply-role`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
}
