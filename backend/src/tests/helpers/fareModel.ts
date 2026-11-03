/**
 * A deterministic fare model for driving optimize() with mocked flights, and
 * the exhaustive answer it should give.
 *
 * Shared by the optimizer's adaptive-screen tests and by the simulation
 * harness in backend/scripts/opt-speed/ (which runs thousands of these).
 *
 * Every fare is a pure function of (seed, origin, destination, date), so the
 * same trip always prices the same however the optimizer orders its
 * searches. Inter-city fares are a per-route base moved by at most ±`swing`
 * by the date; home flights a per-(airport, city) base, also moved by date.
 * A metro code (CHI, LON…) answers with the offers of every airport it
 * covers — the union a Duffel city search returns — each labelled with the
 * airport it really flies from or to.
 *
 * `exhaustive` prices EVERY candidate ordering at its exact dates, the way
 * the optimizer did before the adaptive screen (full permutations, the
 * country filter, UNAVAILABLE_LEG_PENALTY / UNAVAILABLE_HOME_LEG_PENALTY,
 * a stable sort on rankCost), so a test can ask "same winner?".
 *
 * Duffel's TEST mode, as measured on production's token (2026-11-02), is
 * modelled by three options:
 *  - `swingRange`: fares move far more by date than ±30% — each route draws
 *    its own swing from the range (e.g. [0.6, 0.8]);
 *  - `placeholderMetros`: a metro search (CHI, NYC) answers only with the
 *    test airline under the metro code itself, never a real airport;
 *  - `testAirlineOnly`: airports served only by the test airline ("Duffel
 *    Airways", ZZ) — MDW. Home fares then follow the optimizer's rule
 *    (utils/testAirline.ts): a test-airline fare counts only when no airport
 *    has a real one.
 */

import { addDays, clampToFuture } from '../../utils/dates';

/** FNV-1a, 32-bit. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Uniform in [0, 1), from a seed and a key. */
export function unit(seed: number, key: string): number {
  // Two rounds so nearby keys (dates one day apart) decorrelate.
  return hash32(`${hash32(`${seed}|${key}`)}|${key}`) / 4294967296;
}

export type FareModelOptions = {
  seed: number;
  /** Largest relative move a date makes to a fare: 0.3 = ±30%. */
  swing: number;
  /** City name → the code the mocked getIataCode answers. */
  cityCodes: Record<string, string>;
  /** Every airport a home flight can use (the user's list, plus any extras a metro covers). */
  homeAirports: string[];
  /** Metro code → every airport it searches (may include ones outside the user's list). */
  metros?: Record<string, string[]>;
  /** Party size: fares are party totals. */
  travelers: number;
  /** Inter-city base fare range, per person. */
  legRange?: [number, number];
  /** Home flight base fare range, per person. */
  homeRange?: [number, number];
  /** "AAA>BBB" routes with no flight on any date. */
  noFlights?: Set<string>;
  /** "AAA>BBB@YYYY-MM-DD" routes with no flight on that one date. */
  noFlightsOn?: Set<string>;
  /** Per-route swing drawn uniformly from this range (overrides `swing`): Duffel test mode. */
  swingRange?: [number, number];
  /** Metro codes whose search answers only test-airline placeholders under the metro code. */
  placeholderMetros?: string[];
  /** Airports served only by the test airline. */
  testAirlineOnly?: string[];
};

export type MockOffer = {
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
  raw: object;
  originAirport: string;
  destinationAirport: string;
};

export type FareModel = {
  /** The cheapest fare for one airport-to-airport route on one date, or null when none flies. */
  fare(origin: string, destination: string, date: string): number | null;
  /** What the mocked searchFlights answers (metro codes expanded to their airports). */
  offers(params: { origin: string; destination: string; date: string; travelers: number }): MockOffer[];
  /** True when `airport` is served only by the test airline (omitted: none is). */
  testAirlineOnly?(airport: string): boolean;
};

export const TEST_AIRLINE = { carrier: 'Duffel Airways', carrierCode: 'ZZ' };

