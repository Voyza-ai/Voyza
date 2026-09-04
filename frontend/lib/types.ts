export type TransportMode = 'flight' | 'train';

export type Transport = {
  mode: TransportMode;
  operator: string;
  duration: string;
  price: number;
  from?: string;
  to?: string;
  departTime?: string; // "09:15"
  arriveTime?: string; // "10:47"
  departDate?: string; // "2026-06-17"
  fromStation?: string; // "Roma Termini, Platform 12"
  toStation?: string; // "Firenze S.M.N., Platform 5"
  layovers?: number;
  baggage?: string; // "1 carry-on + 1 personal item"
  bookingUrl?: string;
  flightNumber?: string;
  trainNumber?: string;
  /** Alternative departures the user can swap to (other times / modes). */
  alternatives?: Transport[];
  /**
   * Set when neither a flight nor a train could be found for this leg
   * (Duffel returned no offers AND the rail provider returned nothing).
   * The Connector renders a "no direct option found" card with a
   * Rome2Rio fallback link instead of an empty $0 pill. Different from
   * "we haven't searched yet" — this means we tried and got nothing.
   */
  unavailable?: boolean;
  /**
   * True when this is a flight leg AND no live train option was found for a
   * route short enough that a train would plausibly compete (≤6h flight).
   * Drives a subtle "no live train data — showing flights only" note so we're
   * honest that a train isn't being shown, rather than silently implying the
   * flight is the only sensible option.
   */
  noTrainData?: boolean;
};

export type Hotel = {
  name: string;
  rating: number;
  pricePerNight: number;
  area: string;
  /** 0..1 — how central / walkable the neighborhood is */
  locationScore?: number;
  /** computed score from hotelScore() — higher is better */
  score?: number;
  bookingUrl?: string;
  /** Taxes & fees per night (city tax, service, resort fee, etc.) */
  taxesPerNight?: number;
  /** True if BlueMurr can book this hotel directly as part of the upfront payment */
  bookable?: boolean;
  /** Maximum guests per room — defaults to 2 when unset */
  maxGuests?: number;
};

/** A user-supplied hotel/Airbnb that overrides the ranked list selection. */
export type CustomHotel = {
  name: string;
  /** Either entered as per-night or as total — track which mode */
  mode: 'perNight' | 'total';
  /** Whichever mode is active, this field holds the entered number */
  amount: number;
  url?: string;
  area?: string;
};

export type Restaurant = {
  name: string;
  cuisine: string;
  priceRange: string;
  link?: string;
};

export type Activity = {
  name: string;
  description?: string;
  link?: string;
};

/** A time-block event on the day planner (Google Calendar style). */
export type ScheduledEvent = {
  id: string;
  /** Display title */
  title: string;
  /** Start time in "HH:mm" 24-hour format */
  startTime: string;
  /** End time in "HH:mm" 24-hour format */
  endTime: string;
  /** Optional category for color coding */
  category?: 'activity' | 'restaurant' | 'transport' | 'free' | 'custom';
  /** Optional notes */
  notes?: string;
};

export type Vibe =
  | 'history'
  | 'art'
  | 'food'
  | 'beach'
  | 'nightlife'
  | 'nature'
  | 'city'
  | 'romance';

export type City = {
  name: string;
  country: string;
  dates: { arrival: string; departure: string };
  transportIn: Transport;
  transportOut: Transport;
  /**
   * @deprecated kept for backward compat — read from `hotels[selectedHotelIndex]`
   * (or `customHotel` if set) instead.
   */
  hotel: Hotel;
  /** 5 ranked hotel candidates, sorted descending by score */
  hotels: Hotel[];
  /** Index into `hotels` of the currently chosen hotel */
  selectedHotelIndex: number;
  /** When set, overrides `hotels[selectedHotelIndex]` — user typed in their own */
  customHotel?: CustomHotel;
  activities: string[];
  restaurants: Restaurant[];
  /** Per-day schedule — keyed by ISO date (YYYY-MM-DD). Built when user opens day planner. */
  schedule?: Record<string, ScheduledEvent[]>;
  vibes?: Vibe[]; // primary vibes for this city — drives the accent gradient
  colorIndex?: number; // 0–6, user can override, defaults to city position
};

export type Trip = {
  id?: string;
  title: string;
  status: 'planning' | 'confirmed' | 'completed';
  totalCost: number;
  savings: number;
  travelers: number;
  cities: City[];
  savingsTips: string[];
  /** The user's stated total-trip budget in USD, if they gave one. Lets the
   *  results page show a "you're over budget" warning when totalCost > budget. */
  budget?: number;
  /** Optional suggestion from the optimizer when shifting dates saves money. */
  dateShiftSuggestion?: {
    dayOffset: number;
    newStartDate: string;
    newTotalCost: number;
    savings: number;
  };
  createdAt?: string;
  ownerId?: string;
  /**
   * Set on vibe-first trips when Claude flags that bumping the user's
   * budget would unlock better destinations. The results page reads
   * this to render a "Want to up your budget?" banner. Null/absent when
   * the user is already at a comfortable budget for the vibe + origin.
   */
  vibeTierUp?: VibeTierUpSuggestion | null;
  /** User-set constraints (pinned dates, transport windows, min stays)
   *  collected via the BlueMurr AI chat. Persisted to the trip so future
   *  re-optimizations honor them. Shape matches backend TripConstraints. */
  constraints?: {
    pinned_cities?: Array<{ city: string; arrival: string; departure: string }>;
    min_days?: Array<{ city: string; minNights: number }>;
    transport_windows?: Array<{
      from: string;
      to: string;
      earliestDepart?: string | null;
      latestDepart?: string | null;
      earliestArrive?: string | null;
      latestArrive?: string | null;
    }>;
  };
  /** Home anchor — where the user is flying from. When set, the flowchart
   *  renders a "Home" card at the start (and end if returnToHome). The
   *  outboundLeg/returnLeg transports describe the home→first_city and
   *  last_city→home flights. Absent for pre-home-anchor trips — those
   *  render without a home card (graceful degradation). */
  origin?: {
    city: string;
    airports: string[];
    outboundLeg?: HomeLeg | null;
    returnLeg?: HomeLeg | null;
    /** Independent back-home anchor (open-jaw trips). Unset means the
     *  return goes to the same city/airports as the origin. */
    returnCity?: string;
    returnAirports?: string[];
  };
  returnToHome?: boolean;
};

