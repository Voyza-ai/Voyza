/**
 * 4-5 city trips with a home: a cold optimize keeps its inter-city searches
 * inside ONE Duffel rate-limit window, and still picks what pricing every
 * ordering would.
 *
 * Duffel accepts 30 searches per wall-clock minute per token (its own
 * headers, 2026-11-24); the rest wait for the next window. A cold 5-city
 * optimize once made ~116 (80 inter-city legs, 20 home flights, ~16 for the
 * date-shift probe) and took 69-80 s. Now:
 *
 *  - every ordered city pair is priced once (a screen) and only the orderings
 *    that could still win are priced exactly, best-first, within
 *    PLAN_SEARCH_BUDGET (32) inter-city searches;
 *  - home flights are searched from EVERY one of the traveller's airports,
 *    for every city and direction, and ranked on all of them (owner's rule,
 *    2026-11-27) — never on the first airport alone or a metro code; the
 *    planner pre-searches them during the chat;
 *  - the date-shift probe does not run on 4+ cities.
 *
 * Fares come from helpers/fareModel.ts: per-route bases moved at
 * most ±30% by the date, so `exhaustive()` there — every ordering, home
 * flights at the cheapest of the traveller's airports — is the answer, and
 * the screen's lower bound always holds.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'duffel_live_jest',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

jest.mock('../services/supabase', () => {
  const createChain = (): any => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'upsert', 'order']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return { getSupabase: () => ({ from: () => createChain() }) };
});

const mockCodes: Record<string, string> = {
  Alpha: 'ZQA',
  Bravo: 'ZQB',
  Charlie: 'ZQC',
  Delta: 'ZQD',
  Echo: 'ZQE',
  Chicago: 'CHI',
  London: 'LON',
  Boston: 'BOS',
  Washington: 'WAS',
};
jest.mock('../services/flights', () => {
  const { AppError } = jest.requireActual('../middleware/error');
  return {
    getIataCode: jest.fn(async (name: string) => {
      const code = mockCodes[name];
      if (!code) throw new AppError(404, `No IATA code found for "${name}"`);
      return code;
    }),
    searchFlights: jest.fn(),
  };
});

// Rail is dead (the production state, 2026-10-29): no train for any leg.
jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: jest.fn().mockResolvedValue([]),
}));

// Not what this file is about, and each builds or searches the whole location
// index: compareLeg asks destinationAirport about every city name on every
// leg (a fuzzy search for made-up names like these), which alone took
// minutes for this file. The made-up codes share no airport area.
jest.mock('../services/location/sameAirportArea', () => ({
  sameAirportArea: (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase(),
}));
jest.mock('../services/location/destinationAirport', () => ({
  resolveDestinationIata: () => null,
}));
jest.mock('../services/location/originAirports', () => ({
  resolveOriginAirports: () => ({ airports: [], placeId: null }),
}));

import { optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';
import { searchHotels } from '../services/hotels';
import { createFareModel, exhaustive, priceExactly, tripDates, type FareModel, type TripSpec } from './helpers/fareModel';

const mockedSearchFlights = searchFlights as jest.Mock;
const mockedHotels = searchHotels as jest.Mock;

/**
 * What one cold run may spend on inter-city searches (PLAN_SEARCH_BUDGET).
 * flights.ts dedupes identical searches (same route, date, party) for 10
 * minutes, so a repeat is free: count distinct ones.
 */
const INTER_CITY_BUDGET = 32;

type Search = { origin: string; destination: string; date: string; travelers: number };
let searched: Search[] = [];
const keyOf = (s: Search) => `${s.origin}>${s.destination}@${s.date}#${s.travelers}`;
const distinct = () => [...new Map(searched.map((s) => [keyOf(s), s])).values()];
const CITY_CODES = new Set(['ZQA', 'ZQB', 'ZQC', 'ZQD', 'ZQE']);
/** Searches between two trip cities: what PLAN_SEARCH_BUDGET counts. */
const interCity = () => distinct().filter((s) => CITY_CODES.has(s.origin) && CITY_CODES.has(s.destination));

