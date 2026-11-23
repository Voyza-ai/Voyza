/**
 * The planner when a short hop has NO sensible flight (and no train).
 *
 * Production, 2026-11-16 (Prague, Munich, Vienna from New York, Dec 23–31,
 * 2 travellers): the plan's Prague → Vienna card was a $301 flight taking
 * 22h 50m. 762064e (plannerLongFlights.test.ts) picks the 55m nonstop when
 * one is offered — but its rule is relative to the leg's fastest option, so
 * when EVERY flight is a 22h+ connection (and rail, off in production, finds
 * no train) the plan still took the cheapest 22h one, said nothing, and could
 * choose the city order because of that fare.
 *
 * Now compareLeg flags such a leg (routeGeo.noSensibleFlight: the fastest
 * flight over 3× a direct flight's time for the distance and over 6h more),
 * with a ground ESTIMATE from distance; ranking charges it a penalty; the plan
 * shows "no sensible flight, about N h by train or bus (estimate)".
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
  const writtenRows: any[] = [];
  const createChain = (): any => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'order', 'delete', 'in', 'lt']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.upsert = jest.fn((rows: any[]) => {
      writtenRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve({ data: null });
    });
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return { getSupabase: () => ({ from: () => createChain() }), __writtenRows: writtenRows };
});

const mockIata: Record<string, string> = { Prague: 'PRG', Vienna: 'VIE', Munich: 'MUC', London: 'LON', 'New York': 'JFK' };
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

// No train for any leg: the case under test (a rail search that found nothing).
jest.mock('../services/trains', () => ({ searchTrains: jest.fn().mockResolvedValue([]) }));

import { compareLeg } from '../services/compareLeg';

import { optimize } from '../services/optimizer';

import { searchFlights } from '../services/flights';

const mockedSearchFlights = searchFlights as jest.Mock;
const { __writtenRows: writtenRows } = require('../services/supabase');

const offer = (price: number, durationMinutes: number, carrier = 'Test Air', departure = '2026-12-26T10:00:00', stops = 0) => ({
  id: `f-${price}-${durationMinutes}`,
  price,
  durationMinutes,
  carrier,
  carrierCode: carrier.slice(0, 2).toUpperCase(),
  departure,
  arrival: '',
  currency: 'USD',
  stops,
  bookingUrl: '',
  raw: {},
});

/** Production's Prague → Vienna offers, Dec 26 2026 (party totals for 2). */
const PRAGUE_VIENNA = [
  offer(301, 22 * 60 + 50, 'Duffel Airways', '2026-12-26T18:00:00', 2), // the 22h 50m production showed
  offer(368, 55, 'Austrian', '2026-12-26T16:50:00'),
  offer(412, 65, 'Czech Airlines', '2026-12-26T07:10:00'),
  offer(590, 4 * 60 + 30, 'Lufthansa', '2026-12-26T08:45:00', 1), // via Munich: long (> 55m + 3h)
];

beforeEach(() => {
  jest.clearAllMocks();
  writtenRows.length = 0;
});

/** Prague → Vienna with nothing sensible: two connecting itineraries, 22h 50m and 23h 30m. */
const ONLY_LONG = [offer(301, 22 * 60 + 50, 'LOT', '2026-12-26T18:00:00', 2), offer(340, 23 * 60 + 30, 'Austrian', '2026-12-26T07:10:00', 1)];

describe('compareLeg flags a leg with no sensible flight', () => {
  it('Prague → Vienna with only 22h+ connections and no train: flagged, with a ground estimate', async () => {
    mockedSearchFlights.mockResolvedValue(ONLY_LONG);
    const r = await compareLeg({ origin: 'Prague', destination: 'Vienna', date: '2026-12-26', travelers: 2 });
    expect((r as any).noSensibleFlight).toEqual({ fastestMinutes: 1370, stops: 2, groundHours: [4, 5] });
  });

  it('not when a sensible flight is on offer (the 55m nonstop)', async () => {
    mockedSearchFlights.mockResolvedValue([...ONLY_LONG, offer(368, 55)]);
    const r = await compareLeg({ origin: 'Prague', destination: 'Vienna', date: '2026-12-26', travelers: 2 });
    expect((r as any).noSensibleFlight).toBeUndefined();
    expect(r.flightOption?.durationMinutes).toBe(55);
  });

  it('not on a long-haul leg whose flights are long because the distance is', async () => {
    mockedSearchFlights.mockResolvedValue([offer(900, 9 * 60), offer(700, 13 * 60, 'Test Air', '2026-12-26T10:00:00', 1)]);
    const r = await compareLeg({ origin: 'Prague', destination: 'New York', date: '2026-12-26', travelers: 2 });
    expect((r as any).noSensibleFlight).toBeUndefined();
  });
});

describe('optimize() does not build the plan around a leg with no sensible flight', () => {
  function fares(pv: any[]) {
    mockedSearchFlights.mockImplementation(async ({ origin, destination }: any) => {
      const pair = [origin, destination].sort().join('-');
      if (origin === 'JFK' || destination === 'JFK') return [offer(500, 9 * 60)];
      if (pair === 'PRG-VIE') return pv;
      if (pair === 'MUC-VIE') return [offer(200, 60)];
      if (pair === 'MUC-PRG') return [offer(330, 55)];
      return [];
    });
  }
  const run = (cities = ['Prague', 'Munich', 'Vienna']) =>
    optimize({
      cities: cities.map((name) => ({ name })),
      startDate: '2030-12-23',
      travelers: 2,
      origin: 'New York',
      originAirports: ['JFK'],
      returnToHome: true,
      totalNights: 8,
    });

  // Through Prague ↔ Vienna on the 22h 50m fare: $301 + $200 = $501. Around it
  // (Prague ↔ Munich ↔ Vienna): $330 + $200 = $530. Ranked on fares alone, the
  // order through the 22-hour hop "wins" by $29.
  it('chooses the order around the 22-hour hop', async () => {
    fares(ONLY_LONG);
    const result = await run();
    const o = result.bestRoute.ordering;
    const hops = o.slice(1).map((c, i) => [o[i], c].sort().join('-'));
    expect(hops).not.toContain('Prague-Vienna');
  }, 30000);

  it('when the hop cannot be avoided (Prague and Vienna only), the plan carries the flag for the card', async () => {
    fares(ONLY_LONG);
    const result = await run(['Prague', 'Vienna']);
    const leg = (result.bestRoute.legs as any[])[0];
    expect(leg.comparison.noSensibleFlight).toMatchObject({ fastestMinutes: 1370, stops: 2 });
  }, 30000);
});