export function createFareModel(opts: FareModelOptions): FareModel {
  const home = new Set(opts.homeAirports);
  const metros = opts.metros ?? {};
  const [legLo, legHi] = opts.legRange ?? [50, 225];
  const [homeLo, homeHi] = opts.homeRange ?? [600, 1100];
  const placeholders = new Set(opts.placeholderMetros ?? []);
  const testOnly = new Set(opts.testAirlineOnly ?? []);

  const fare = (origin: string, destination: string, date: string): number | null => {
    const route = `${origin}>${destination}`;
    if (opts.noFlights?.has(route) || opts.noFlightsOn?.has(`${route}@${date}`)) return null;
    const isHome = home.has(origin) || home.has(destination);
    const [lo, hi] = isHome ? [homeLo, homeHi] : [legLo, legHi];
    const base = lo + unit(opts.seed, `base|${route}`) * (hi - lo);
    const swing = opts.swingRange
      ? opts.swingRange[0] + unit(opts.seed, `swing|${route}`) * (opts.swingRange[1] - opts.swingRange[0])
      : opts.swing;
    const move = (2 * unit(opts.seed, `date|${route}@${date}`) - 1) * swing;
    return Math.round(base * (1 + move) * opts.travelers * 100) / 100;
  };

  const offer = (origin: string, destination: string, date: string, price: number, i: number, testAirline: boolean): MockOffer => ({
    id: `off-${origin}-${destination}-${date}-${i}`,
    price: Math.round((price + 37 * i) * 100) / 100,
    currency: 'USD',
    departure: `${date}T${String(8 + 3 * i).padStart(2, '0')}:00:00`,
    arrival: `${date}T${String(13 + 3 * i).padStart(2, '0')}:30:00`,
    durationMinutes: 150 + 30 * i,
    stops: i,
    ...(testAirline ? TEST_AIRLINE : { carrier: `Carrier ${i}`, carrierCode: `C${i}` }),
    bookingUrl: `https://example.test/${origin}-${destination}-${date}`,
    raw: {},
    originAirport: origin,
    destinationAirport: destination,
  });

  const airportOffers = (origin: string, destination: string, date: string): MockOffer[] => {
    const cheapest = fare(origin, destination, date);
    if (cheapest === null) return [];
    const testAirline = testOnly.has(origin) || testOnly.has(destination);
    return [0, 1].map((i) => offer(origin, destination, date, cheapest, i, testAirline));
  };

  return {
    fare,
    offers({ origin, destination, date }) {
      // Test mode: the metro answers with the test airline under its own code.
      const placeholder = placeholders.has(origin) ? origin : placeholders.has(destination) ? destination : null;
      if (placeholder) {
        const price = 300 + 900 * unit(opts.seed, `placeholder|${origin}>${destination}@${date}`);
        return [0, 1].map((i) => offer(origin, destination, date, price * opts.travelers, i, true));
      }
      const from = metros[origin] ?? [origin];
      const to = metros[destination] ?? [destination];
      const out: MockOffer[] = [];
      for (const o of from) for (const d of to) out.push(...airportOffers(o, d, date));
      return out;
    },
    testAirlineOnly: (airport) => testOnly.has(airport),
  };
}

// ─── The exhaustive answer ──────────────────────────────────────────────

const UNAVAILABLE_LEG_PENALTY = 5000;
const UNAVAILABLE_HOME_LEG_PENALTY = UNAVAILABLE_LEG_PENALTY * 20;

export type TripSpec = {
  cities: string[];
  startDate: string;
  totalNights: number;
  /** The user's home airports, as passed to optimize(). */
  homeAirports: string[];
  returnToHome: boolean;
  /** Optional country per city (same order); unknown → no clustering. */
  countries?: Array<string | undefined>;
};

export type ExactRoute = {
  ordering: string[];
  rankCost: number;
  totalCost: number;
  unpricedLegs: number;
  /** Cheapest home fare and the airport it leaves from / returns to. */
  outbound: { price: number; airport: string } | null;
  ret: { price: number; airport: string } | null;
};

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([arr[i], ...p]);
  }
  return out;
}