function useFares(model: FareModel, extra?: (p: Search) => any[]) {
  mockedSearchFlights.mockImplementation(async (p: Search) => {
    searched.push(p);
    return [...model.offers(p), ...(extra?.(p) ?? [])];
  });
}

const FIVE = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];

function trip(cities: string[], origin: string, homeAirports: string[], totalNights = 12): TripSpec & { origin: string } {
  return { cities, origin, homeAirports, startDate: '2030-05-04', totalNights, returnToHome: true };
}

async function run(spec: TripSpec & { origin: string }, travelers = 4) {
  return optimize({
    cities: spec.cities.map((name) => ({ name })),
    startDate: spec.startDate,
    travelers,
    origin: spec.origin,
    originAirports: spec.homeAirports,
    returnToHome: spec.returnToHome,
    totalNights: spec.totalNights,
  });
}

const chicagoModel = (seed: number, swing = 0.3, travelers = 4) =>
  createFareModel({
    seed,
    swing,
    cityCodes: mockCodes,
    homeAirports: ['ORD', 'MDW'],
    metros: { CHI: ['ORD', 'MDW'] },
    travelers,
  });

beforeEach(() => {
  jest.clearAllMocks();
  searched = [];
});

describe('a cold 5-city optimize (Chicago, ORD + MDW)', () => {
  it(`sends at most ${INTER_CITY_BUDGET} inter-city searches and picks what pricing every ordering picks`, async () => {
    const spec = trip(FIVE, 'Chicago', ['ORD', 'MDW']);
    const model = chicagoModel(7);
    useFares(model);

    const result = await run(spec);

    const ranked = exhaustive(spec, model, mockCodes);
    expect(result.bestRoute.ordering).toEqual(ranked[0].ordering);
    expect(result.bestRoute.totalCost).toBeCloseTo(ranked[0].totalCost, 6);
    // Before: 80 inter-city legs + 20 home flights + the probe ≈ 116.
    expect(interCity().length).toBeLessThanOrEqual(INTER_CITY_BUDGET);
    // Home flights: both airports, every city, both ways.
    expect(distinct().length - interCity().length).toBe(2 * 5 * 2);
  }, 30000);

  it('prices the typed order exactly, so the saving compares two real routes', async () => {
    const spec = trip(FIVE, 'Chicago', ['ORD', 'MDW']);
    const model = chicagoModel(11);
    useFares(model);

    const result = await run(spec);

    const dates = tripDates(spec);
    const asked = new Set(distinct().map(keyOf));
    for (let i = 0; i < FIVE.length - 1; i++) {
      expect(asked).toContain(`${mockCodes[FIVE[i]]}>${mockCodes[FIVE[i + 1]]}@${dates.legs[i]}#4`);
    }
    // Against the winner it chose, priced exactly: under the plan's search
    // budget that need not be the exhaustive winner (optimizerSearchBudget).
    const naive = priceExactly(spec, model, mockCodes, FIVE);
    const chosen = priceExactly(spec, model, mockCodes, result.bestRoute.ordering);
    expect(result.bestRoute.totalCost).toBeCloseTo(chosen.totalCost, 6);
    expect(result.savingsVsNaive).toBeCloseTo(Math.max(0, naive.totalCost - chosen.totalCost), 6);
  }, 30000);

  it('returns only routes it priced exactly, best first', async () => {
    const spec = trip(FIVE, 'Chicago', ['ORD', 'MDW']);
    const model = chicagoModel(13);
    useFares(model);

    const result = await run(spec);

    const ranked = exhaustive(spec, model, mockCodes);
    expect(result.routes.length).toBeGreaterThanOrEqual(1);
    expect(result.routes.length).toBeLessThanOrEqual(3);
    result.routes.forEach((route, i) => {
      expect(route.ordering).toEqual(ranked[i].ordering);
      expect(route.totalCost).toBeCloseTo(ranked[i].totalCost, 6);
    });
    expect(result.bestRoute).toEqual(result.routes[0]);
  }, 30000);
});

