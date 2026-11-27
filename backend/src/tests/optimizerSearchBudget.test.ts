/**
 * A cold 4-5 city plan: every home airport compared, and the inter-city
 * searches within ONE Duffel window — on production's TEST token, not just on
 * the fare model the screen was tuned on.
 *
 * Production, 2026-11-02 (Porto, Seville, Valencia, Marseille, Turin from
 * Chicago ORD + MDW): 79 Duffel requests — home 26, screen 20, exact 33 over
 * 25 rounds — and 54-89 s cold. Test-mode fares swing far more than ±30%
 * between dates, so the screen's bound rarely closed and best-first ran its
 * 24 rounds plus a sweep, one Duffel round trip each.
 *
 * Duffel's window is 30 requests a wall-clock minute per token (its own
 * headers, 2026-11-24). Now (exp/optimizer-speed, owner's rules 2026-11-27):
 *  - home flights are ranked on EVERY one of the traveller's airports, each
 *    searched for every city and direction (2 × cities × airports), never on
 *    the first airport alone or a metro code — and the planner pre-searches
 *    them during the chat;
 *  - best-first prices up to 6 legs per round and stops at PLAN_SEARCH_BUDGET
 *    inter-city searches (screen + best-first): 32, never less exploration
 *    than before; flights.ts paces the window from Duffel's headers.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'duffel_test_jest',
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
  'New York': 'NYC',
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
jest.mock('../services/trains', () => ({ searchTrains: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: jest.fn().mockResolvedValue([]),
}));
// Not what this file is about, and each builds or searches the whole location
// index (see optimizerAdaptiveScreen.test.ts). The made-up codes share no area.
jest.mock('../services/location/sameAirportArea', () => ({
  sameAirportArea: (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase(),
}));
jest.mock('../services/location/destinationAirport', () => ({ resolveDestinationIata: () => null }));
jest.mock('../services/location/originAirports', () => ({
  resolveOriginAirports: () => ({ airports: [], placeId: null }),
}));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { env } from '../config/env';
import { optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';
import { logger } from '../utils/logger';
import { createFareModel, exhaustive, priceExactly, tripDates, type FareModel, type FareModelOptions, type TripSpec } from './helpers/fareModel';

const mockedSearch = searchFlights as jest.Mock;
const mockedInfo = logger.info as jest.Mock;

/** Inter-city searches (screen + best-first) one plan may send (PLAN_SEARCH_BUDGET). */
const BUDGET = 32;

type Search = { origin: string; destination: string; date: string; travelers: number };
let searched: Search[] = [];
const keyOf = (s: Search) => `${s.origin}>${s.destination}@${s.date}#${s.travelers}`;
const distinct = () => [...new Map(searched.map((s) => [keyOf(s), s])).values()];
const ledger = () => mockedInfo.mock.calls.find(([m]) => m === 'Optimize flight searches')?.[1] as any;
const HOME_CODES = ['ORD', 'MDW', 'CHI', 'JFK', 'LGA', 'EWR', 'NYC'];
const isHome = (x: Search) => HOME_CODES.includes(x.origin) || HOME_CODES.includes(x.destination);
/** The plan's inter-city searches: what PLAN_SEARCH_BUDGET counts. */
const interCity = () => distinct().filter((x) => !isHome(x));

function useFares(model: FareModel) {
  mockedSearch.mockImplementation(async (p: Search) => {
    searched.push(p);
    return model.offers(p);
  });
}

const FIVE = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
const HOMES = {
  CHI: { origin: 'Chicago', airports: ['ORD', 'MDW'], metro: 'CHI', testOnly: ['MDW'] },
  NYC: { origin: 'New York', airports: ['JFK', 'LGA', 'EWR'], metro: 'NYC', testOnly: ['LGA'] },
} as const;
type Home = keyof typeof HOMES;

function spec(n: number, home: Home): TripSpec & { origin: string } {
  return {
    cities: FIVE.slice(0, n),
    origin: HOMES[home].origin,
    homeAirports: [...HOMES[home].airports],
    startDate: '2030-05-04',
    totalNights: n === 5 ? 12 : 10,
    returnToHome: true,
  };
}

