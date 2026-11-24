/**
 * The planner must not pick a 39-hour train for a five-hour ride.
 *
 * Production, 2026-11-22 (Munich, Prague, Vienna from Boston, Mar 16–24 2027,
 * 2 travellers): the Munich → Prague card was a $77 train taking 39h 12m,
 * 23:09 → 14:21 two days later. All Aboard returned two offers for the day:
 * that one, priced, and a 5h 37m Die Länderbahn train with no fare. compareLeg
 * took the cheapest PRICED train whatever its length. Flights already used the
 * long-journey rule (longJourney.ts); trains now do too, against the fastest
 * train (never against a flight — legOptionsOrder.test.ts).
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

const mockIata: Record<string, string> = { Munich: 'MUC', Prague: 'PRG', Vienna: 'VIE' };
jest.mock('../services/flights', () => {
  const { AppError } = jest.requireActual('../middleware/error');
  return {
    getIataCode: jest.fn(async (name: string) => {
      const code = mockIata[name];
      if (!code) throw new AppError(404, `No IATA code found for "${name}"`);
      return code;
    }),
    searchFlights: jest.fn().mockResolvedValue([]),
  };
});

jest.mock('../services/trains', () => ({ searchTrains: jest.fn() }));

import { compareLeg } from '../services/compareLeg';
import { orderLegOptions, type LegOption } from '../services/legOptions';
import { searchTrains } from '../services/trains';

const mockedTrains = searchTrains as jest.Mock;
const { __writtenRows: writtenRows } = require('../services/supabase');

const train = (price: number | null, durationMinutes: number, operator: string, departure: string, arrival: string) => ({
  id: `t-${operator}-${durationMinutes}`,
  price,
  currency: 'USD',
  departure,
  arrival,
  durationMinutes,
  operator,
  trainType: 'train',
  bookingUrl: null,
  limitedCoverage: price == null,
  ...(price != null ? { priceSource: { kind: 'live', provider: 'All Aboard', testApi: true } } : {}),
});

/** All Aboard's Munich → Prague offers for 2027-03-19, as production got them. */
const LONG = train(76.6, 2352, 'ÖBB + DB Regio + Die Länderbahn', '2027-03-19T23:09', '2027-03-21T14:21');
const SHORT_UNPRICED = train(null, 337, 'Die Länderbahn', '2027-03-19T04:44', '2027-03-19T10:21');

beforeEach(() => {
  jest.clearAllMocks();
  writtenRows.length = 0;
});

describe('compareLeg picks a sensible train', () => {
  it('Munich → Prague: not the priced 39h 12m connection; the 5h 37m train, even unpriced', async () => {
    mockedTrains.mockResolvedValue([LONG, SHORT_UNPRICED]);
    const r = await compareLeg({ origin: 'Munich', destination: 'Prague', date: '2027-03-19', travelers: 2 });
    expect(r.trainOption?.durationMinutes).toBe(337);
    expect(r.trainOption?.price ?? null).toBeNull();
  });

  it('a priced sensible train beats a cheaper long one', async () => {
    const shortPriced = train(120, 337, 'Die Länderbahn', '2027-03-19T04:44', '2027-03-19T10:21');
    mockedTrains.mockResolvedValue([LONG, shortPriced]);
    const r = await compareLeg({ origin: 'Munich', destination: 'Prague', date: '2027-03-19', travelers: 2 });
    expect(r.trainOption?.price).toBe(120);
  });

  it('the long train is not written to the cache as the leg price', async () => {
    mockedTrains.mockResolvedValue([LONG, SHORT_UNPRICED]);
    await compareLeg({ origin: 'Munich', destination: 'Prague', date: '2027-03-19', travelers: 2 });
    const row = writtenRows.find((x: any) => x.mode === 'train');
    if (row) expect(row.duration_minutes).toBe(337);
  });

  it('ordinary trains are unchanged: the cheapest priced one wins', async () => {
    mockedTrains.mockResolvedValue([
      train(140, 260, 'ÖBB', '2027-03-19T08:00', '2027-03-19T12:20'),
      train(90, 300, 'Westbahn', '2027-03-19T09:00', '2027-03-19T14:00'),
      train(null, 240, 'Railjet', '2027-03-19T10:00', '2027-03-19T14:00'),
    ]);
    const r = await compareLeg({ origin: 'Vienna', destination: 'Munich', date: '2027-03-19', travelers: 2 });
    expect(r.trainOption?.price).toBe(90);
  });

  it('a lone long train is still offered (never drops the leg)', async () => {
    mockedTrains.mockResolvedValue([LONG]);
    const r = await compareLeg({ origin: 'Munich', destination: 'Prague', date: '2027-03-19', travelers: 2 });
    expect(r.trainOption?.price).toBe(76.6);
  });
});

describe('orderLegOptions (the leg card)', () => {
  const opt = (mode: 'flight' | 'train', price: number, durationMinutes: number, operator: string): LegOption => ({
    mode,
    price,
    durationMinutes,
    operator,
  }) as unknown as LegOption;

  it('buries a 39h train behind every sensible train', () => {
    const long = opt('train', 76.6, 2352, 'ÖBB + DB Regio');
    const short = opt('train', 120, 337, 'Die Länderbahn');
    const flight = opt('flight', 300, 70, 'Lufthansa');
    const out = orderLegOptions([long, short, flight], 4);
    expect(out[0]).toBe(short);
    expect(out.indexOf(long)).toBeGreaterThan(out.indexOf(flight));
  });
});
