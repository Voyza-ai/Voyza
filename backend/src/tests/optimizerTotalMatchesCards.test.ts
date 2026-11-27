/**
 * The optimizer's total is the sum of the prices the trip shows.
 *
 * The results page builds each leg card from `leg.options[0]` and the home
 * cards from `outboundLeg` / `returnLeg` (PlanningChat buildTripFromOptimize).
 * Ranking's own numbers could differ from both, and bestRoute.totalCost kept
 * ranking's:
 *
 *  - The winner's legs are searched again for their alternatives, and that
 *    search can find the train an incomplete rail answer left out of ranking.
 *    Replayed on recorded answers (New York -> Paris, Berlin, Amsterdam,
 *    2027-01-12): the card showed a $87.70 Paris-Berlin train, totalCost held
 *    the $102.35 flight, $14.65 over the cards.
 *  - On 4+ cities ranking prices home flights on the first home airport, and
 *    the card shows the cheapest of all of them (same replay, 4 cities: JFK
 *    $492.68 in the total, EWR $489.94 on the card).
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

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const HOME = ['HMA', 'HMB'];

const flight = (origin: string, destination: string, date: string, price: number) => ({
  id: `f-${origin}-${destination}-${date}`,
  price,
  durationMinutes: 90,
  carrier: 'Air',
  carrierCode: 'AA',
  departure: `${date}T08:00:00`,
  arrival: `${date}T10:00:00`,
  currency: 'USD',
  stops: 0,
  bookingUrl: '',
  raw: {},
});

const train = (origin: string, destination: string, date: string, price: number) => ({
  id: `t-${origin}-${destination}-${date}`,
  price,
  currency: 'USD',
  departure: `${date}T09:00:00`,
  arrival: `${date}T13:00:00`,
  durationMinutes: 240,
  operator: 'ÖBB',
  trainType: 'Railjet',
  bookingUrl: null,
  limitedCoverage: false,
});

/** What the page shows: each leg's first option (or its ranked cost), plus the home cards. */
function shownTotal(result: Awaited<ReturnType<typeof optimize>>): number {
  const legs = result.bestRoute.legs.reduce((s, l) => s + (l.options?.[0]?.price ?? l.cost), 0);
  return legs + (result.outboundLeg?.price ?? 0) + (result.returnLeg?.price ?? 0);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedFlights.mockImplementation(async ({ origin, destination, date, travelers }: any) => {
    // Home flights: the second home airport is always $40 cheaper than the first.
    if (HOME.includes(origin) || HOME.includes(destination)) {
      const base = 450 + (hash(`${origin}${destination}`.replace(/HM[AB]/, 'HM')) % 50);
      const cheaper = origin === 'HMB' || destination === 'HMB' ? 40 : 0;
      return [flight(origin, destination, date, (base - cheaper) * travelers)];
    }
    return [flight(origin, destination, date, (120 + (hash(`${origin}${destination}`) % 40)) * travelers)];
  });
});

describe('the total is the sum of what the trip shows', () => {
  it('a train the alternatives search found after ranking missed it: total follows the train on the card', async () => {
    // Every route-day's FIRST rail answer comes back empty (an incomplete
    // search: those are not cached), every later one has a $60 train.
    const seen = new Map<string, number>();
    mockedTrains.mockImplementation(async ({ origin, destination, date, travelers }: any) => {
      const k = `${origin}>${destination}@${date}`;
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      return n === 1 ? [] : [train(origin, destination, date, 60 * travelers)];
    });

    const result = await optimize({
      cities: [{ name: 'Vienna' }, { name: 'Munich' }, { name: 'Prague' }],
      startDate: '2030-02-09',
      travelers: 2,
      origin: 'Home',
      originAirports: ['HMA'],
      returnToHome: true,
      totalNights: 6,
    });

    const legs = result.bestRoute.legs;
    // The situation itself: some leg was ranked on its flight while its card is a train.
    const diverged = legs.filter((l) => l.comparison.recommendation === 'flight' && l.options?.[0]?.mode === 'train');
    expect(diverged.length).toBeGreaterThan(0);

    for (const leg of legs) expect(leg.cost).toBe(leg.options?.[0]?.price ?? leg.cost);
    expect(result.bestRoute.totalCost).toBeCloseTo(shownTotal(result), 2);
  });

  it('4 cities, home flights ranked on the first airport: total follows the cheaper airport on the card', async () => {
    mockedTrains.mockImplementation(async () => []);

    const result = await optimize({
      cities: [{ name: 'Vienna' }, { name: 'Munich' }, { name: 'Prague' }, { name: 'Zurich' }],
      startDate: '2030-02-09',
      travelers: 2,
      origin: 'Home',
      originAirports: HOME,
      returnToHome: true,
      totalNights: 8,
    });

    // The cards show the cheaper second airport, both ways.
    expect(result.outboundLeg?.originAirport).toBe('HMB');
    expect(result.returnLeg?.destAirport).toBe('HMB');
    expect(result.bestRoute.totalCost).toBeCloseTo(shownTotal(result), 2);
  });

  it('a home flight the winner could not build is not in the total, as its card shows none', async () => {
    mockedTrains.mockImplementation(async () => []);
    const result = await optimize({
      cities: [{ name: 'Vienna' }, { name: 'Munich' }],
      startDate: '2030-02-09',
      travelers: 2,
      origin: 'Home',
      originAirports: ['HMA'],
      returnToHome: false,
      totalNights: 4,
    });
    expect(result.returnLeg ?? null).toBeNull();
    expect(result.bestRoute.totalCost).toBeCloseTo(shownTotal(result), 2);
  });
});
