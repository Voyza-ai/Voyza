/**
 * B5 end to end: a 6-city optimize() finds the best country-clustered
 * ordering — the one brute force finds — where the old heuristic (three
 * hand-built orderings) was 23% dearer on this kind of trip.
 *
 * Prices here do not depend on the date, so the matrix (priced at one date)
 * is exact and the brute-force answer is unambiguous.
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

// Fictional map (km); price = 60 + 0.12 × distance. Home at (0, 0).
const mockGeo: Record<string, [number, number, string]> = {
  LIS: [3000, 0, 'PT'],
  MAD: [3500, 200, 'ES'],
  BCN: [4000, 400, 'ES'],
  PAR: [4200, 1000, 'FR'],
  ROM: [5200, 300, 'IT'],
  FLR: [5000, 500, 'IT'],
};
const mockIata: Record<string, string> = {
  Lisbon: 'LIS',
  Madrid: 'MAD',
  Barcelona: 'BCN',
  Paris: 'PAR',
  Rome: 'ROM',
  Florence: 'FLR',
};
jest.mock('../services/flights', () => ({
  getIataCode: jest.fn(async (name: string) => mockIata[name]),
  searchFlights: jest.fn(async ({ origin, destination }: any) => {
    const at = (c: string) => (c === 'HOM' ? [0, 0] : mockGeo[c]);
    const a = at(origin);
    const b = at(destination);
    const price = Math.round(60 + 0.12 * Math.hypot(a[0] - b[0], a[1] - b[1]));
    return [
      {
        id: `${origin}${destination}`,
        price,
        durationMinutes: 120,
        carrier: 'Geo Air',
        carrierCode: 'GA',
        departure: '',
        arrival: '',
        currency: 'USD',
        stops: 0,
        bookingUrl: '',
        raw: {},
      },
    ];
  }),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

import { optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';

const names = ['Rome', 'Lisbon', 'Paris', 'Madrid', 'Florence', 'Barcelona'];

function bruteForceBest(): { order: string[]; cost: number } {
  const price = (a: string, b: string) => {
    const at = (c: string) => (c === 'HOM' ? [0, 0] : mockGeo[c]);
    const p = at(a);
    const q = at(b);
    return Math.round(60 + 0.12 * Math.hypot(p[0] - q[0], p[1] - q[1]));
  };
  const perms = (xs: string[]): string[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
  const clustered = (order: string[]) => {
    const seen = new Set<string>();
    let cur = '';
    for (const n of order) {
      const c = mockGeo[mockIata[n]][2];
      if (c !== cur) {
        if (seen.has(c)) return false;
        seen.add(c);
        cur = c;
      }
    }
    return true;
  };
  let best = { order: [] as string[], cost: Infinity };
  for (const order of perms(names).filter(clustered)) {
    const codes = order.map((n) => mockIata[n]);
    let cost = price('HOM', codes[0]) + price(codes[codes.length - 1], 'HOM');
    for (let i = 0; i + 1 < codes.length; i++) cost += price(codes[i], codes[i + 1]);
    if (cost < best.cost) best = { order, cost };
  }
  return best;
}

describe('B5 — 6 cities: exact best clustered ordering', () => {
  it('matches brute force over all 720 orderings', async () => {
    const result = await optimize({
      cities: names.map((name) => ({ name })),
      startDate: '2030-06-01',
      travelers: 1,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: true,
      totalNights: 12,
    });

    const best = bruteForceBest();
    expect(result.bestRoute.totalCost).toBe(best.cost);
    // Prices are symmetric here, so an ordering and its reverse tie; either
    // is the optimum. (Before: 2162 against an optimum of 1719.)
    expect([best.order.join('>'), [...best.order].reverse().join('>')]).toContain(
      result.bestRoute.ordering.join('>'),
    );
    // Matrix: 30 ordered pairs. No Duffel search per ordering.
    expect((searchFlights as jest.Mock).mock.calls.length).toBeLessThan(200);
  }, 60000);
});
