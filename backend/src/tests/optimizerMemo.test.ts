/**
 * B8 — one optimize() asks for each leg once.
 *
 * Every candidate ordering re-asks for the legs it shares with the others.
 * Measured on a 5-city trip: 480 compareLeg calls for 80 distinct legs,
 * 992 Supabase reads and 496 leg_price_cache upserts — while Duffel itself
 * was already deduped by flights.ts. getIataCode ran a db lookup per call
 * for every city without a curated airport. Memoised per run now.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

// Records every Supabase call as "table:op".
const mockSupabaseCalls: string[] = [];
jest.mock('../services/supabase', () => {
  const createChain = (table: string): any => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'order']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.select = jest.fn(() => {
      mockSupabaseCalls.push(`${table}:select`);
      return chain;
    });
    chain.upsert = jest.fn(() => {
      mockSupabaseCalls.push(`${table}:upsert`);
      return Promise.resolve({ data: null, error: null });
    });
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return { getSupabase: () => ({ from: (table: string) => createChain(table) }) };
});

jest.mock('../services/flights', () => ({
  getIataCode: jest.fn(async (name: string) => name.slice(0, 3).toUpperCase()),
  searchFlights: jest.fn(),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

import { optimize } from '../services/optimizer';
import { getIataCode, searchFlights } from '../services/flights';
import { searchTrains } from '../services/trains';

const mockedSearchFlights = searchFlights as jest.Mock;
const mockedGetIataCode = getIataCode as jest.Mock;
const mockedSearchTrains = searchTrains as jest.Mock;

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

beforeEach(() => {
  jest.clearAllMocks();
  mockSupabaseCalls.length = 0;
  // Distinct-but-deterministic prices so the ranking is not a 120-way tie.
  mockedSearchFlights.mockImplementation(async ({ origin, destination }: any) => [
    offer(100 + ((origin.charCodeAt(0) * 7 + destination.charCodeAt(1) * 13) % 200)),
  ]);
});

const FIVE = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];

describe('B8 — per-run memo of legs and IATA codes', () => {
  it('prices each distinct leg once on a 5-city trip (was 480 compareLeg calls for 80 legs)', async () => {
    await optimize({
      cities: FIVE.map((name) => ({ name })),
      startDate: '2030-06-01',
      travelers: 1,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: true,
      totalNights: 10,
    });

    // 20 ordered pairs × 4 positions (dates) = 80 distinct scoring legs,
    // plus the date-shift probe's 4 offsets × 4 legs of the winner.
    const DISTINCT_LEGS = 80 + 4 * 4;
    const legReads = mockSupabaseCalls.filter((c) => c === 'leg_price_cache:select').length;
    const legWrites = mockSupabaseCalls.filter((c) => c === 'leg_price_cache:upsert').length;
    // Two cache reads (flight, train) per compareLeg; one upsert per leg.
    expect(legReads).toBeLessThanOrEqual(2 * DISTINCT_LEGS);
    expect(legWrites).toBeLessThanOrEqual(DISTINCT_LEGS);
    // One rail search per distinct leg from compareLeg (enrichment adds the
    // winner's 4, deduped downstream by trains.ts).
    expect(mockedSearchTrains.mock.calls.length).toBeLessThanOrEqual(DISTINCT_LEGS + 4);
  }, 60000);

  it('resolves each city to an airport once per run', async () => {
    await optimize({
      cities: FIVE.map((name) => ({ name })),
      startDate: '2030-06-01',
      travelers: 1,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: true,
      totalNights: 10,
    });

    const perCity = new Map<string, number>();
    for (const [name] of mockedGetIataCode.mock.calls) perCity.set(name, (perCity.get(name) ?? 0) + 1);
    // Step 1 resolves every city; legOptions (enrichment, outside this
    // file's reach) asks again for the winner's cities. Nothing more.
    for (const name of FIVE) expect(perCity.get(name) ?? 0).toBeLessThanOrEqual(3);
  }, 60000);

  it('still prices legs by date — a memo must not merge two travel days', async () => {
    const result = await optimize({
      cities: [{ name: 'Alpha' }, { name: 'Bravo' }, { name: 'Charlie' }],
      startDate: '2030-06-01',
      travelers: 1,
      totalNights: 6,
    });
    const dates = new Set(mockedSearchFlights.mock.calls.map(([p]: any[]) => p.date));
    // Legs on day 2 and day 4, plus the date-shift offsets around them.
    expect(dates.has('2030-06-03')).toBe(true);
    expect(dates.has('2030-06-05')).toBe(true);
    expect(result.bestRoute.legs).toHaveLength(2);
  }, 60000);
});