describe('home flights: every airport, searched one by one, for every city and direction', () => {
  const homeOf = (codes: string[]) => distinct().filter((s) => codes.includes(s.origin) || codes.includes(s.destination));

  it('Chicago: ORD and MDW for every city both ways, never CHI, and the card is the cheapest of the two', async () => {
    const spec = trip(FIVE, 'Chicago', ['ORD', 'MDW']);
    const model = chicagoModel(17);
    useFares(model);

    const result = await run(spec);

    const dates = tripDates(spec);
    const home = homeOf(['CHI', 'ORD', 'MDW']);
    expect(home.map(keyOf).sort()).toEqual(
      ['ORD', 'MDW']
        .flatMap((a) => [
          ...FIVE.map((c) => `${a}>${mockCodes[c]}@${dates.outbound}#4`),
          ...FIVE.map((c) => `${mockCodes[c]}>${a}@${dates.ret}#4`),
        ])
        .sort(),
    );

    const best = exhaustive(spec, model, mockCodes)[0];
    expect(result.bestRoute.ordering).toEqual(best.ordering);
    expect(result.outboundLeg?.originAirport).toBe(best.outbound!.airport);
    expect(result.outboundLeg?.price).toBe(best.outbound!.price);
    expect(result.returnLeg?.destAirport).toBe(best.ret!.airport);
    expect(result.returnLeg?.price).toBe(best.ret!.price);
  }, 30000);

  it("London: only the traveller's airports are searched — an airport outside the list (LCY) is never used", async () => {
    const spec = trip(FIVE.slice(0, 4), 'London', ['LHR', 'LGW', 'STN'], 10);
    const model = createFareModel({
      seed: 19,
      swing: 0.3,
      cityCodes: mockCodes,
      homeAirports: ['LHR', 'LGW', 'STN', 'LCY', 'SEN', 'LTN'],
      metros: { LON: ['LHR', 'LGW', 'STN', 'LCY', 'SEN', 'LTN'] },
      travelers: 4,
    });
    useFares(model);

    const result = await run(spec);

    const listed = { ...spec, homeAirports: ['LHR', 'LGW', 'STN'] };
    const best = exhaustive(listed, model, mockCodes)[0];
    expect(result.bestRoute.ordering).toEqual(best.ordering);
    expect(result.outboundLeg?.price).toBe(best.outbound!.price);
    expect(result.returnLeg?.price).toBe(best.ret!.price);
    for (const leg of [result.outboundLeg, ...(result.outboundLeg?.alternatives ?? [])]) {
      expect(['LHR', 'LGW', 'STN']).toContain(leg?.originAirport);
    }
    for (const leg of [result.returnLeg, ...(result.returnLeg?.alternatives ?? [])]) {
      expect(['LHR', 'LGW', 'STN']).toContain(leg?.destAirport);
    }
    expect(homeOf(['LON', 'LCY', 'SEN', 'LTN'])).toEqual([]);
    expect(homeOf(['LHR', 'LGW', 'STN'])).toHaveLength(3 * 4 * 2);
  }, 30000);

  it('Washington: BWI, cheaper on every route, is ranked on — the winner is what pricing every ordering from all three airports picks', async () => {
    // Measured on Duffel, 2026-11-02: a WAS search to Paris answered for IAD
    // and DCA only, while BWI searched alone was cheaper ($474.26 vs $480.40).
    // Ranking reads every airport now, so a cheaper airport can change which
    // city goes first or last — not just the card.
    const spec = trip(FIVE.slice(0, 4), 'Washington', ['IAD', 'DCA', 'BWI'], 10);
    const model = createFareModel({
      seed: 29,
      swing: 0.3,
      cityCodes: mockCodes,
      homeAirports: ['IAD', 'DCA', 'BWI'],
      metros: { WAS: ['IAD', 'DCA', 'BWI'] },
      travelers: 4,
    });
    const bwiFare = (f: number | null) => (f === null ? null : Math.round(f * 0.7 * 100) / 100);
    mockedSearchFlights.mockImplementation(async (p: Search) => {
      searched.push(p);
      const offers = model.offers(p);
      return [p.origin, p.destination].includes('BWI') ? offers.map((o) => ({ ...o, price: bwiFare(o.price)! })) : offers;
    });
    const real = {
      ...model,
      fare: (o: string, d: string, date: string) => {
        const f = model.fare(o, d, date);
        return o === 'BWI' || d === 'BWI' ? bwiFare(f) : f;
      },
    };

    const result = await run(spec);

    const best = exhaustive(spec, real, mockCodes)[0];
    expect(result.bestRoute.ordering).toEqual(best.ordering);
    expect(result.outboundLeg).toMatchObject({ originAirport: 'BWI', price: best.outbound!.price });
    expect(result.returnLeg).toMatchObject({ destAirport: 'BWI', price: best.ret!.price });
    expect(homeOf(['WAS'])).toEqual([]);
    expect(homeOf(['BWI'])).toHaveLength(4 * 2);
  }, 30000);

  it('Boston (BOS + PVD): both airports for every city and direction', async () => {
    const spec = trip(FIVE.slice(0, 4), 'Boston', ['BOS', 'PVD'], 10);
    const model = createFareModel({ seed: 23, swing: 0.3, cityCodes: mockCodes, homeAirports: ['BOS', 'PVD'], travelers: 4 });
    useFares(model);

    const result = await run(spec);

    expect(homeOf(['BOS'])).toHaveLength(4 * 2);
    expect(homeOf(['PVD'])).toHaveLength(4 * 2);
    const best = exhaustive(spec, model, mockCodes)[0];
    expect(result.bestRoute.ordering).toEqual(best.ordering);
    expect(result.outboundLeg?.originAirport).toBe(best.outbound!.airport);
    expect(result.outboundLeg?.price).toBe(best.outbound!.price);
    expect(result.returnLeg?.destAirport).toBe(best.ret!.airport);
    expect(result.returnLeg?.price).toBe(best.ret!.price);
  }, 30000);
});

