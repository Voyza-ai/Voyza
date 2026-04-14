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
    const methods = ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'upsert', 'order'];
    for (const m of methods) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.limit = jest.fn().mockReturnValue(chain);
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return {
    getSupabase: () => ({
      from: () => createChain(),
    }),
  };
});

jest.mock('../services/flights', () => ({
  getIataCode: jest.fn().mockResolvedValue('XXX'),
  searchFlights: jest.fn().mockResolvedValue([
    {
      id: 'f1',
      price: 100,
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
  ]),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([
    {
      id: 't1',
      price: 50,
      durationMinutes: 240,
      operator: 'Test Rail',
      trainType: 'IC',
      departure: '',
      arrival: '',
      currency: 'EUR',
      bookingUrl: '',
      limitedCoverage: false,
    },
  ]),
}));

import { optimize } from '../services/optimizer';

describe('optimize', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns cheapest ordering for 3 cities (6 permutations)', async () => {
    const result = await optimize({
      cities: [
        { name: 'Rome' },
        { name: 'Florence' },
        { name: 'Venice' },
      ],
      startDate: '2026-06-01',
      travelers: 1,
    });

    expect(result.routes.length).toBeLessThanOrEqual(3);
    expect(result.bestRoute).toBeDefined();
    expect(result.bestRoute.ordering).toHaveLength(3);
    expect(result.bestRoute.totalCost).toBeGreaterThanOrEqual(0);
  }, 30000);

  it('calculates savingsVsNaive correctly', async () => {
    const result = await optimize({
      cities: [
        { name: 'A' },
        { name: 'B' },
        { name: 'C' },
      ],
      startDate: '2026-06-01',
      travelers: 1,
    });

    // Since all legs cost the same (mocked), savings should be 0
    expect(result.savingsVsNaive).toBe(0);
  }, 30000);

  it('assigns 2-night dates for each city', async () => {
    const result = await optimize({
      cities: [
        { name: 'Rome' },
        { name: 'Florence' },
      ],
      startDate: '2026-06-01',
      travelers: 1,
    });

    expect(result.dates).toBeDefined();
    const cityNames = result.bestRoute.ordering;
    const firstCity = cityNames[0];
    expect(result.dates[firstCity].arrival).toBe('2026-06-01');
    expect(result.dates[firstCity].departure).toBe('2026-06-03');
  }, 30000);

  it('handles 6 cities with heuristic (not full permutation)', async () => {
    const result = await optimize({
      cities: [
        { name: 'A' },
        { name: 'B' },
        { name: 'C' },
        { name: 'D' },
        { name: 'E' },
        { name: 'F' },
      ],
      startDate: '2026-06-01',
      travelers: 1,
    });

    // Should return up to 3 routes (from 3 random seeds), not 120 (5!)
    expect(result.routes.length).toBeLessThanOrEqual(3);
    expect(result.bestRoute.ordering).toHaveLength(6);
  }, 60000);
});
