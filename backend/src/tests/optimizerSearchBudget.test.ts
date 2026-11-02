/**
 * A cold 4-5 city plan fits in ONE Duffel rate-limit window on production's
 * TEST token, not just on the fare model the screen was tuned on.
 *
 * Production, 2026-11-02 (Porto, Seville, Valencia, Marseille, Turin from
 * Chicago ORD + MDW): 79 Duffel requests — home 26, screen 20, exact 33 over
 * 25 rounds — and 54-89 s cold. Duffel accepts ~45 a minute per token, so
 * every such plan stalled for most of a window. Two things the harness had
 * not modelled:
 *  - a CHI search in test mode answers only test-airline placeholders under
 *    "CHI" itself, so every city and direction fell back to ORD and MDW one
 *    by one (10 + 16 home searches instead of 10);
 *  - test-mode fares swing far more than ±30% between dates, so the screen's
 *    bound rarely closed and best-first ran its 24 rounds plus a sweep, one
 *    Duffel round trip each.
 *
 * Now: home flights are ranked on ONE search per city and direction (the
 * traveller's first airport in test mode; the metro code in live mode), the
 * winner's own home flights search their remaining airports, best-first
 * prices up to 6 legs per round, and it stops at a hard request budget with
 * the best ordering it has fully priced.
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

/** One Duffel window is ~45 requests; the plan's own budget leaves margin. */
const BUDGET = 42;

type Search = { origin: string; destination: string; date: string; travelers: number };
let searched: Search[] = [];
const keyOf = (s: Search) => `${s.origin}>${s.destination}@${s.date}#${s.travelers}`;
const distinct = () => [...new Map(searched.map((s) => [keyOf(s), s])).values()];
const ledger = () => mockedInfo.mock.calls.find(([m]) => m === 'Optimize flight searches')?.[1] as any;

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

describe('a cold 5-city plan on the test token fits one window', () => {
  it.each([['CHI'], ['NYC']] as const)('from %s: at most 42 Duffel searches, every seed', async (home) => {
    for (let seed = 1; seed <= 8; seed++) {
      searched = [];
      mockedInfo.mockClear();
      useFares(testModeModel(seed, home));

      await run(spec(5, home));

      // Before: 10 metro placeholders + 20-30 per-airport fallbacks + 20
      // screen + exact ≈ 55-60 (production: 79).
      expect(distinct().length).toBeLessThanOrEqual(BUDGET);
      expect(ledger().searches).toBe(distinct().length);
    }
  }, 30000);

  it('never searches the metro code on the test token: it only answers placeholders', async () => {
    useFares(testModeModel(3, 'CHI'));

    await run(spec(5, 'CHI'));

    expect(distinct().filter((s) => s.origin === 'CHI' || s.destination === 'CHI')).toEqual([]);
  }, 30000);
});

describe("home flights: ranked on the first airport, the winner's searched on the rest", () => {
  it('ranking asks ORD once per city and direction; MDW only for the winner, and the card is the cheapest real fare', async () => {
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
    const home = distinct().filter((x) => [x.origin, x.destination].some((c) => ['ORD', 'MDW', 'CHI'].includes(c)));
    const ord = home.filter((x) => x.origin === 'ORD' || x.destination === 'ORD');
    expect(ord.map(keyOf).sort()).toEqual(
      [...FIVE.map((c) => `ORD>${mockCodes[c]}@${dates.outbound}#4`), ...FIVE.map((c) => `${mockCodes[c]}>ORD@${dates.ret}#4`)].sort(),
    );
    const [first, last] = [result.bestRoute.ordering[0], result.bestRoute.ordering[4]];
    expect(home.filter((x) => !ord.includes(x)).map(keyOf).sort()).toEqual(
      [`MDW>${mockCodes[first]}@${dates.outbound}#4`, `${mockCodes[last]}>MDW@${dates.ret}#4`].sort(),
    );
    // The $10 test airline never wins over a real fare.
    const exact = priceExactly(s, model, mockCodes, result.bestRoute.ordering);
    expect(result.outboundLeg).toMatchObject({ originAirport: 'ORD', price: exact.outbound!.price });
    expect(result.returnLeg).toMatchObject({ destAirport: 'ORD', price: exact.ret!.price });
    expect(result.outboundLeg?.operator).not.toBe('Duffel Airways');
  }, 30000);

  it("a real fare at the winner's other airports is found: NYC, EWR cheaper than JFK", async () => {
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
    // JFK for ranking (10), LGA and EWR for the winner's two flights (4).
    const home = distinct().filter((x) => [x.origin, x.destination].some((c) => ['JFK', 'LGA', 'EWR', 'NYC'].includes(c)));
    expect(home).toHaveLength(10 + 4);
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
      expect(distinct().length).toBeLessThanOrEqual(BUDGET);
    }
    expect(stops).toBeGreaterThan(0);
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
      expect(distinct().length).toBeLessThanOrEqual(BUDGET);
    }
  }, 30000);
});