describe('an unavailable leg never wins', () => {
  it('a route with no flight on any date', async () => {
    const spec = trip(FIVE, 'Chicago', ['ORD', 'MDW']);
    const unrestricted = exhaustive(spec, chicagoModel(29), mockCodes)[0].ordering;
    // Take away the would-be winner's first two legs.
    const noFlights = new Set([0, 1].map((i) => `${mockCodes[unrestricted[i]]}>${mockCodes[unrestricted[i + 1]]}`));
    const model = createFareModel({ seed: 29, swing: 0.3, cityCodes: mockCodes, homeAirports: ['ORD', 'MDW'], metros: { CHI: ['ORD', 'MDW'] }, travelers: 4, noFlights });
    useFares(model);

    const result = await run(spec);

    expect(result.bestRoute.legs.every((leg) => leg.cost !== Infinity)).toBe(true);
    expect(result.bestRoute.ordering).toEqual(exhaustive(spec, model, mockCodes)[0].ordering);
  }, 30000);

  it('a route that flies on other dates but not on the day this ordering needs it', async () => {
    const spec = trip(FIVE, 'Chicago', ['ORD', 'MDW']);
    const dates = tripDates(spec);
    const unrestricted = exhaustive(spec, chicagoModel(31), mockCodes)[0].ordering;
    const noFlightsOn = new Set(
      [0, 1, 2, 3].map((i) => `${mockCodes[unrestricted[i]]}>${mockCodes[unrestricted[i + 1]]}@${dates.legs[i]}`),
    );
    const model = createFareModel({ seed: 31, swing: 0.3, cityCodes: mockCodes, homeAirports: ['ORD', 'MDW'], metros: { CHI: ['ORD', 'MDW'] }, travelers: 4, noFlightsOn });
    useFares(model);

    const result = await run(spec);

    expect(result.bestRoute.legs.every((leg) => leg.cost !== Infinity)).toBe(true);
    expect(result.bestRoute.ordering).not.toEqual(unrestricted);
    expect(result.bestRoute.ordering).toEqual(exhaustive(spec, model, mockCodes)[0].ordering);
  }, 30000);
});

