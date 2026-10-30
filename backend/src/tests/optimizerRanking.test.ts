/**
 * Ranking honesty in optimize(): what an ordering is charged for a leg we
 * could not price, which home airports it is priced from, and when the
 * result may claim it "saved" money.
 *
 *   B3  A city with no airport got placed first or last, so the ordering
 *       simply dropped a home flight — and the dropped fare was reported as
 *       savings. NYC → Zurich, Interlaken, Geneva said "saved $480".
 *   B4  Home legs were ranked from originAirports[0] only, so the order of
 *       the airport list alone changed the chosen route and produced a
 *       false "saved $400".
 *
 * Duffel, Supabase and rail are mocked; nothing here touches the network.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
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

// Readable IATA: an explicit table, and a 404 for a city with no airport —
// the same AppError flights.ts throws when Duffel suggests nothing.
const mockIata: Record<string, string> = {
  Zurich: 'ZRH',
  Geneva: 'GVA',
  Paris: 'PAR',
  Rome: 'ROM',
  Alpha: 'ALP',
  Bravo: 'BRA',
};
jest.mock('../services/flights', () => {
  const { AppError } = jest.requireActual('../middleware/error');
  return {
    getIataCode: jest.fn(async (name: string) => {
      const code = mockIata[name];
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

import { optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';

const mockedSearchFlights = searchFlights as jest.Mock;

const offer = (price: number) => ({
  id: `f-${price}`,
  price,
  durationMinutes: 120,
  carrier: 'Test Air',
  carrierCode: 'TA',
  departure: '',
  arrival: '',
  currency: 'USD',
  stops: 0,
  bookingUrl: '',
  raw: {},
});

/** Fixed fare table keyed "ORIGIN>DEST" (any date); a missing key = no offers. */
function fares(table: Record<string, number>, byDate?: (o: string, d: string, date: string) => number | undefined) {
  mockedSearchFlights.mockImplementation(async ({ origin, destination, date }: any) => {
    const dated = byDate?.(origin, destination, date);
    if (dated !== undefined) return [offer(dated)];
    const p = table[`${origin}>${destination}`];
    return p === undefined ? [] : [offer(p)];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('B3 — a city with no airport must not cost the trip a home flight', () => {
  const SWISS = {
    'JFK>ZRH': 600,
    'JFK>GVA': 650,
    'ZRH>JFK': 550,
    'GVA>JFK': 580,
    'ZRH>GVA': 150,
    'GVA>ZRH': 150,
  };

  it('puts the airport-less city in the middle and keeps both home flights', async () => {
    fares(SWISS);

    const result = await optimize({
      cities: [{ name: 'Zurich' }, { name: 'Interlaken' }, { name: 'Geneva' }],
      startDate: '2030-12-08',
      travelers: 2,
      origin: 'New York',
      originAirports: ['JFK'],
      returnToHome: true,
      totalNights: 7,
    });

    // Interlaken first or last = no flight home→Interlaken (or back) exists,
    // and the old ranking scored that exactly like a missing train leg.
    expect(result.bestRoute.ordering[1]).toBe('Interlaken');
    expect(result.outboundLeg).not.toBeNull();
    expect(result.returnLeg).not.toBeNull();
  }, 30000);

  it('does the same for a synthetic no-airport town (independent of curated airports)', async () => {
    fares({ 'JFK>ALP': 400, 'JFK>BRA': 420, 'ALP>JFK': 380, 'BRA>JFK': 390, 'ALP>BRA': 90, 'BRA>ALP': 90 });

    const result = await optimize({
      cities: [{ name: 'Nowhereville' }, { name: 'Alpha' }, { name: 'Bravo' }],
      startDate: '2030-12-08',
      travelers: 1,
      origin: 'New York',
      originAirports: ['JFK'],
      returnToHome: true,
      totalNights: 6,
    });

    expect(result.bestRoute.ordering[1]).toBe('Nowhereville');
    expect(result.outboundLeg).not.toBeNull();
    expect(result.returnLeg).not.toBeNull();
  }, 30000);

  it.each([
    // The reported trip, in the order it was typed. Old answer: "saved $480"
    // — the winner had dropped its $600 outbound, the naive route had not.
    [['Zurich', 'Interlaken', 'Geneva']],
    // Typed Interlaken-first, so the NAIVE route lacks the outbound. Old
    // answer: "saved $30", a difference between two different sets of legs.
    [['Interlaken', 'Zurich', 'Geneva']],
  ])('claims no saving unless both compared routes are fully priced (%j)', async (names) => {
    fares(SWISS);

    const result = await optimize({
      cities: names.map((name) => ({ name })),
      startDate: '2030-12-08',
      travelers: 2,
      origin: 'New York',
      originAirports: ['JFK'],
      returnToHome: true,
      totalNights: 7,
    });

    expect(result.savingsVsNaive).toBe(0);
  }, 30000);
});
describe('B4 — home legs are ranked by the cheapest of the searched airports', () => {
  // JFK is the dearest way into Paris, EWR the cheapest.
  const NYC = {
    'JFK>PAR': 900,
    'EWR>PAR': 300,
    'JFK>ROM': 500,
    'EWR>ROM': 600,
    'PAR>ROM': 100,
    'ROM>PAR': 100,
    'PAR>JFK': 500,
    'PAR>EWR': 500,
    'ROM>JFK': 500,
    'ROM>EWR': 500,
  };
  const trip = (originAirports: string[]) => ({
    cities: [{ name: 'Paris' }, { name: 'Rome' }],
    startDate: '2030-12-08',
    travelers: 1,
    origin: 'New York',
    originAirports,
    returnToHome: true,
    totalNights: 6,
  });

  it.each([[['JFK', 'EWR']], [['EWR', 'JFK']]])(
    'picks the truly cheapest route whatever the airport order (%j)',
    async (airports) => {
      fares(NYC);
      const result = await optimize(trip(airports));

      // EWR→Paris 300 + Paris→Rome 100 + Rome→home 500 = 900.
      // Ranked from JFK alone, Rome-first (500+100+500 = 1100) used to win.
      expect(result.bestRoute.ordering).toEqual(['Paris', 'Rome']);
      expect(result.bestRoute.totalCost).toBe(900);
      // The naive order IS the best one: nothing was saved.
      expect(result.savingsVsNaive).toBe(0);
    },
    30000,
  );

  it('ranks with the same fares the built home legs show', async () => {
    fares(NYC);
    const result = await optimize(trip(['JFK', 'EWR']));

    const legsTotal = result.bestRoute.legs.reduce((s, l) => s + l.cost, 0);
    expect(result.outboundLeg?.originAirport).toBe('EWR');
    expect(result.bestRoute.totalCost).toBe(
      legsTotal + (result.outboundLeg?.price ?? 0) + (result.returnLeg?.price ?? 0),
    );
  }, 30000);

  it('never offers a date shift that only beats the airport we were not going to use', async () => {
    // On the requested date EWR (300) already beats JFK (600) into Paris.
    // Two days earlier JFK drops to 250 and EWR rises to 400. Probing from
    // JFK alone used to report "save $350" (600 → 250) on a trip that was
    // already flying EWR at 300 — the real best saving is $50.
    fares(
      { 'PAR>JFK': 500, 'PAR>EWR': 500 },
      (o, d, date) => {
        if (d !== 'PAR') return undefined;
        const early = date === '2030-12-06';
        if (o === 'JFK') return early ? 250 : 600;
        if (o === 'EWR') return early ? 400 : 300;
        return undefined;
      },
    );

    const result = await optimize({
      cities: [{ name: 'Paris' }],
      startDate: '2030-12-08',
      travelers: 1,
      origin: 'New York',
      originAirports: ['JFK', 'EWR'],
      returnToHome: true,
      totalNights: 4,
    });

    expect(result.bestRoute.totalCost).toBe(800); // EWR 300 + 500 home
    for (const option of result.dateShiftSuggestion?.options ?? []) {
      expect(option.savings).toBeLessThanOrEqual(50);
    }
  }, 30000);
});
