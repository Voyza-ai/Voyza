import { compareLeg, LegComparison } from './compareLeg';
import { getIataCode, searchFlights } from './flights';
import { logger } from '../utils/logger';
import { getCityCountry } from '../data/cityCountries';
import { searchLegOptions, LegOption } from './legOptions';
import { getOriginAirports } from '../data/originAirports';
import { addDays, clampToFuture, todayIso } from '../utils/dates';

type CityInput = {
  name: string;
  country?: string;
};

type OptimizedLeg = {
  from: string;
  to: string;
  comparison: LegComparison;
  cost: number;
  /**
   * Top-N alternatives (mixed flight + train, sorted cheapest-first)
   * for THIS leg. Populated only on the winning route's legs — the
   * scoring phase uses just `comparison` (cheapest pair) since that's
   * all permutation ranking needs. The frontend reads `options` if
   * present and falls back to `comparison`-derived data when absent.
   */
  options?: LegOption[];
};

type OptimizedRoute = {
  ordering: string[];
  /** Sum of the prices we actually found. A leg with no offer adds nothing. */
  totalCost: number;
  /**
   * Ranking-only cost: `totalCost` plus UNAVAILABLE_LEG_PENALTY for every
   * leg — inter-city OR home — whose search came back empty. Sorting on
   * this instead of totalCost is what stops an ordering with a missing
   * $700 outbound from beating one where every flight exists. Never shown
   * to the user; the frontend reads totalCost, which stays real money.
   */
  rankCost: number;
  legs: OptimizedLeg[];
};

/**
 * Nudge-style suggestion when shifting the trip by a day or two would save
 * the user real money. Surfaced as a banner on the results page so the
 * primary itinerary is never blocked on this computation.
 */
export type DateShiftSuggestion = {
  /** Offset from the user's requested start date, in days. Negative = earlier. */
  dayOffset: number;
  /** ISO date after applying the offset. */
  newStartDate: string;
  /**
   * Inter-city leg total with the shifted dates. Home flights are NOT
   * included — see `savings`.
   */
  newTotalCost: number;
  /**
   * USD saved on the inter-city legs compared to the user's requested start
   * date. Both sides of that subtraction are the same legs on the same
   * per-city night schedule, so it is a like-for-like number. Home flights
   * are deliberately left out of both sides: re-pricing them for four extra
   * start dates is eight more Duffel searches right before buildHomeLeg
   * needs the rate-limit window.
   */
  savings: number;
};

/**
 * Home-anchor leg — what the user flies to get from their origin city
 * to the first destination (outbound) or back from the last destination
 * (return). Stored alongside routes so the frontend can render a "Home"
 * card at the start (and end, for round-trips) of the flowchart.
 */
export type HomeLeg = {
  /** IATA of the origin airport that won the multi-airport comparison. */
  originAirport: string;
  /** IATA of the destination airport (first city, or the origin if returning). */
  destAirport: string;
  /** Cheapest price across all searched origin airports. */
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
  /**
   * Up to 3 cheapest alternative offers for this same leg (different
   * carriers / times / airports). The main fields above describe the
   * cheapest pick; this array lets the user swap to another option from
   * the flowchart without re-searching. Each entry is a fully-populated
   * HomeLeg minus its own alternatives (no recursion). Optional —
   * absent when the underlying search returned only one offer.
   */
  alternatives?: Omit<HomeLeg, 'alternatives'>[];
};

export type OptimizeResult = {
  routes: OptimizedRoute[];
  bestRoute: OptimizedRoute;
  savingsVsNaive: number;
  iataCodes: Record<string, string>;
  dates: Record<string, { arrival: string; departure: string }>;
  /** Present only when a nearby date offset saves meaningful money. */
  dateShiftSuggestion?: DateShiftSuggestion;
  /**
   * Home → first_city transport. Present when `origin` was provided.
   * Null when the first-city search failed (e.g. no flights found from
   * any origin airport — frontend renders the home card but marks the
   * outbound as "search failed" rather than hiding it).
   */
  outboundLeg?: HomeLeg | null;
  /**
   * last_city → home transport. Present only when `returnToHome: true`
   * AND the return search succeeded.
   */
  returnLeg?: HomeLeg | null;
};

