import { compareLeg, LegComparison } from './compareLeg';
import { getIataCode } from './flights';
import { logger } from '../utils/logger';
import { getCityCountry } from '../data/cityCountries';

type CityInput = {
  name: string;
  country?: string;
};

type OptimizedLeg = {
  from: string;
  to: string;
  comparison: LegComparison;
  cost: number;
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

export type OptimizeResult = {
  routes: OptimizedRoute[];
  bestRoute: OptimizedRoute;
  savingsVsNaive: number;
  iataCodes: Record<string, string>;
  dates: Record<string, { arrival: string; departure: string }>;
  /** Present only when a nearby date offset saves meaningful money. */
  dateShiftSuggestion?: DateShiftSuggestion;
};

type OptimizeParams = {
  cities: CityInput[];
  startDate: string;
  travelers: number;
  budget?: number;
};

const NIGHTS_PER_CITY = 2;

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
  nightsPerCity: number = NIGHTS_PER_CITY,
): Promise<OptimizedRoute> {
  const legPromises = [];
  for (let i = 0; i < ordering.length - 1; i++) {
    const from = ordering[i];
    const to = ordering[i + 1];
    const fromCity = cityMap.get(from);
    const toCity = cityMap.get(to);

    // Leg i: depart after spending nightsPerCity * (i + 1) nights worth of
    // time in earlier cities (city 0 occupies the first nightsPerCity days,
    // so leg 0 happens on day nightsPerCity). Clamp to today-or-later —
    // Duffel rejects past dates outright.
    const legDate = clampToFuture(addDays(startDate, (i + 1) * nightsPerCity));

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

  const totalCost = resolvedLegs.reduce((sum, leg) => {
    const cost = leg.cost === Infinity ? 0 : leg.cost;
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

export async function optimize(params: OptimizeParams): Promise<OptimizeResult> {
  const { cities, startDate, travelers } = params;

  if (cities.length < 2) {
    throw new Error('Need at least 2 cities to optimize');
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

  // Step 2: generate candidate orderings
  let orderings: string[][];

  if (cities.length <= 5) {
    // Full permutations with the first city fixed (user-picked starting city).
    const rest = cities.slice(1);
    const perms = getPermutations(rest);
    orderings = perms.map((p) => [cities[0].name, ...p.map((c) => c.name)]);

    // Apply the country-clustering filter: reject any ordering that bounces
    // between countries (e.g. JP → CN → JP → CN). Only keep clustered ones.
    const clustered = orderings.filter((o) => isCountryClustered(o, cityMap));
    if (clustered.length > 0) {
      orderings = clustered;
    } else {
      // Defensive: if the filter somehow rejected everything (shouldn't
      // happen when the first city stays fixed and countries are consistent),
      // fall back to unfiltered orderings rather than crashing.
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

  // Step 3: score each permutation (per-leg dates inside scoreRoute)
  const routes = await Promise.all(
    orderings.map((ordering) => scoreRoute(ordering, startDate, travelers, cityMap)),
  );

  // Step 4: sort by totalCost, keep top 3
  routes.sort((a, b) => a.totalCost - b.totalCost);
  const topRoutes = routes.slice(0, 3);

  // Step 5: compute savings vs naive (user's original ordering)
  const naiveOrdering = cities.map((c) => c.name);
  const naiveRoute = await scoreRoute(naiveOrdering, startDate, travelers, cityMap);
  const savingsVsNaive = Math.max(0, naiveRoute.totalCost - topRoutes[0].totalCost);

  // Step 6: assign arrival/departure dates for the best ordering.
  // Same NIGHTS_PER_CITY cadence scoreRoute used for pricing — this keeps
  // the displayed calendar aligned with the dates we actually queried.
  const dates: Record<string, { arrival: string; departure: string }> = {};
  const bestOrdering = topRoutes[0].ordering;
  let cursor = new Date(startDate);

  for (const cityName of bestOrdering) {
    const arrival = cursor.toISOString().split('T')[0];
    cursor.setDate(cursor.getDate() + NIGHTS_PER_CITY);
    const departure = cursor.toISOString().split('T')[0];
    dates[cityName] = { arrival, departure };
  }

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

  return {
    routes: topRoutes,
    bestRoute: topRoutes[0],
    savingsVsNaive,
    iataCodes,
    dates,
    dateShiftSuggestion,
  };
}
