import { compareLeg, LegComparison } from './compareLeg';
import { getIataCode, searchFlights } from './flights';
import { logger } from '../utils/logger';
import { getCityCountry } from '../data/cityCountries';
import { searchLegOptions, LegOption } from './legOptions';
import { getOriginAirports } from '../data/originAirports';

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
  totalCost: number;
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
  /** Total leg cost with the shifted dates. */
  newTotalCost: number;
  /** USD saved compared to the user's requested start date. */
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

function nearestNeighborRoute(
  cities: CityInput[],
  startIdx: number,
  distanceFn: (a: string, b: string) => number,
): string[] {
  const visited = new Set<number>();
  const route: string[] = [];
  let current = startIdx;

  visited.add(current);
  route.push(cities[current].name);

  while (visited.size < cities.length) {
    let nearest = -1;
    let nearestDist = Infinity;

    for (let i = 0; i < cities.length; i++) {
      if (visited.has(i)) continue;
      const dist = distanceFn(cities[current].name, cities[i].name);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    }

    if (nearest === -1) break;
    visited.add(nearest);
    route.push(cities[nearest].name);
    current = nearest;
  }

  return route;
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
 * Advance a date by N days without mutating the input. Returns an
 * ISO YYYY-MM-DD string.
 */
function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

/**
 * Ensure a date is not in the past. Flight/train APIs return empty results
 * (or outright errors) for past dates, so when the user's chosen start date
 * + per-leg offset lands before today we shift it to tomorrow to keep the
 * optimizer running instead of silently failing with zero-cost legs.
 */
function clampToFuture(iso: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const candidate = new Date(iso);
  if (candidate.getTime() < today.getTime()) {
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }
  return iso;
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

  // Heavy penalty for legs where neither flight nor train came back. Without
  // it `Math.min(Infinity, Infinity) → Infinity → 0` made broken legs look
  // FREE, so the optimizer would happily pick a "$200 trip" with two missing
  // segments over a $900 one where everything actually exists. Penalty is
  // large enough to swamp any real fare difference but is only used for
  // ranking — the user-facing trip totalCost is recomputed downstream from
  // real prices, so this never leaks into the displayed bill.
  const UNAVAILABLE_LEG_PENALTY = 5000;

  const totalCost = resolvedLegs.reduce((sum, leg) => {
    const cost = leg.cost === Infinity ? UNAVAILABLE_LEG_PENALTY : leg.cost;
    return sum + cost;
  }, 0);

  return { ordering, totalCost, legs: resolvedLegs };
}

/**
 * Probe a handful of ±1 / ±2 day offsets from the user's requested start
 * date and return the biggest-savings offset (if any saves > threshold).
 * Runs in parallel so the wait is ~the time of one extra scoreRoute call.
 */
async function findDateShiftSuggestion(
  bestOrdering: string[],
  requestedStartDate: string,
  baselineCost: number,
  travelers: number,
  cityMap: Map<string, CityInput>,
): Promise<DateShiftSuggestion | undefined> {
  const offsets = [-2, -1, 1, 2];

  // Skip offsets that would land in the past (users can't book for yesterday)
  const today = new Date().toISOString().split('T')[0];
  const candidateOffsets = offsets.filter((o) => {
    const candidate = addDays(requestedStartDate, o);
    return candidate >= today;
  });

  const shifted = await Promise.all(
    candidateOffsets.map(async (offset) => {
      const startDate = addDays(requestedStartDate, offset);
      try {
        const route = await scoreRoute(bestOrdering, startDate, travelers, cityMap);
        return { offset, startDate, cost: route.totalCost };
      } catch {
        return null;
      }
    }),
  );

  const valid = shifted.filter((s): s is { offset: number; startDate: string; cost: number } => s !== null && s.cost > 0);
  if (valid.length === 0) return undefined;

  // Pick the cheapest offset
  valid.sort((a, b) => a.cost - b.cost);
  const best = valid[0];
  const savings = baselineCost - best.cost;

  // Only surface a suggestion if the savings are meaningful:
  // - at least $50 absolute savings, AND
  // - at least 5% of the baseline cost
  const MIN_SAVINGS_USD = 50;
  const MIN_SAVINGS_PCT = 0.05;
  if (savings < MIN_SAVINGS_USD || savings / baselineCost < MIN_SAVINGS_PCT) {
    return undefined;
  }

  return {
    dayOffset: best.offset,
    newStartDate: best.startDate,
    newTotalCost: Math.round(best.cost * 100) / 100,
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

async function searchHomeFlights(params: {
  originAirports: string[];
  tripCity: string;
  date: string;
  travelers: number;
  reverse: boolean;
  /** Max offers to return (sorted cheapest-first). Default 1 (legacy behavior). */
  limit?: number;
}): Promise<HomeFlightOffer[]> {
  const { originAirports, tripCity, date, travelers, reverse, limit = 1 } = params;
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
  return found[0]?.price ?? 0;
}

/**
 * Rebuild the full HomeLeg for the winning route's outbound/return.
 * Returns null on any failure so the trip still builds — the UI just
 * renders the home card without the detail line.
 */
async function buildHomeLeg(params: {
  originAirports: string[];
  destinationCity: string;
  date: string;
  travelers: number;
  reverse?: boolean;
}): Promise<HomeLeg | null> {
  // Pull top 4 — first becomes the main leg, rest go into alternatives
  // so the user can swap to another carrier/time without a new search.
  const offers = await searchHomeFlights({
    originAirports: params.originAirports,
    tripCity: params.destinationCity,
    date: params.date,
    travelers: params.travelers,
    reverse: params.reverse ?? false,
    limit: 4,
  });
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
    // Nearest-neighbor heuristic with 3 seeds for larger trips.
    const simpleDistFn = (a: string, b: string) => {
      const hash = (s: string) =>
        s.split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
      return Math.abs(hash(a) - hash(b));
    };

    const seeds = [0, Math.floor(cities.length / 2), cities.length - 1];
    orderings = seeds.map((seed) => nearestNeighborRoute(cities, seed, simpleDistFn));
  }

  // Step 3: score each permutation.
  //
  // When we have an origin, each permutation's total cost must include
  // the home→first_city outbound leg. We compute that lazily per
  // candidate below (it depends on which city ends up first, so it's
  // different across permutations). The return leg (last_city→home) is
  // added similarly when returnToHome=true.
  const routes = await Promise.all(
    orderings.map(async (ordering) => {
      const baseRoute = await scoreRoute(ordering, startDate, travelers, cityMap, nightsArray);
      if (!hasOrigin) return baseRoute;

      // Outbound leg: home → first destination, on the trip's start date.
      const outboundCost = await estimateHomeLegCost({
        originAirports: resolvedOriginAirports,
        destinationCity: ordering[0],
        date: clampToFuture(startDate),
        travelers,
      });

      // Return leg: last destination → home. Uses the departure date of
      // the last city (when they'd be leaving it to go home).
      let returnCost = 0;
      if (returnToHome) {
        const lastIdx = ordering.length - 1;
        const lastCityDepartDate = clampToFuture(
          addDays(startDate, totalNightsResolved),
        );
        returnCost = await estimateHomeLegCost({
          originAirports: resolvedOriginAirports,
          destinationCity: ordering[lastIdx],
          date: lastCityDepartDate,
          travelers,
          reverse: true, // last_city → home, not home → last_city
        });
      }

      return {
        ...baseRoute,
        totalCost: baseRoute.totalCost + outboundCost + returnCost,
      };
    }),
  );

  // Step 4: sort by totalCost, keep top 3
  routes.sort((a, b) => a.totalCost - b.totalCost);
  const topRoutes = routes.slice(0, 3);

  // Step 5: compute savings vs naive (user's original ordering)
  const naiveOrdering = cities.map((c) => c.name);
  const naiveRoute = await scoreRoute(naiveOrdering, startDate, travelers, cityMap);
  const savingsVsNaive = Math.max(0, naiveRoute.totalCost - topRoutes[0].totalCost);

  // Step 6: assign arrival/departure dates for the best ordering using
  // the per-city nights array. This keeps the displayed calendar
  // aligned with the dates we actually queried during scoring.
  const dates: Record<string, { arrival: string; departure: string }> = {};
  const bestOrdering = topRoutes[0].ordering;
  let cursor = new Date(startDate);

  bestOrdering.forEach((cityName, i) => {
    const arrival = cursor.toISOString().split('T')[0];
    cursor.setDate(cursor.getDate() + (nightsArray[i] ?? DEFAULT_NIGHTS_PER_CITY));
    const departure = cursor.toISOString().split('T')[0];
    dates[cityName] = { arrival, departure };
  });

  // Step 7: date-shift suggestion — probe a few ±1/±2 day offsets on the
  // winning ordering to see if leaving earlier/later saves meaningful money.
  // Runs in parallel; any failures silently skip this feature.
  let dateShiftSuggestion: DateShiftSuggestion | undefined;
  try {
    if (topRoutes[0].totalCost > 0) {
      dateShiftSuggestion = await findDateShiftSuggestion(
        bestOrdering,
        startDate,
        topRoutes[0].totalCost,
        travelers,
        cityMap,
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