type OptimizeParams = {
  cities: CityInput[];
  startDate: string;
  travelers: number;
  budget?: number;
  /**
   * User's home city. When set, we:
   *   1. Test ALL destination permutations (no more fixed-first hack)
   *   2. Add a home → first_city leg to each permutation's total cost
   *   3. If returnToHome, add a last_city → home leg too
   *   4. Return outboundLeg and optionally returnLeg on the result
   */
  origin?: string;
  /**
   * IATA codes for the origin city. 1-3 entries. When the origin is a
   * multi-airport city (e.g. NYC → JFK/LGA/EWR), we search all in
   * parallel and pick the cheapest. Populated on the frontend from the
   * originAirports.ts lookup or the user's saved preference.
   */
  originAirports?: string[];
  /** Round-trip if true, one-way if false. Default true. */
  returnToHome?: boolean;
  /**
   * Total nights for the trip across all cities. Distributed evenly
   * across the destinations (with leftover nights spread to the front).
   * Optional — when omitted we fall back to the legacy
   * 2-nights-per-city default.
   */
  totalNights?: number;
};

const DEFAULT_NIGHTS_PER_CITY = 2;

/**
 * Ranking penalty for a leg whose search came back with nothing (neither
 * flight nor train for an inter-city hop; no offers at all for a home leg).
 * Without it a missing leg costs `Math.min(Infinity, Infinity) → 0`, so the
 * optimizer happily picks a "$200 trip" with two nonexistent segments over
 * a $900 one where everything exists. Large enough to swamp any real fare
 * difference, and it only ever lands in `rankCost` — the user-facing
 * totalCost stays the sum of prices we actually found.
 */
const UNAVAILABLE_LEG_PENALTY = 5000;

/**
 * Hard cap on how many origin airports one home-leg search fans out to.
 * Each entry is its own Duffel offer-request and the array comes from the
 * caller: /api/optimize and /api/flights/home-legs both take
 * `originAirports` straight from the request body, and their schemas bound
 * each string's length, not the array's. originAirports.ts documents 1-3
 * codes per metro ("keep the array <=3 long"), so anything past the third
 * is a mistake or abuse.
 */
const MAX_HOME_AIRPORTS = 3;

/**
 * Distribute a total night count across N cities.
 *
 * Spreads nights as evenly as possible, putting leftover nights on the
 * front cities (so a 7-night, 3-city trip becomes [3, 2, 2] not
 * [2, 2, 3] — first stop is the longest, which matches how most
 * travelers think about a multi-city itinerary).
 *
 * Returns a per-city array, indexed the same as the city ordering. When
 * totalNights is undefined, returns a uniform array of
 * DEFAULT_NIGHTS_PER_CITY entries to preserve the legacy behavior.
 */
function distributeNights(totalNights: number | undefined, cityCount: number): number[] {
  if (cityCount <= 0) return [];
  if (typeof totalNights !== 'number' || totalNights <= 0) {
    return Array(cityCount).fill(DEFAULT_NIGHTS_PER_CITY);
  }
  const base = Math.floor(totalNights / cityCount);
  const extra = totalNights - base * cityCount;
  return Array.from({ length: cityCount }, (_, i) => (i < extra ? base + 1 : base));
}

function getPermutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of getPermutations(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

/**
 * Resolve a country code for a city, preferring the explicit field from
 * CityInput (if set by the AI interpret stage) and falling back to our
 * static city→country map for common cities.
 */
function countryOf(city: CityInput): string | undefined {
  if (city.country) return city.country.toUpperCase();
  return getCityCountry(city.name);
}

/**
 * An ordering is "country-clustered" when all cities sharing a country are
 * contiguous in the sequence. Prevents itineraries like
 * Tokyo → Shanghai → Osaka → Beijing where you bounce between countries.
 *
 * If *any* city has an unknown country, we can't reliably apply the filter,
 * so the route passes (safer than dropping legitimate orderings).
 */
function isCountryClustered(ordering: string[], cityMap: Map<string, CityInput>): boolean {
  const countryAt = (name: string): string | undefined => {
    const c = cityMap.get(name);
    return c ? countryOf(c) : undefined;
  };

  // If any city's country is unknown, skip the check (return true).
  for (const name of ordering) {
    if (!countryAt(name)) return true;
  }

  // Walk the ordering — once we leave a country we must never re-enter it.
  const seen = new Set<string>();
  let current: string | undefined;
  for (const name of ordering) {
    const country = countryAt(name)!;
    if (country !== current) {
      if (seen.has(country)) return false; // re-entering
      seen.add(country);
      current = country;
    }
  }
  return true;
}

/**
 * Candidate orderings for trips too large to permute (6 cities = 720
 * orderings, each one a full round of leg searches).
 *
 * The previous heuristic ran nearest-neighbor over
 * `|hash(nameA) - hash(nameB)|` — a pseudo-distance with no relation to
 * geography — and, unlike the ≤5-city path, never applied
 * isCountryClustered. Six cities across Japan and China came back
 * interleaved (Tokyo → Beijing → Osaka → Shanghai → …): exactly the shape
 * the clustering filter exists to reject.
 *
 * There are no city coordinates in the backend, so rather than invent a
 * distance we build up to three orderings that are country-clustered BY
 * CONSTRUCTION and let the real leg prices rank them:
 *
 *   1. country blocks in the order the user first mentioned them
 *   2. the whole sequence reversed (still clustered — different first and
 *      last city, so different home legs)
 *   3. the largest country block first (the long stay up front)
 *
 * Cities whose country we don't know form one trailing block, so they stay
 * contiguous instead of splitting a known one. Duplicates are dropped —
 * with a single country block the three collapse into two sequences, and
 * each duplicate would cost another full round of searches.
 */
function countryGroupedOrderings(cities: CityInput[]): string[][] {
  const UNKNOWN = '??';
  const blocks: string[][] = [];
  const byCountry = new Map<string, string[]>();
  for (const city of cities) {
    const key = countryOf(city) ?? UNKNOWN;
    let block = byCountry.get(key);
    if (!block) {
      block = [];
      byCountry.set(key, block);
      blocks.push(block);
    }
    block.push(city.name);
  }

  const unknownBlock = byCountry.get(UNKNOWN);
  const inOrder = unknownBlock
    ? [...blocks.filter((b) => b !== unknownBlock), unknownBlock]
    : blocks;
  // Stable sort — same-size blocks keep first-mention order.
  const largestFirst = [...inOrder].sort((a, b) => b.length - a.length);

  const candidates: string[][] = [
    inOrder.flat(),
    inOrder.flat().reverse(),
    largestFirst.flat(),
  ];

  const seen = new Set<string>();
  const unique: string[][] = [];
  for (const candidate of candidates) {
    const key = candidate.join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }
  return unique;
}

/**
 * Score a route using per-leg dates (not the same startDate for every leg).
 * The i-th leg happens after the user has spent `nightsPerCity` nights in
 * each preceding city, so pricing reflects the actual travel day.
 */
async function scoreRoute(
  ordering: string[],
  startDate: string,
  travelers: number,
  cityMap: Map<string, CityInput>,
  /**
   * Per-city nights array, indexed by ordering. Cumulative sum gives
   * the leg date offset. When omitted we use uniform
   * DEFAULT_NIGHTS_PER_CITY for every city — preserving the legacy
   * behavior for callers (date-shift probe, naive route) that haven't
   * been updated to thread the user's totalNights through.
   */
  nightsArray?: number[],
): Promise<OptimizedRoute> {
  const nights = nightsArray ?? distributeNights(undefined, ordering.length);
  const legPromises = [];
  for (let i = 0; i < ordering.length - 1; i++) {
    const from = ordering[i];
    const to = ordering[i + 1];
    const fromCity = cityMap.get(from);
    const toCity = cityMap.get(to);

    // Leg i: depart after spending nights[0..i] in earlier cities.
    // City 0 occupies the first nights[0] days, so leg 0 happens on
    // day nights[0]. Clamp to today-or-later — Duffel rejects past
    // dates outright.
    let offset = 0;
    for (let j = 0; j <= i; j++) offset += nights[j] ?? DEFAULT_NIGHTS_PER_CITY;
    const legDate = clampToFuture(addDays(startDate, offset));

    legPromises.push(
      compareLeg({
        origin: from,
        destination: to,
        date: legDate,
        travelers,
        originCountry: fromCity?.country ?? getCityCountry(from),
        destinationCountry: toCity?.country ?? getCityCountry(to),
      }).then((comparison) => ({
        from,
        to,
        comparison,
        cost: Math.min(
          comparison.flightOption?.price ?? Infinity,
          comparison.trainOption?.price ?? Infinity,
        ),
      })),
    );
  }

  const resolvedLegs = await Promise.all(legPromises);

  // Two totals, deliberately: `totalCost` is real money (a leg we couldn't
  // price adds nothing, which is also all the UI can show for it), while
  // `rankCost` charges UNAVAILABLE_LEG_PENALTY for it so broken orderings
  // sort last instead of looking free.
  let totalCost = 0;
  let rankCost = 0;
  for (const leg of resolvedLegs) {
    if (leg.cost === Infinity) {
      rankCost += UNAVAILABLE_LEG_PENALTY;
    } else {
      totalCost += leg.cost;
      rankCost += leg.cost;
    }
  }

  return { ordering, totalCost, rankCost, legs: resolvedLegs };
}

/**
 * Probe a handful of ±1 / ±2 day offsets from the user's requested start
 * date and return the biggest-savings offset (if any saves > threshold).
 * Runs in parallel so the wait is ~the time of one extra scoreRoute call.
 *
 * `baselineLegsCost` must be the winning route's inter-city leg total at
 * the requested start date, priced on the same `nightsArray` we probe with
 * (the caller guarantees it is > 0 and that every leg priced). It used to
 * be the route's full totalCost — home flights included — while the probe
 * re-scored the inter-city legs only, on a 2-nights-per-city schedule the
 * user was never going to travel. The gap between those two numbers is
 * mostly a transatlantic airfare, so the tip promised several hundred (or
 * thousand) dollars for moving the trip one day.
 */
async function findDateShiftSuggestion(
  bestOrdering: string[],
  requestedStartDate: string,
  baselineLegsCost: number,
  travelers: number,
  cityMap: Map<string, CityInput>,
  nightsArray: number[],
): Promise<DateShiftSuggestion | undefined> {
  const offsets = [-2, -1, 1, 2];

  // Skip offsets that would land in the past (users can't book for yesterday)
  const today = todayIso();
  const candidateOffsets = offsets.filter((o) => addDays(requestedStartDate, o) >= today);

  const shifted = await Promise.all(
    candidateOffsets.map(async (offset) => {
      const startDate = addDays(requestedStartDate, offset);
      try {
        // Same nights array as the real trip → the same leg dates, just
        // shifted, so these searches reuse the caches the scoring pass
        // warmed instead of pricing dates nobody will travel.
        const route = await scoreRoute(bestOrdering, startDate, travelers, cityMap, nightsArray);
        return { offset, startDate, route };
      } catch {
        return null;
      }
    }),
  );

  // Only an offset where EVERY leg priced can be compared with the
  // baseline — an unavailable leg contributes $0 to totalCost, which would
  // otherwise read as that leg's whole fare "saved".
  const valid = shifted.filter(
    (s): s is { offset: number; startDate: string; route: OptimizedRoute } =>
      s !== null && s.route.totalCost > 0 && s.route.legs.every((leg) => leg.cost !== Infinity),
  );
  if (valid.length === 0) return undefined;

  // Pick the cheapest offset
  valid.sort((a, b) => a.route.totalCost - b.route.totalCost);
  const best = valid[0];
  const savings = baselineLegsCost - best.route.totalCost;

  // Only surface a suggestion if the savings are meaningful:
  // - at least $50 absolute savings, AND
  // - at least 5% of the baseline cost
  const MIN_SAVINGS_USD = 50;
  const MIN_SAVINGS_PCT = 0.05;
  if (savings < MIN_SAVINGS_USD || savings / baselineLegsCost < MIN_SAVINGS_PCT) {
    return undefined;
  }

  return {
    dayOffset: best.offset,
    newStartDate: best.startDate,
    newTotalCost: Math.round(best.route.totalCost * 100) / 100,
    savings: Math.round(savings * 100) / 100,
  };
}

/**
 * Multi-airport flight search for a home leg. Handles both directions:
 *
 *   OUTBOUND (reverse=false):  originAirports[] → tripCity
 *     → fan out across origin airports, search each to the single
 *       destination IATA, merge + pick cheapest.
 *
 *   RETURN   (reverse=true):   tripCity → originAirports[]
 *     → fan out across home airports as destinations, search each from
 *       the single origin (the trip city), merge + pick cheapest.
 *
 * Home legs are always flights (trains don't do transatlantic / home→
 * overseas), so we skip searchTrains entirely here. Returns the cheapest
 * matching flight along with its actual origin + destination IATA so
 * the UI can display "JFK → FCO" correctly.
 */
type HomeFlightOffer = {
  price: number;
  currency: string;
  durationMinutes: number;
  operator: string;
  carrierCode: string;
  departTime: string | null;
  arriveTime: string | null;
  stops: number;
  bookingUrl: string | null;
  originAirport: string;
  destAirport: string;
};

/**
 * Normalize, dedupe and cap a caller-supplied origin airport list. Every
 * home-leg search goes through this, so the cap holds for /api/optimize
 * and /api/flights/home-legs alike.
 */
function homeAirportsFor(originAirports: string[]): string[] {
  const codes = new Set<string>();
  for (const raw of originAirports) {
    const iata = raw.trim().toUpperCase();
    if (!iata) continue;
    codes.add(iata);
    if (codes.size >= MAX_HOME_AIRPORTS) break;
  }
  return [...codes];
}

async function searchHomeFlights(params: {
  originAirports: string[];
  tripCity: string;
  date: string;
  travelers: number;
  reverse: boolean;
  /** Max offers to return (sorted cheapest-first). Default 1 (legacy behavior). */
  limit?: number;
}): Promise<HomeFlightOffer[]> {
  const { tripCity, date, travelers, reverse, limit = 1 } = params;
  // Cap the fan-out — one Duffel offer-request per airport, and the array
  // comes straight from the request body.
  const originAirports = homeAirportsFor(params.originAirports);
  if (originAirports.length === 0) return [];

  let cityIata: string;
  try {
    cityIata = await getIataCode(tripCity);
  } catch {
    return [];
  }

  // One search per home airport, in parallel. Each search's orientation
  // is determined by `reverse`: for outbound the home airport is the
  // origin; for return it's the destination.
  const perAirport = await Promise.all(
    originAirports.map(async (homeAirport) => {
      const origin = reverse ? cityIata : homeAirport;
      const destination = reverse ? homeAirport : cityIata;
      try {
        const offers = await searchFlights({ origin, destination, date, travelers });
        return offers.map((o: any) => ({
          offer: o,
          homeAirport,
        }));
      } catch {
        return [];
      }
    }),
  );
  const all = perAirport.flat();
  if (all.length === 0) return [];
  all.sort((a, b) => (a.offer.price ?? Infinity) - (b.offer.price ?? Infinity));

  const fmtTime = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const hhmm = iso.split('T')[1]?.slice(0, 5);
    return hhmm ?? null;
  };

  return all.slice(0, limit).map(({ offer: o, homeAirport }) => ({
    price: Number(o.price ?? 0),
    currency: o.currency ?? 'USD',
    durationMinutes: Number(o.durationMinutes ?? 0),
    operator: o.carrier ?? '',
    carrierCode: o.carrierCode ?? '',
    departTime: fmtTime(o.departure),
    arriveTime: fmtTime(o.arrival),
    stops: Number(o.stops ?? 0),
    bookingUrl: o.bookingUrl ?? null,
    originAirport: reverse ? cityIata : homeAirport,
    destAirport: reverse ? homeAirport : cityIata,
  }));
}

