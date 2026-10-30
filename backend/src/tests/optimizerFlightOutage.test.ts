/**
 * B14 — when EVERY flight search throws, optimize() fails with a 502
 * instead of returning an empty shell.
 *
 * A Duffel outage (or exhausted retry budget) used to come back as HTTP 200:
 * every leg "unavailable", both home flights null, totalCost $0 — a trip
 * card that looks like a real, free itinerary. The planner already shows an
 * error for a 5xx (lib/api.ts apiFetch → PlanningChat's catch), so the
 * honest answer is to send one.
 *
 * Deliberately narrow: searches that ANSWER with no offers (a route nobody
 * flies) are not an outage, and a trip that rail still priced is returned.
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

jest.mock('../services/flights', () => ({
  getIataCode: jest.fn(async (name: string) => name.slice(0, 3).toUpperCase()),
  searchFlights: jest.fn(),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

import { optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';
import { searchTrains } from '../services/trains';
import { AppError } from '../middleware/error';

const mockedSearchFlights = searchFlights as jest.Mock;
const mockedSearchTrains = searchTrains as jest.Mock;

const trip = {
  cities: [{ name: 'Paris' }, { name: 'Rome' }],
  startDate: '2030-06-01',
  travelers: 2,
  origin: 'New York',
  originAirports: ['JFK'],
  returnToHome: true,
  totalNights: 6,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockedSearchTrains.mockResolvedValue([]);
});

describe('B14 — every flight search threw', () => {
  it('rejects with a 502 instead of a $0 trip', async () => {
    // What flights.ts throws when Duffel fails after its retries.
    mockedSearchFlights.mockRejectedValue(new AppError(502, 'Flight search failed: HTTP 503'));

    const run = optimize(trip);
    await expect(run).rejects.toBeInstanceOf(AppError);
    await expect(run).rejects.toMatchObject({ statusCode: 502 });
  }, 30000);

  it('does not treat "no offers" as an outage', async () => {
    mockedSearchFlights.mockResolvedValue([]);

    const result = await optimize(trip);
    expect(result.outboundLeg).toBeNull();
    expect(result.bestRoute.totalCost).toBe(0);
  }, 30000);

  it('returns the trip when rail still priced something', async () => {
    mockedSearchFlights.mockRejectedValue(new AppError(502, 'Flight search failed: HTTP 503'));
    mockedSearchTrains.mockResolvedValue([
      {
        id: 't1',
        price: 90,
        durationMinutes: 600,
        operator: 'Test Rail',
        trainType: 'IC',
        departure: '',
        arrival: '',
        currency: 'USD',
        bookingUrl: null,
        limitedCoverage: false,
      },
    ]);

    const result = await optimize(trip);
    expect(result.bestRoute.totalCost).toBe(90);
  }, 30000);

  it('returns the trip when only SOME searches threw', async () => {
    mockedSearchFlights.mockImplementation(async ({ origin }: any) => {
      if (origin === 'JFK') throw new AppError(502, 'Flight search failed: HTTP 503');
      return [
        {
          id: 'f',
          price: 150,
          durationMinutes: 120,
          carrier: 'Test Air',
          carrierCode: 'TA',
          departure: '',
          arrival: '',
          currency: 'USD',
          stops: 0,
          bookingUrl: '',
          raw: {},
        },
      ];
    });

    // Every search from JFK fails; the return (into JFK) and the inter-city
    // leg answer, so this is a partial outage — return what was priced.
    const result = await optimize(trip);
    expect(result.returnLeg).not.toBeNull();
    expect(result.bestRoute.legs[0].cost).toBe(150);
  }, 30000);
});