/**
 * Home-anchor leg — the flight between the origin city and a destination.
 * Stored separately from Transport because it doesn't participate in the
 * destination city chain (no hotel, no activities — just an anchor).
 *
 * Mirrors backend `HomeLeg` in services/optimizer.ts. Top-4 alternatives
 * (different carrier / time / airport) ride on `alternatives` so the
 * flowchart can offer a swap without re-searching.
 */
export type HomeLeg = {
  originAirport: string;
  destAirport: string;
  price: number;
  currency: string;
  durationMinutes: number;
  operator: string;
  carrierCode: string;
  departTime: string | null;
  arriveTime: string | null;
  departDate: string;
  stops: number;
  bookingUrl: string | null;
  alternatives?: Omit<HomeLeg, 'alternatives'>[];
};

export type PlanningAnswers = {
  destinations?: string[];
  vibe?: string;
  dateRange?: { start: string; end: string };
  flexible?: boolean;
  travelers?: number;
  budget?: number;
  budgetPerPerson?: boolean;
  extraNotes?: string;
  rawInput?: string;
  /** Home anchor — the city the user is starting from. Required for
   *  optimizer to compute the home→first_city leg and test full
   *  destination permutations. */
  origin?: string;
  /** Top-N IATA codes for the origin city (pre-filled from the lookup).
   *  Backend uses these to search flights across multiple airports in
   *  parallel when the origin is a multi-airport metro. */
  originAirports?: string[];
  /** Round-trip (true) or one-way (false). Default true. */
  returnToHome?: boolean;
  /**
   * Which of the three planning modes the user is in. Set when they
   * pick an intent card on the opening question. Previously the mode
   * was inferred from which step array was active — making it an
   * explicit field so validation, the Find-my-trip handler, and
   * analytics can all branch on it without re-inferring.
   *
   *   - 'destination' : user named specific cities ("Rome and Florence")
   *   - 'vibe'        : user described a feeling ("adventure", "beachy")
   *                     → destinations get AI-suggested at Find-my-trip
   *   - 'budget'      : user led with an amount
   */
  planningMode?: 'destination' | 'vibe' | 'budget';
  /**
   * All suggestions Claude returned for a vibe-first trip. We store
   * the full list (not just the picked one) so a future "here are 3
   * options, pick one" UI can render without a re-call to Claude.
   * Also powers analytics on pick-accuracy.
   */
  vibeSuggestions?: VibeDestinationSuggestion[];
  /**
   * Index into `vibeSuggestions` of the currently-chosen destination.
   * Defaults to 0 (the top-ranked suggestion). Once we add a picker
   * UI, user choice updates this.
   */
  vibeSuggestionIndex?: number;
  /**
   * Total nights for the trip. Set explicitly when the user picks a
   * presets ("3-4", "5-7", "8-10", "11+", custom) — only asked when
   * dateRange is vague ("next month", "this summer"). When dateRange
   * has concrete start + end ISO dates, nights is derived from the
   * range automatically and the explicit step is skipped. Passed to
   * the optimizer to distribute across cities (replaces the previous
   * hardcoded 2-nights-per-city default).
   */
  nights?: number;
};

/**
 * Shape mirrors the backend `DestinationSuggestion` in
 * `services/destinationSuggester.ts`. Kept in lockstep — if backend
 * evolves the schema, update here too.
 */
/**
 * "If you bump your budget by $X, here's what opens up" — shown as a
 * banner on the results page when Claude detects the user is one tier
 * below dramatically better destinations. Mirrors backend
 * `TierUpSuggestion`.
 */
export type VibeTierUpSuggestion = {
  min_budget_increase_per_person_usd: number;
  new_budget_per_person_usd: number;
  destination_examples: string[];
  why_worth_it: string;
};

export type VibeDestinationSuggestion = {
  destination_city: string;
  destination_country: string;
  iata_code: string;
  why_it_fits_vibe: string;
  estimated_total_cost_per_person_usd: { low: number; high: number };
  best_months_to_visit: string[];
  transport_recommendation: 'flight' | 'train' | 'mixed';
  tradeoff_or_caveat: string | null;
  confidence: 'high' | 'medium' | 'low';
};

export type GroupMember = {
  id: string;
  name: string;
  email: string;
  role: 'owner' | 'member' | 'viewer';
  avatarUrl?: string;
};