/**
 * Cheap estimate for permutation scoring — price only, no offer details.
 *
 * Performance note: originally this did full multi-airport fan-out per
 * permutation per leg, which meant a 3-city trip with NYC origin made
 * ~60 flight searches JUST for ranking permutations (before the final
 * buildHomeLeg). That was blowing past the frontend fetch timeout.
 *
 * Now we only search the FIRST origin airport here (cheap signal —
 * whichever permutation has the cheapest "JFK → X" is likely also
 * cheapest for LGA/EWR). The full multi-airport fan-out is reserved
 * for buildHomeLeg on just the winning permutation. Drops the total
 * call count by ~3x for multi-airport origins like NYC/LHR/Tokyo.
 *
 * Returns Infinity — not 0 — when nothing came back (IATA lookup failed,
 * every per-airport search threw, or there simply are no offers), the
 * same way scoreRoute reports an unpriceable inter-city leg. Callers must
 * charge UNAVAILABLE_LEG_PENALTY for it: the old `?? 0` scored a
 * nonexistent home flight as FREE, so the "cheapest" ordering was often
 * the one whose outbound doesn't exist.
 */
async function estimateHomeLegCost(params: {
  originAirports: string[];
  destinationCity: string;
  date: string;
  travelers: number;
  reverse?: boolean;
}): Promise<number> {
  const found = await searchHomeFlights({
    originAirports: params.originAirports.slice(0, 1),
    tripCity: params.destinationCity,
    date: params.date,
    travelers: params.travelers,
    reverse: params.reverse ?? false,
    limit: 1,
  });
  return found[0]?.price ?? Infinity;
}