describe('a route that does not fly every day', () => {
  it("is not written off when the screen priced it on a day it does not fly", async () => {
    const spec = trip(FIVE, 'Chicago', ['ORD', 'MDW']);
    const dates = tripDates(spec);
    const base = chicagoModel(41);
    const winner = exhaustive(spec, base, mockCodes)[0].ordering;

    // Which day did the screen price each of the winner's legs on? (It picks
    // days from the home flights alone, so the fares below do not move it.)
    useFares(base);
    await run(spec);
    const firstDay = (from: string, to: string) =>
      searched.find((s) => s.origin === from && s.destination === to)?.date;
    const k = winner
      .slice(0, -1)
      .findIndex((c, i) => firstDay(mockCodes[c], mockCodes[winner[i + 1]]) !== dates.legs[i]);
    expect(k).toBeGreaterThanOrEqual(0);

    // That leg's route now flies ONLY on the day the winner needs it.
    const [from, to] = [mockCodes[winner[k]], mockCodes[winner[k + 1]]];
    const onlyThatDay = (o: string, d: string, date: string) => o !== from || d !== to || date === dates.legs[k];
    const model: FareModel = {
      fare: (o, d, date) => (onlyThatDay(o, d, date) ? base.fare(o, d, date) : null),
      offers: (p) => (onlyThatDay(p.origin, p.destination, p.date) ? base.offers(p) : []),
    };
    searched = [];
    useFares(model);

    const result = await run(spec);

    // Assumed dead after one empty day, the route's orderings were never
    // explored and a dearer winner came back.
    expect(exhaustive(spec, model, mockCodes)[0].ordering).toEqual(winner);
    expect(result.bestRoute.ordering).toEqual(winner);
  }, 30000);
});

describe('4+ cities: no date-shift probe', () => {
  it.each([[4], [5]])('%i cities: every search is on a date the trip travels, and no price claim', async (n) => {
    const spec = trip(FIVE.slice(0, n), 'Chicago', ['ORD', 'MDW'], 2 * n);
    useFares(chicagoModel(37));

    const result = await run(spec);

    const dates = tripDates(spec);
    const planDates = new Set([dates.outbound, ...dates.legs, dates.ret]);
    expect(distinct().filter((s) => !planDates.has(s.date))).toEqual([]);
    expect(result.dateShiftSuggestion).toBeUndefined();
    expect(result.dateShiftChecked).toBe(false);
    expect(mockedHotels).not.toHaveBeenCalled();
  }, 30000);
});

describe('quality gate, CI-sized: the winner pricing every ordering finds, or within 3% of it', () => {
  // The full gate (thousands of trials, ±30% and ±50%, 2- and 3-airport
  // metros) is backend/scripts/opt-speed/; this keeps a slice of it in CI.
  it.each([[4], [5]])('%i cities, ±30% date swing, 12 random trips', async (n) => {
    let totalSearches = 0;
    let different = 0;
    for (let seed = 100; seed < 112; seed++) {
      searched = [];
      const spec = trip(FIVE.slice(0, n), 'Chicago', ['ORD', 'MDW'], 2 * n + 2);
      const model = chicagoModel(seed);
      useFares(model);

      const result = await run(spec);

      const best = exhaustive(spec, model, mockCodes)[0];
      const chosen = priceExactly(spec, model, mockCodes, result.bestRoute.ordering);
      // Under the search budget a 5-city plan may stop before it can prove
      // its winner (gate: ~2% of ±30% plans pick another, the worst ~4-5%
      // dearer); 4 cities never do.
      if (result.bestRoute.ordering.join('|') !== best.ordering.join('|')) different++;
      expect(chosen.rankCost).toBeLessThanOrEqual(best.rankCost * 1.03);
      expect(result.outboundLeg?.originAirport).toBe(chosen.outbound!.airport);
      expect(result.returnLeg?.destAirport).toBe(chosen.ret!.airport);
      totalSearches += interCity().length;
      // Inter-city searches inside one Duffel window (PLAN_SEARCH_BUDGET).
      expect(interCity().length).toBeLessThanOrEqual(INTER_CITY_BUDGET);
    }
    // Before: 4 cities 36 inter-city (+ probe), 5 cities 80 (+ probe). 5
    // cities now spend most of the budget on purpose: whole orderings, six
    // legs a round, in at most two rounds.
    if (n === 4) expect(totalSearches / 12).toBeLessThan(20);
    expect(different).toBeLessThanOrEqual(n === 4 ? 0 : 1);
  }, 30000);
});
