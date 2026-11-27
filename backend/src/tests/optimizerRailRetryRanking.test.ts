/**
 * A rail answer that comes back empty the first time and with a train the
 * second (a cold All Aboard route: [ERROR, UPSTREAM_UNAVAILABLE], then fares)
 * must reach ranking on a 4-5 city trip, as it did before the rail board.
 *
 * The plan before the rail board (release/audit-fixes) priced legs inside
 * every best-first round: the screen read a pair's first rail answer, and a
 * round that re-priced the pair on another day asked All Aboard again — an
 * incomplete answer is not cached (trains.ts) — and got the train. The rail
 * board searches each pair once up front; ranking must still read the
 * pair's second answer when the first had no priced train, or the trip comes
 * out dearer than before (review of exp/optimizer-speed, 2026-11-27).
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
    for (const m of ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'order']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.upsert = jest.fn(() => Promise.resolve({ error: null }));
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return { getSupabase: () => ({ from: () => createChain() }) };
});

jest.mock('../services/flights', () => ({
  getIataCode: jest.fn(async (name: string) => name.slice(0, 3).toUpperCase()),
  searchFlights: jest.fn(),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn(),
}));

jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: jest.fn(async () => []),
}));

import { optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';
import { searchTrains } from '../services/trains';

const mockedFlights = searchFlights as jest.Mock;
const mockedTrains = searchTrains as jest.Mock;

const train = (origin: string, destination: string, date: string, price: number) => ({
  id: `t-${origin}-${destination}-${date}`,
  price,
  currency: 'USD',
  departure: `${date}T09:00:00`,
  arrival: `${date}T12:00:00`,
  durationMinutes: 180,
  operator: 'Rail',
  trainType: 'train',
  bookingUrl: null,
  limitedCoverage: false,
});

const flight = (origin: string, destination: string, date: string, price: number) => ({
  id: `f-${origin}-${destination}-${date}`,
  price,
  durationMinutes: 90,
  carrier: 'Air',
  carrierCode: 'AA',
  departure: `${date}T08:00:00`,
  arrival: `${date}T09:30:00`,
  currency: 'USD',
  stops: 0,
  bookingUrl: '',
  raw: {},
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('a 4-city trip whose cheap train answers only the second time', () => {
  it('ranks on that train: the winner is the trip with it, not a dearer one without', async () => {
    // Home flights cost the same to and from every city. Every inter-city
    // flight is $200, except Charlie -> Delta at $600, which has a $50 train
    // that All Aboard prices only on the route-day's second search.
    mockedFlights.mockImplementation(async ({ origin, destination, date }: any) => {
      await sleep(5);
      if (origin === 'HMA' || destination === 'HMA') return [flight(origin, destination, date, 400)];
      const fare: Record<string, number> = { 'ALP>BRA': 200, 'BRA>DEL': 200, 'DEL>CHA': 200, 'DEL>ALP': 200, 'CHA>DEL': 260 };
      return [flight(origin, destination, date, fare[`${origin}>${destination}`] ?? 500)];
    });
    const asked = new Map<string, number>();
    mockedTrains.mockImplementation(async (p: any) => {
      const key = `${p.origin}>${p.destination}@${p.date}`;
      const n = (asked.get(key) ?? 0) + 1;
      asked.set(key, n);
      await sleep(20);
      if (p.origin === 'Charlie' && p.destination === 'Delta' && n >= 2) return [train(p.origin, p.destination, p.date, 50)];
      return [];
    });

    const result = await optimize({
      cities: [{ name: 'Alpha' }, { name: 'Bravo' }, { name: 'Charlie' }, { name: 'Delta' }],
      startDate: '2030-03-08',
      travelers: 2,
      origin: 'Home',
      originAirports: ['HMA'],
      returnToHome: true,
      totalNights: 8,
    });

    const ordering = result.bestRoute.ordering;
    const i = ordering.indexOf('Charlie');
    // With the train: $50 + $200 + $200 between the cities, $800 home.
    expect(ordering[i + 1]).toBe('Delta');
    expect(result.bestRoute.totalCost).toBe(1250);
  }, 30000);
});
