/**
 * leg_price_cache is keyed by city NAME (origin, destination, date, mode,
 * travelers) — never by airport. Once the trip decides which "Lagos" a leg
 * means, one name has two flight prices: Porto -> Lagos is OPO -> FAO on a
 * Portugal trip and OPO -> LOS bare. A row written by either is served to
 * the other for its two hours: a Portugal trip pays Nigeria's fare, or a
 * Nigeria trip is shown Faro's.
 *
 * So a leg whose airports depend on the trip neither reads nor writes the
 * shared flight row. Every other leg uses the cache exactly as before.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

// A cached FLIGHT row exists for every leg ($950 — the Nigeria fare);
// no train rows. Every write is recorded.
const mockWrites: any[] = [];
jest.mock('../services/supabase', () => {
  const createChain = (table: string): any => {
    const filters: Record<string, unknown> = {};
    const chain: any = {};
    for (const m of ['select', 'gte', 'limit', 'order', 'single']) chain[m] = jest.fn(() => chain);
    chain.eq = jest.fn((col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    });
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.upsert = jest.fn((rows: any[]) => {
      mockWrites.push(...(Array.isArray(rows) ? rows : [rows]).map((r) => ({ table, ...r })));
      return Promise.resolve({ data: null, error: null });
    });
    chain.then = (fn: any) =>
      Promise.resolve({
        data:
          table === 'leg_price_cache' && filters.mode === 'flight'
            ? [{ id: 'cached-1', price: 950, duration_minutes: 600, operator: 'Cached Air' }]
            : [],
      }).then(fn);
    return chain;
  };
  return { getSupabase: () => ({ from: (t: string) => createChain(t) }) };
});

jest.mock('../services/currency', () => ({
  convertToUsd: jest.fn(async (amount: number) => amount),
}));

const mockAsked: string[] = [];
jest.mock('../services/duffel', () => ({
  getDuffel: () => ({
    offerRequests: {
      create: jest.fn(async (body: any) => {
        const s = body.slices[0];
        mockAsked.push(`${s.origin}>${s.destination}`);
        return {
          data: {
            offers: [
              {
                id: `o-${s.origin}-${s.destination}`,
                total_amount: '90',
                total_currency: 'USD',
                slices: [
                  {
                    duration: 'PT1H',
                    segments: [
                      {
                        departing_at: `${s.departure_date}T09:00:00`,
                        arriving_at: `${s.departure_date}T10:00:00`,
                        origin: { time_zone: 'Europe/Lisbon' },
                        destination: { time_zone: 'Europe/Lisbon' },
                        operating_carrier: { name: 'Test Air', iata_code: 'TA' },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        };
      }),
    },
    suggestions: { list: jest.fn(async () => ({ data: [] })) },
  }),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

import { compareLeg } from '../services/compareLeg';

const PORTUGAL = ['Lisbon', 'Porto', 'Lagos'];

beforeEach(() => {
  mockAsked.length = 0;
  mockWrites.length = 0;
});

describe('leg_price_cache and trip context', () => {
  it("does not serve or write the name-keyed row when the trip changes the leg's airport", async () => {
    const leg = await compareLeg({
      origin: 'Porto',
      destination: 'Lagos',
      date: '2030-08-01',
      travelers: 1,
      tripCityNames: PORTUGAL,
    });

    // Before: $950 from the cache, no search at all.
    expect(leg.flightOption?.price).toBe(90);
    expect(mockAsked).toEqual(['OPO>FAO']);
    expect(mockWrites.filter((w) => w.mode === 'flight')).toEqual([]);
  });

  it('still uses the cache for the same name with no trip (one answer, LOS)', async () => {
    const leg = await compareLeg({ origin: 'Porto', destination: 'Lagos', date: '2030-08-02', travelers: 1 });
    expect(leg.flightOption?.price).toBe(950);
    expect(mockAsked).toEqual([]);
  });

  it('still uses the cache for legs the trip does not change', async () => {
    const leg = await compareLeg({
      origin: 'Lisbon',
      destination: 'Porto',
      date: '2030-08-03',
      travelers: 1,
      tripCityNames: PORTUGAL,
    });
    expect(leg.flightOption?.price).toBe(950);
    expect(mockAsked).toEqual([]);
  });
});
