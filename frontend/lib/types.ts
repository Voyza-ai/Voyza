import type { TravelInfo } from './geoSchedule';
export type TransportMode = 'flight' | 'train';

/**
 * What the user chose for a leg — a flight they accepted from the chat or
 * picked on the card — so a later date or city edit that re-searches the leg
 * keeps it: an evening departure stays evening, "after 15:00" stays after
 * 15:00, a hand-picked time stays close (backend services/legPreference.ts).
 */
export type LegPreference = {
  source: 'chat' | 'card';
  departTime: string | null;
  operator: string | null;
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | null;
  earliestDepart?: string | null;
  latestDepart?: string | null;
  earliestArrive?: string | null;
  latestArrive?: string | null;
};

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
  /**
   * No sensible flight exists on this short hop and no train was found
   * (backend compareLeg `noSensibleFlight`: only 22h+ connections for
   * Prague → Vienna). Shown as the "no direct option" card with a ground
   * ESTIMATE from distance — never a fare.
   */
  noSensibleFlight?: { fastestMinutes: number; stops: number; groundHours: [number, number] | null };
  /**
   * Nothing bookable found — no train, no flight — on a close hop over land
   * (backend compareLeg `groundEstimate`: Lisbon → Sintra, where All Aboard
   * has no CP trains). Shown on the "unavailable" card as an ESTIMATE of time
   * by train or bus; it has no price, so the total still leaves the leg out.
   */
  groundEstimate?: GroundEstimate;
  /**
   * City centre to city centre, with what the time is made of (backend
   * services/legFacts.ts). Absent on legs priced before it existed, and
   * when an airport's position is unknown.
   */
  doorToDoor?: DoorToDoor | null;
  /** Party CO₂: Duffel's estimate for a flight, ours for a train. */
  co2?: Co2Figure | null;
  /** Trains only: where `price` came from. Absent on older trips. */
  priceSource?: RailPriceSource;
  /** The user's choice for this leg, kept through date / city edits. */
  userChoice?: LegPreference;
};

export type DoorToDoorPart = {
  kind: 'transfer' | 'airport' | 'flight' | 'train';
  label: string;
  minutes: number;
};

export type DoorToDoor = {
  totalMinutes: number;
  basis: string;
  parts: DoorToDoorPart[];
};

export type Co2Figure = {
  /** Kilograms for the whole party, like every price. */
  kg: number;
  /** 'duffel' = the airline-itinerary estimate on the Duffel offer; 'estimate' = ours from distance. */
  source: 'duffel' | 'estimate';
  distanceKm?: number;
  gramsPerPassengerKm?: number;
};

/** Mirrors backend `RailPriceSource` in services/trains.ts. */
export type RailPriceSource = {
  kind: 'live' | 'cached' | 'estimated';
  provider?: string;
  /** The fare came from the provider's TEST gateway. */
  testApi?: boolean;
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
  /** Set when the backend does not trust this row's price — see hotelScore.ts */
  priceSuspect?: boolean;
  /** Why `priceSuspect` was set (backend `PriceSuspectReason`), for the words shown. */
  priceSuspectReason?: string;
  /**
   * Set when the search this row came from was too thin to compare prices
   * against (backend: fewer rows than its price check needs). Not a verdict —
   * the price may well be right; we could not check it. See lib/hotelPriceTrust.ts.
   */
  priceUnverified?: boolean;
  /**
   * Reviews behind `rating`. Carried through from the provider so a re-rank
   * applies the same confidence discount the first ranking did — without it,
   * `effectiveRating` takes a 9.5-from-3-reviews at face value.
   */
  reviewCount?: number;
  /** Where the hotel is, from the provider — pins it on the city guide's hotel map. */
  lat?: number;
  lng?: number;
  /** Photos of the hotel, large size, best first. Absent on trips saved before photos were kept. */
  photos?: string[];
  /** Booking's id for the hotel — what its photo gallery is looked up by. */
  providerId?: string;
  /** Street address from Booking ("86 Brick Lane"). */
  address?: string;
  /** Booking's district, usually the borough ("Camden"). Not shown; see `neighbourhood`. */
  district?: string;
  /**
   * The neighbourhood a traveller would know it by ("Spitalfields"), from the
   * hotel's coordinates — see lib/hotelArea.ts. Absent until looked up, and
   * when nothing trustworthy was found.
   */
  neighbourhood?: string;
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
  /** Real coordinates from the POI provider (never the AI). Absent = not located. */
  lat?: number;
  lng?: number;
  /** Provider-scoped id: "google:…", "fsq:…" or "osm:N123". */
  placeId?: string;
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
  /**
   * How long this event needs, in minutes.
   *
   * For anything the day planner placed this is an INVARIANT, not extra
   * information: it always equals `endTime - startTime`. That equality is
   * the whole point — the planner places an item at its real length or
   * not at all, so the block the user reads can never understate it. A
   * 4-hour activity occupies four hours of calendar.
   *
   * (It previously existed to record the length a fixed time slot had
   * thrown away, alongside a `durationClipped` flag. Nothing clips any
   * more, so the flag is gone; this field stays because it saves every
   * consumer parsing two "HH:mm" strings, and because asserting the
   * invariant is how the tests pin the guarantee down.)
   *
   * Absent on events the user created or dragged by hand, and on
   * transport blocks, whose length comes from the carrier.
   */
  plannedDurationMin?: number;
  /**
   * Where the event happens, from the POI provider (never the AI). Set on
   * planner-placed activities and meals that resolved; absent otherwise, and
   * an event without them is scheduled the old, non-geographic way.
   */
  lat?: number;
  lng?: number;
  placeId?: string;
  /**
   * Travel from the previous slot, as the planner measured or estimated it
   * when it placed this event. Views recompute it when the previous event's
   * placeId no longer matches `travelFromPrev.fromPlaceId` (hand re-ordering).
   */
  travelFromPrev?: TravelInfo;
  /**
   * Travel blocks generated from the trip's transport ("Head to …", the
   * flight / train / bus, "Arrive at …").
   *
   *   true      — generated and untouched: `reconcileDayTransport` rewrites
   *               it whenever the transport behind it changes.
   *   false     — was generated, then the user moved or edited it. Left
   *               where they put it, and its `autoRole` stays claimed so no
   *               second block is generated for the same slot.
   *   undefined — user-added, or a legacy block saved before the flag
   *               existed (recognised by title and shape at reconcile time).
   */
  auto?: boolean;
  /** Which generated slot this block fills. Set alongside `auto`. */
  autoRole?: AutoTransportRole;
};