/**
 * Rebuild the full HomeLeg for the winning route's outbound/return.
 * Returns null on any failure so the trip still builds — the UI just
 * renders the home card without the detail line.
 */
export async function buildHomeLeg(params: {
  originAirports: string[];
  destinationCity: string;
  date: string;
  travelers: number;
  reverse?: boolean;
  /** Home city name — enables a metro-code fallback search when none of
   *  the specific airports return offers (e.g. EWR alone comes back empty
   *  but the NYC metro code has plenty). */
  originCity?: string;
}): Promise<HomeLeg | null> {
  // Pull top 4 — first becomes the main leg, rest go into alternatives
  // so the user can swap to another carrier/time without a new search.
  let offers = await searchHomeFlights({
    originAirports: params.originAirports,
    tripCity: params.destinationCity,
    date: params.date,
    travelers: params.travelers,
    reverse: params.reverse ?? false,
    limit: 4,
  });

  // Fallback: none of the specific airports had offers — retry with the
  // origin city's metro/primary code, which covers all its airports.
  if (offers.length === 0 && params.originCity) {
    try {
      const metro = await getIataCode(params.originCity);
      // Compare against the capped list — with a longer array the metro
      // code could sit past the cap, i.e. never actually searched.
      if (metro && !homeAirportsFor(params.originAirports).includes(metro.toUpperCase())) {
        offers = await searchHomeFlights({
          originAirports: [metro],
          tripCity: params.destinationCity,
          date: params.date,
          travelers: params.travelers,
          reverse: params.reverse ?? false,
          limit: 4,
        });
      }
    } catch {
      // metro lookup failed — fall through to null below.
    }
  }

  if (offers.length === 0) return null;

  const toLeg = (o: HomeFlightOffer): Omit<HomeLeg, 'alternatives'> => ({
    originAirport: o.originAirport,
    destAirport: o.destAirport,
    price: o.price,
    currency: o.currency,
    durationMinutes: o.durationMinutes,
    operator: o.operator,
    carrierCode: o.carrierCode,
    departTime: o.departTime,
    arriveTime: o.arriveTime,
    departDate: params.date,
    stops: o.stops,
    bookingUrl: o.bookingUrl,
  });

  const [main, ...rest] = offers;
  return {
    ...toLeg(main),
    alternatives: rest.length > 0 ? rest.map(toLeg) : undefined,
  };
}