function nightsFor(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => (i < extra ? base + 1 : base));
}

/** The date each inter-city leg (by position) and each home flight is priced on. */
export function tripDates(spec: TripSpec): { legs: string[]; outbound: string; ret: string } {
  const nights = nightsFor(spec.totalNights, spec.cities.length);
  const legs: string[] = [];
  let offset = 0;
  for (let i = 0; i < spec.cities.length - 1; i++) {
    offset += nights[i];
    legs.push(clampToFuture(addDays(spec.startDate, offset)));
  }
  return {
    legs,
    outbound: clampToFuture(spec.startDate),
    ret: clampToFuture(addDays(spec.startDate, spec.totalNights)),
  };
}

/**
 * Price one ordering exactly: every leg on its own date, both home flights
 * at the cheapest of the user's airports — what the old optimizer computed.
 */
export function priceExactly(
  spec: TripSpec,
  model: FareModel,
  cityCodes: Record<string, string>,
  ordering: string[],
): ExactRoute {
  const dates = tripDates(spec);
  let rankCost = 0;
  let totalCost = 0;
  let unpricedLegs = 0;
  for (let i = 0; i < ordering.length - 1; i++) {
    const f = model.fare(cityCodes[ordering[i]], cityCodes[ordering[i + 1]], dates.legs[i]);
    if (f === null) {
      rankCost += UNAVAILABLE_LEG_PENALTY;
      unpricedLegs++;
    } else {
      rankCost += f;
      totalCost += f;
    }
  }
  // The test airline counts only when no airport has a real fare
  // (withoutTestAirlineWhenRealOffered).
  const cheapestHome = (city: string, reverse: boolean, date: string) => {
    let best: { price: number; airport: string; test: boolean } | null = null;
    for (const airport of spec.homeAirports) {
      const f = reverse ? model.fare(cityCodes[city], airport, date) : model.fare(airport, cityCodes[city], date);
      if (f === null) continue;
      const test = model.testAirlineOnly?.(airport) ?? false;
      const better = best === null || (best.test && !test) || (best.test === test && f < best.price);
      if (better) best = { price: f, airport, test };
    }
    return best && { price: best.price, airport: best.airport };
  };
  const outbound = cheapestHome(ordering[0], false, dates.outbound);
  const ret = spec.returnToHome ? cheapestHome(ordering[ordering.length - 1], true, dates.ret) : null;
  for (const h of spec.returnToHome ? [outbound, ret] : [outbound]) {
    if (h === null) {
      rankCost += UNAVAILABLE_HOME_LEG_PENALTY;
      unpricedLegs++;
    } else {
      rankCost += h.price;
      totalCost += h.price;
    }
  }
  return { ordering, rankCost, totalCost, unpricedLegs, outbound, ret };
}

function clustered(ordering: string[], countryOf: Map<string, string | undefined>): boolean {
  if (ordering.some((c) => !countryOf.get(c))) return true;
  const seen = new Set<string>();
  let current: string | undefined;
  for (const c of ordering) {
    const k = countryOf.get(c)!;
    if (k !== current) {
      if (seen.has(k)) return false;
      seen.add(k);
      current = k;
    }
  }
  return true;
}

/** Every candidate ordering priced exactly, best first (stable, like the old sort). */
export function exhaustive(spec: TripSpec, model: FareModel, cityCodes: Record<string, string>): ExactRoute[] {
  const countryOf = new Map(spec.cities.map((c, i) => [c, spec.countries?.[i]]));
  let orderings = permutations(spec.cities);
  const kept = orderings.filter((o) => clustered(o, countryOf));
  if (kept.length > 0) orderings = kept;
  const priced = orderings.map((o) => priceExactly(spec, model, cityCodes, o));
  // Array.prototype.sort is stable: equal rankCosts keep permutation order.
  return priced.sort((a, b) => a.rankCost - b.rankCost);
}