/** The slots `buildDayTransportContext` fills on a travel day. */
export type AutoTransportRole =
  | 'in-head'
  | 'in-travel'
  | 'in-arrive'
  | 'out-head'
  | 'out-travel';

/**
 * Something the planner could not fit into a stay at its real length.
 *
 * The day planner never shortens an item to make it fit; when a day has
 * no room it turns the item away whole and it is recorded here, so the
 * loss is in the data rather than hidden in a block that reads shorter
 * than the thing it names.
 */
export type UnscheduledItem = {
  /** The activity or restaurant name, as the suggestion gave it. */
  title: string;
  kind: 'activity' | 'restaurant';
  /** Minutes it needed. */
  durationMin: number;
  /** The last day it was tried on. */
  date: string | null;
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
  /**
   * Activities and meals this stay could not hold at their real length.
   *
   * In memory only for now: `backend/src/routes/trips.ts` maps city
   * columns explicitly, so this does not round-trip through the DB. It
   * exists so the loss is representable rather than silent — showing it
   * to the user is a separate, design-approved change.
   */
  unscheduled?: UnscheduledItem[];
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
  /** The planner's vibe answer, as saved in `trips.vibe`: one string, the
   *  picked vibes joined with ", " ("Culture, Food"). Older trips carry a
   *  single vibe ("Culture") or nothing. Read it as a list with `vibeList`. */
  vibe?: string;
  /** Optional suggestion from the optimizer when shifting dates saves money. */
  dateShiftSuggestion?: {
    dayOffset: number;
    newStartDate: string;
    newTotalCost: number;
    savings: number;
    /** Every shift that saves real money, best first (max 3). Older saved
     *  trips only carry the flat headline fields above. */
    options?: Array<{
      dayOffset: number;
      newStartDate: string;
      newTotalCost: number;
      savings: number;
    }>;
  };
  /**
   * The optimizer really priced nearby start dates for THESE dates and
   * nothing cheaper held up — the only case the results header may say
   * "Best price for these dates". Cleared when the dates change.
   */
  dateShiftChecked?: boolean;
  /**
   * The planner search this trip came out of. /results opens before that
   * search's AI picks (activities and restaurants) are in; when they arrive
   * they go only to a trip carrying the same run — copies of it included,
   * such as an AI date proposal echoed back by the server — never to another
   * trip opened meanwhile. Set by the planner, kept in the tab's session
   * snapshot, never saved to the database (saveTrip sends named fields).
   */
  picksRun?: string;
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
  /**
   * Set when the origin NAME the traveller typed had more than one real
   * reading and the trip was priced from the most likely one.
   *
   * Someone typing "Portland" gets Oregon, because it is the more prominent
   * reading. If they meant Maine, every flight and every price on this trip
   * is for the wrong city and nothing else on screen would say so. The
   * results page renders a line from this so the choice is visible and
   * changeable.
   *
   * SESSION-SCOPED. It rides the optimize response into the store and is NOT
   * persisted: `trips` has `origin_city` and `origin_airports` as real
   * columns and no place id, so keeping it across a reload needs a migration
   * against the live project. Absent on a trip loaded from the database,
   * which is why the line is a prompt rather than a warning the user must
   * clear.
   */
  originClarification?: {
    /** The string the traveller typed, exactly. */
    input: string;
    reason: 'multi-country' | 'near-tie' | 'not-found';
    candidates: Array<{
      placeId: string;
      /** "Portland, Oregon, United States" */
      label: string;
      airports: string[];
      distanceKm?: number;
    }>;
  };
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
  /**
   * Local date the flight lands (YYYY-MM-DD). Later than `departDate` on an
   * overnight flight. Optional: absent on legs saved before the backend
   * sent it, and when Duffel gave no arrival timestamp — read absence as
   * "same day as departDate", which is what every reader assumed before.
   */
  arriveDate?: string;
  stops: number;
  bookingUrl: string | null;
  alternatives?: Omit<HomeLeg, 'alternatives'>[];
  /** The user's choice for this leg, kept through date / city edits. */
  userChoice?: LegPreference;
};

export type PlanningAnswers = {
  destinations?: string[];
  /**
   * The vibes as ONE string — the picked vibes joined with ", " ("Culture,
   * Food"), or free text. This is what every backend call takes (vibe
   * suggestions, activity and restaurant picks, the AI chat) and what a
   * saved trip stores in `trips.vibe`.
   */
  vibe?: string;
  /**
   * The same vibes as a list (["Culture", "Food"]), up to three picked pills
   * plus any typed text. Kept beside `vibe` for the planner's own UI: the
   * "Trip so far" line and re-opening the vibe pills to edit. Absent on
   * older answers — read them through `vibeList` (lib/vibes), which falls
   * back to `vibe`.
   */
  vibes?: string[];
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

/** Door-to-door minutes by train or bus, low–high, estimated from distance (never a fare). */
export type GroundEstimate = { minutes: [number, number]; km: number };