export async function optimize(params: OptimizeParams): Promise<OptimizeResult> {
  const { cities, startDate, travelers, origin, originAirports, returnToHome = true, totalNights } = params;

  if (cities.length < 1) {
    throw new Error('Need at least 1 city to optimize');
  }

  const hasOrigin = !!origin && origin.trim().length > 0;

  // Distribute the user's total nights across cities (or fall back to
  // 2 per city if they didn't specify). Computed once and threaded
  // through scoreRoute, the date assignment loop, and home-leg date
  // calculations so all three see the same per-city schedule.
  const nightsArray = distributeNights(totalNights, cities.length);
  const totalNightsResolved = nightsArray.reduce((s, n) => s + n, 0);

  // Single-city trips are valid when origin is set (vibe-first flows
  // typically produce one destination, e.g. "Reykjavik for adventure").
  // Without origin, a 1-city trip has no transport to optimize at all,
  // so reject that combination rather than return a degenerate result.
  if (cities.length < 2 && !hasOrigin) {
    throw new Error('Need at least 2 cities, or 1 city with an origin set');
  }

  // Step 1: resolve IATA codes in parallel
  const iataCodes: Record<string, string> = {};
  await Promise.all(
    cities.map(async (city) => {
      try {
        iataCodes[city.name] = await getIataCode(city.name);
      } catch {
        logger.warn('Could not resolve IATA for', { city: city.name });
      }
    }),
  );

  const cityMap = new Map(cities.map((c) => [c.name, c]));

  // Resolve origin airports: caller may pass explicit list (from
  // originAirports.ts lookup or user prefs); otherwise we look up the
  // multi-airport map, and fall back to a single getIataCode result
  // if the city isn't a multi-airport metro.
  let resolvedOriginAirports: string[] = [];
  if (hasOrigin) {
    if (originAirports && originAirports.length > 0) {
      resolvedOriginAirports = originAirports;
    } else {
      const lookup = getOriginAirports(origin!);
      if (lookup.length > 0) {
        resolvedOriginAirports = lookup;
      } else {
        try {
          const single = await getIataCode(origin!);
          resolvedOriginAirports = [single];
        } catch {
          logger.warn('Could not resolve origin IATA', { origin });
        }
      }
    }
  }

  // Step 2: generate candidate orderings.
  //
  // When we have a real origin, "first city" is no longer a hack —
  // it's just whatever destination is closest/cheapest after flying in
  // from home. So we test FULL permutations of all destinations (no
  // fixed-first). When there's no origin, we keep the legacy behavior
  // (first city fixed) so existing behavior is preserved.
  let orderings: string[][];

  if (cities.length <= 5) {
    if (hasOrigin) {
      // Full permutations of all N destinations.
      orderings = getPermutations(cities).map((p) => p.map((c) => c.name));
    } else {
      const rest = cities.slice(1);
      const perms = getPermutations(rest);
      orderings = perms.map((p) => [cities[0].name, ...p.map((c) => c.name)]);
    }

    // Apply the country-clustering filter: reject any ordering that bounces
    // between countries (e.g. JP → CN → JP → CN). Only keep clustered ones.
    const clustered = orderings.filter((o) => isCountryClustered(o, cityMap));
    if (clustered.length > 0) {
      orderings = clustered;
    } else {
      logger.warn('Country clustering filter removed all orderings — falling back');
    }
  } else {
    // Too many cities to permute — score a few orderings that are
    // country-clustered by construction and let real leg prices pick.
    orderings = countryGroupedOrderings(cities);
  }

  // Step 3: score each permutation.
  //
  // When we have an origin, each permutation's total cost must include
  // the home→first_city outbound leg. We compute that lazily per
  // candidate below (it depends on which city ends up first, so it's
  // different across permutations). The return leg (last_city→home) is
  // added similarly when returnToHome=true.
  //
  // Kept in one closure because Step 5's naive baseline has to be priced
  // EXACTLY the same way — same nights, same dates, same home legs — or
  // the subtraction that produces savingsVsNaive compares two different
  // things.
  const scoreOrderingWithHomeLegs = async (ordering: string[]): Promise<OptimizedRoute> => {
    const baseRoute = await scoreRoute(ordering, startDate, travelers, cityMap, nightsArray);
    if (!hasOrigin || resolvedOriginAirports.length === 0) return baseRoute;

    // Outbound leg: home → first destination, on the trip's start date.
    const homeCosts: number[] = [
      await estimateHomeLegCost({
        originAirports: resolvedOriginAirports,
        destinationCity: ordering[0],
        date: clampToFuture(startDate),
        travelers,
      }),
    ];

    // Return leg: last destination → home. Uses the departure date of
    // the last city (when they'd be leaving it to go home).
    if (returnToHome) {
      const lastIdx = ordering.length - 1;
      const lastCityDepartDate = clampToFuture(addDays(startDate, totalNightsResolved));
      homeCosts.push(
        await estimateHomeLegCost({
          originAirports: resolvedOriginAirports,
          destinationCity: ordering[lastIdx],
          date: lastCityDepartDate,
          travelers,
          reverse: true, // last_city → home, not home → last_city
        }),
      );
    }

    // Same money/ranking split as scoreRoute. A home leg we couldn't price
    // used to add 0 to the total, so an ordering whose outbound doesn't
    // exist looked hundreds of dollars cheaper than one whose outbound
    // does, won the sort, and then buildHomeLeg returned null for it — the
    // user got a "search failed" outbound card and a total missing an
    // entire airfare.
    let totalCost = baseRoute.totalCost;
    let rankCost = baseRoute.rankCost;
    for (const cost of homeCosts) {
      if (cost === Infinity) {
        rankCost += UNAVAILABLE_LEG_PENALTY;
      } else {
        totalCost += cost;
        rankCost += cost;
      }
    }

    return { ...baseRoute, totalCost, rankCost };
  };

  const routes = await Promise.all(orderings.map((ordering) => scoreOrderingWithHomeLegs(ordering)));

  // Step 4: sort by rankCost (real prices plus a penalty for any leg that
  // came back empty), keep top 3. Sorting on totalCost let a missing leg,
  // priced at $0, win.
  routes.sort((a, b) => a.rankCost - b.rankCost);
  const topRoutes = routes.slice(0, 3);

  // Step 5: compute savings vs naive (user's original ordering).
  //
  // The naive ordering is normally one of the candidates we just scored,
  // so reuse that result rather than re-pricing it. The old re-score
  // called scoreRoute with no nightsArray and no home legs, so on every
  // trip with an origin it compared a legs-only naive total against a best
  // total that included two airfares: the difference was negative,
  // Math.max clamped it, and savingsVsNaive was $0 for every such trip.
  const naiveOrdering = cities.map((c) => c.name);
  const naiveKey = naiveOrdering.join('|');
  const naiveRoute =
    routes.find((r) => r.ordering.join('|') === naiveKey) ??
    (await scoreOrderingWithHomeLegs(naiveOrdering));
  // Money, not rankCost, on both sides: an unpriced leg counts as $0 here,
  // which under-promises rather than inventing a $5000 "saving".
  const savingsVsNaive = Math.max(0, naiveRoute.totalCost - topRoutes[0].totalCost);

  // Step 6: assign arrival/departure dates for the best ordering using
  // the per-city nights array. This keeps the displayed calendar
  // aligned with the dates we actually queried during scoring.
  const dates: Record<string, { arrival: string; departure: string }> = {};
  const bestOrdering = topRoutes[0].ordering;
  let cursor = startDate;

  bestOrdering.forEach((cityName, i) => {
    const arrival = cursor;
    const departure = addDays(cursor, nightsArray[i] ?? DEFAULT_NIGHTS_PER_CITY);
    dates[cityName] = { arrival, departure };
    cursor = departure;
  });

  // Step 7: date-shift suggestion — probe a few ±1/±2 day offsets on the
  // winning ordering to see if leaving earlier/later saves meaningful money.
  // Runs in parallel; any failures silently skip this feature.
  let dateShiftSuggestion: DateShiftSuggestion | undefined;
  try {
    // Baseline = the winning route's inter-city legs at the requested
    // dates, which is exactly what the probe re-prices. Skipped when any
    // leg is unpriced (its $0 would read as a saving) or when there are no
    // legs at all (single-city trips — only the home flights move there,
    // and we don't re-price those).
    const winningLegs = topRoutes[0].legs;
    const allLegsPriced = winningLegs.every((leg) => leg.cost !== Infinity);
    const baselineLegsCost = winningLegs.reduce((sum, leg) => sum + leg.cost, 0);
    if (winningLegs.length > 0 && allLegsPriced && baselineLegsCost > 0) {
      dateShiftSuggestion = await findDateShiftSuggestion(
        bestOrdering,
        startDate,
        baselineLegsCost,
        travelers,
        cityMap,
        nightsArray,
      );
    }
  } catch (err: any) {
    logger.warn('Date-shift probe failed (non-fatal)', { message: err?.message });
  }

  // Step 7.5: enrich the winning route's inter-city legs with top-N
  // alternatives. The scoring pass uses compareLeg (1 cheapest pair)
  // because that's all permutation ranking needs; here we re-fetch the
  // full options list for the WINNING route only so the displayed
  // Connector cards have 4 alternatives by default.
  //
  // Why only the winner: M legs × N permutations of searchLegOptions
  // calls would explode API cost. M extra calls (one per winning leg)
  // is bounded and reuses Duffel's per-request offer caching from the
  // scoring pass that just ran.
  if (topRoutes[0].legs.length > 0) {
    await Promise.all(
      topRoutes[0].legs.map(async (leg, i) => {
        try {
          const fromCity = cityMap.get(leg.from);
          const toCity = cityMap.get(leg.to);
          // Same date logic as scoreRoute uses for the i-th leg —
          // cumulative sum of nights[0..i].
          let offset = 0;
          for (let j = 0; j <= i; j++) offset += nightsArray[j] ?? DEFAULT_NIGHTS_PER_CITY;
          const legDate = clampToFuture(addDays(startDate, offset));
          const result = await searchLegOptions({
            from: leg.from,
            to: leg.to,
            date: legDate,
            travelers,
            fromCountry: fromCity?.country ?? getCityCountry(leg.from),
            toCountry: toCity?.country ?? getCityCountry(leg.to),
            currentPrice: leg.cost,
            limit: 4,
          });
          if (result.options.length > 0) {
            leg.options = result.options;
          }
        } catch (err: any) {
          // Non-fatal — the leg keeps its `comparison` shape and
          // displays only 1 alternative (current behavior). Log for
          // observability so we can spot if a particular city pair
          // consistently fails enrichment.
          logger.warn('Top-4 enrichment failed for leg (non-fatal)', {
            from: leg.from,
            to: leg.to,
            message: err?.message,
          });
        }
      }),
    );
  }

  // Step 8: build full HomeLeg objects for the winning route. We only
  // do this for the WINNING permutation (not all of them) to keep the
  // round-trip of API calls bounded. Already-cached searches from the
  // scoring pass mean these are typically fast.
  let outboundLeg: HomeLeg | null = null;
  let returnLeg: HomeLeg | null = null;
  if (hasOrigin && resolvedOriginAirports.length > 0) {
    outboundLeg = await buildHomeLeg({
      originAirports: resolvedOriginAirports,
      destinationCity: bestOrdering[0],
      date: clampToFuture(startDate),
      travelers,
      originCity: origin,
    });
    if (returnToHome) {
      const lastIdx = bestOrdering.length - 1;
      // Return leg departs after spending all the trip's nights —
      // cumulative sum of the per-city nights array.
      returnLeg = await buildHomeLeg({
        originAirports: resolvedOriginAirports,
        destinationCity: bestOrdering[lastIdx],
        date: clampToFuture(addDays(startDate, totalNightsResolved)),
        travelers,
        reverse: true,
        originCity: origin,
      });
    }
  }

  return {
    routes: topRoutes,
    bestRoute: topRoutes[0],
    savingsVsNaive,
    iataCodes,
    dates,
    dateShiftSuggestion,
    outboundLeg,
    returnLeg,
  };
}