/**
 * Production's test token, as measured: fares swing ±60-80% by date, an
 * inter-city hop prices like a transatlantic one (sandbox fares are not
 * distance-based), the metro code answers placeholders only, and MDW / LGA
 * have only the test airline.
 */
function testModeModel(seed: number, home: Home, extra: Partial<FareModelOptions> = {}): FareModel {
  const h = HOMES[home];
  return createFareModel({
    seed,
    swing: 0.7,
    swingRange: [0.6, 0.8],
    legRange: [600, 1100],
    homeRange: [600, 1100],
    cityCodes: mockCodes,
    homeAirports: [...h.airports],
    metros: { [h.metro]: [...h.airports] },
    placeholderMetros: [h.metro],
    testAirlineOnly: [...h.testOnly],
    travelers: 4,
    ...extra,
  });
}

async function run(s: TripSpec & { origin: string }) {
  return optimize({
    cities: s.cities.map((name) => ({ name })),
    startDate: s.startDate,
    travelers: 4,
    origin: s.origin,
    originAirports: s.homeAirports,
    returnToHome: true,
    totalNights: s.totalNights,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  searched = [];
  (env as any).DUFFEL_ACCESS_TOKEN = 'duffel_test_jest';
});

describe('a cold 5-city plan on the test token: every home airport, inter-city within one window', () => {
  it.each([['CHI'], ['NYC']] as const)('from %s: home flights from every airport, at most 32 inter-city searches, every seed', async (home) => {
    const airports = HOMES[home].airports.length;
    for (let seed = 1; seed <= 8; seed++) {
      searched = [];
      mockedInfo.mockClear();
      useFares(testModeModel(seed, home));

      await run(spec(5, home));

      // Every city, both directions, every airport: 2 × 5 × airports.
      expect(distinct().filter(isHome)).toHaveLength(2 * 5 * airports);
      expect(interCity().length).toBeLessThanOrEqual(BUDGET);
      expect(ledger().searches).toBe(distinct().length);
    }
  }, 30000);

  it('never searches the metro code: on the test token it only answers placeholders, and live it can leave an airport out', async () => {
    useFares(testModeModel(3, 'CHI'));

    await run(spec(5, 'CHI'));

    expect(distinct().filter((s) => s.origin === 'CHI' || s.destination === 'CHI')).toEqual([]);
  }, 30000);
});

describe('home flights: every airport ranked, and the card is the cheapest real fare', () => {
  it('ORD and MDW are both searched for every city and direction; the $10 test airline at MDW never wins', async () => {
    // MDW: the test airline only, and always cheaper than ORD.
    const s = spec(5, 'CHI');
    const model = testModeModel(5, 'CHI', { swingRange: undefined, swing: 0.3, legRange: [50, 225] });
    const cheapTestAirline: FareModel = {
      ...model,
      offers: (p) =>
        model.offers(p).map((o) => (o.originAirport === 'MDW' || o.destinationAirport === 'MDW' ? { ...o, price: 10 } : o)),
    };
    useFares(cheapTestAirline);

    const result = await run(s);

    const dates = tripDates(s);
    const home = distinct().filter(isHome);
    for (const airport of ['ORD', 'MDW']) {
      expect(home.filter((x) => x.origin === airport || x.destination === airport).map(keyOf).sort()).toEqual(
        [
          ...FIVE.map((c) => `${airport}>${mockCodes[c]}@${dates.outbound}#4`),
          ...FIVE.map((c) => `${mockCodes[c]}>${airport}@${dates.ret}#4`),
        ].sort(),
      );
    }
    const exact = priceExactly(s, model, mockCodes, result.bestRoute.ordering);
    expect(result.outboundLeg).toMatchObject({ originAirport: 'ORD', price: exact.outbound!.price });
    expect(result.returnLeg).toMatchObject({ destAirport: 'ORD', price: exact.ret!.price });
    expect(result.outboundLeg?.operator).not.toBe('Duffel Airways');
  }, 30000);

  it('EWR cheaper than JFK: ranking sees it, and the winner flies from it — no searches beyond the 30 home ones', async () => {
    const s = spec(5, 'NYC');
    // Every airport real (no test airline), EWR a quarter of the model, so always the cheapest.
    const base = createFareModel({
      seed: 9,
      swing: 0.3,
      cityCodes: mockCodes,
      homeAirports: ['JFK', 'LGA', 'EWR'],
      metros: { NYC: ['JFK', 'LGA', 'EWR'] },
      placeholderMetros: ['NYC'],
      travelers: 4,
    });
    const ewr = (f: number | null) => (f === null ? null : Math.round(f * 0.25 * 100) / 100);
    const model: FareModel = {
      fare: (o, d, date) => ([o, d].includes('EWR') ? ewr(base.fare(o, d, date)) : base.fare(o, d, date)),
      offers: (p) => base.offers(p).map((o) => ([o.originAirport, o.destinationAirport].includes('EWR') ? { ...o, price: ewr(o.price)! } : o)),
    };
    useFares(model);

    const result = await run(s);

    const exact = priceExactly(s, model, mockCodes, result.bestRoute.ordering);
    expect(exact.outbound!.airport).toBe('EWR');
    expect(result.outboundLeg).toMatchObject({ originAirport: 'EWR', price: exact.outbound!.price });
    expect(result.returnLeg).toMatchObject({ destAirport: exact.ret!.airport, price: exact.ret!.price });
    expect(distinct().filter(isHome)).toHaveLength(30);
  }, 30000);
});

describe('a first airport with only the test airline', () => {
  it('every airport is ranked anyway, and the card is the real fare', async () => {
    const s = { ...spec(5, 'CHI'), homeAirports: ['MDW', 'ORD'] };
    const model = testModeModel(21, 'CHI');
    useFares(model);

    const result = await run(s);

    const home = distinct().filter(isHome);
    expect(home.filter((x) => x.origin === 'MDW' || x.destination === 'MDW')).toHaveLength(10);
    expect(home.filter((x) => x.origin === 'ORD' || x.destination === 'ORD')).toHaveLength(10);
    expect(home).toHaveLength(20);
    const exact = priceExactly(s, model, mockCodes, result.bestRoute.ordering);
    expect(result.outboundLeg).toMatchObject({ originAirport: 'ORD', price: exact.outbound!.price });
    expect(result.returnLeg).toMatchObject({ destAirport: 'ORD', price: exact.ret!.price });
    expect(interCity().length).toBeLessThanOrEqual(BUDGET);
  }, 30000);
});

describe('best-first under the budget', () => {
  it('a round prices several legs at once, so a 5-city plan takes few rounds', async () => {
    (env as any).DUFFEL_ACCESS_TOKEN = 'duffel_live_jest';
    let rounds = 0;
    let exactSearches = 0;
    for (let seed = 200; seed < 208; seed++) {
      searched = [];
      mockedInfo.mockClear();
      useFares(
        createFareModel({ seed, swing: 0.3, cityCodes: mockCodes, homeAirports: ['ORD', 'MDW'], metros: { CHI: ['ORD', 'MDW'] }, travelers: 4 }),
      );

      await run(spec(5, 'CHI'));

      rounds += ledger().exactRounds;
      exactSearches += ledger().byPhase.exact ?? 0;
      expect(ledger().exactRounds).toBeLessThanOrEqual(4);
    }
    // Before: one leg a round, 7-8 rounds on average (gate, 2026-11-02).
    expect(exactSearches).toBeGreaterThan(rounds);
  }, 30000);

  it('stops at the budget with an ordering it priced in full, and the typed order still priced exactly', async () => {
    let stops = 0;
    for (let seed = 1; seed <= 12; seed++) {
      searched = [];
      mockedInfo.mockClear();
      const s = spec(5, 'CHI');
      const model = testModeModel(seed, 'CHI');
      useFares(model);

      const result = await run(s);

      if (!ledger().budgetStop) continue;
      stops++;
      const dates = tripDates(s);
      const asked = new Set(distinct().map(keyOf));
      const legOnItsDay = (o: string[], i: number) => `${mockCodes[o[i]]}>${mockCodes[o[i + 1]]}@${dates.legs[i]}#4`;
      // The winner: every leg searched on the day it is flown, its total the exact one.
      const best = result.bestRoute.ordering;
      for (let i = 0; i < 4; i++) expect(asked).toContain(legOnItsDay(best, i));
      expect(result.bestRoute.totalCost).toBeCloseTo(priceExactly(s, model, mockCodes, best).totalCost, 6);
      expect(result.routes).toHaveLength(1);
      // The typed order too, so the saving compares two real routes.
      for (let i = 0; i < 4; i++) expect(asked).toContain(legOnItsDay(FIVE, i));
      const typed = priceExactly(s, model, mockCodes, FIVE);
      const chosen = priceExactly(s, model, mockCodes, best);
      expect(result.savingsVsNaive).toBeCloseTo(Math.max(0, typed.totalCost - chosen.totalCost), 6);
      // Never worse than the typed order.
      expect(chosen.rankCost).toBeLessThanOrEqual(typed.rankCost);
      expect(interCity().length).toBeLessThanOrEqual(BUDGET);
    }
    expect(stops).toBeGreaterThan(0);
  }, 30000);

  it('never stops on a leg nothing flies when an ordering that flies everywhere exists', async () => {
    // 5% of routes never fly and 5% of route-days are missing. A route with
    // nothing on the day it was screened is likely dead: spending the budget
    // completing orderings through it left 4.6% of such plans with a missing
    // leg (gate, 2026-11-02).
    (env as any).DUFFEL_ACCESS_TOKEN = 'duffel_live_jest';
    const pick = (seed: number, key: string) => {
      let h = 0x811c9dc5 ^ seed;
      for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
      return (h >>> 0) / 4294967296;
    };
    const codes = FIVE.map((c) => mockCodes[c]);
    let checked = 0;
    // Seeds 55, 90, 93, 117, 125 and 127 stopped on a missing leg before.
    for (let seed = 50; seed <= 130; seed++) {
      const noFlights = new Set<string>();
      const noFlightsOn = new Set<string>();
      for (const a of codes) for (const b of codes) {
        if (a === b) continue;
        if (pick(seed, `route|${a}>${b}`) < 0.05) noFlights.add(`${a}>${b}`);
        for (let d = 4; d < 24; d++) {
          const day = `2030-05-${String(d).padStart(2, '0')}`;
          if (pick(seed, `day|${a}>${b}@${day}`) < 0.05) noFlightsOn.add(`${a}>${b}@${day}`);
        }
      }
      if (noFlights.size === 0) continue;
      searched = [];
      mockedInfo.mockClear();
      const s = spec(5, 'CHI');
      const model = createFareModel({
        seed, swing: 0.3, cityCodes: mockCodes, homeAirports: ['ORD', 'MDW'], metros: { CHI: ['ORD', 'MDW'] }, travelers: 4, noFlights, noFlightsOn,
      });
      useFares(model);

      const result = await run(s);

      if (exhaustive(s, model, mockCodes)[0].unpricedLegs > 0) continue;
      checked++;
      expect(result.bestRoute.legs.every((leg) => leg.cost !== Infinity)).toBe(true);
      expect(interCity().length).toBeLessThanOrEqual(BUDGET);
    }
    expect(checked).toBeGreaterThan(15);
  }, 30000);

  it('when nothing stops it, the winner is still the one pricing every ordering finds (±30%, live)', async () => {
    (env as any).DUFFEL_ACCESS_TOKEN = 'duffel_live_jest';
    for (let seed = 300; seed < 306; seed++) {
      searched = [];
      mockedInfo.mockClear();
      const s = spec(5, 'NYC');
      const model = createFareModel({
        seed,
        swing: 0.3,
        cityCodes: mockCodes,
        homeAirports: ['JFK', 'LGA', 'EWR'],
        metros: { NYC: ['JFK', 'LGA', 'EWR'] },
        travelers: 4,
      });
      useFares(model);

      const result = await run(s);

      if (ledger().budgetStop) continue;
      expect(result.bestRoute.ordering).toEqual(exhaustive(s, model, mockCodes)[0].ordering);
      expect(interCity().length).toBeLessThanOrEqual(BUDGET);
    }
  }, 30000);
});
