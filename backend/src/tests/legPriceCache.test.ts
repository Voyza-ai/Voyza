jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

/**
 * leg_price_cache keying.
 *
 * Every price in that table is a PARTY TOTAL — Duffel quotes the whole
 * passenger set and trains.ts scales rail fares to match — but the lookup
 * used to match only on (origin, destination, travel_date, mode). A
 * 2-traveller party's row was therefore served to a 4-traveller party,
 * which under-billed the leg by half for the row's 2-hour lifetime.
 *
 * The chain mock in compareLeg.test.ts always resolves to [], which is fine
 * for the comparison logic and useless for asserting cache behaviour, so
 * this file stands up a fake table that actually honours .eq() filters.
 */
type Row = Record<string, any>;

const rows: Row[] = [];
/** The filter set of every read, so a test can see what the key really was. */
const reads: Row[] = [];

function makeChain(): any {
  const filters: Row = {};
  let orderBy: { column: string; ascending: boolean } | null = null;
  const chain: any = {
    select: () => chain,
    eq: (column: string, value: any) => {
      filters[column] = value;
      return chain;
    },
    // expires_at isn't modelled — these tests don't run for two hours.
    gte: () => chain,
    // compareLeg reads the newest row per mode; model the sort so a test
    // with duplicate rows genuinely exercises "freshest wins".
    order: (column: string, opts?: { ascending?: boolean }) => {
      orderBy = { column, ascending: opts?.ascending ?? true };
      return chain;
    },
    limit: (n: number) => {
      reads.push({ ...filters });
      const matches = rows.filter((r) =>
        Object.entries(filters).every(([k, v]) => r[k] === v),
      );
      if (orderBy) {
        const { column, ascending } = orderBy;
        matches.sort((a, b) =>
          (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1),
        );
      }
      return Promise.resolve({ data: matches.slice(0, n) });
    },
    insert: (newRows: Row[]) => {
      // Postgres assigns the id (gen_random_uuid); mimic that so the
      // cached-row mapping in compareLeg has something real to read.
      for (const r of newRows) rows.push({ id: `row-${rows.length + 1}`, ...r });
      return Promise.resolve({ data: newRows });
    },
    // Mirrors 007's unique key: a row matching on
    // (origin, destination, travel_date, mode, travelers) is REPLACED, not
    // duplicated — which is what keeps an expired leg refreshable.
    upsert: (newRows: Row[]) => {
      const KEY = ['origin', 'destination', 'travel_date', 'mode', 'travelers'];
      for (const r of newRows) {
        const i = rows.findIndex((e) => KEY.every((k) => e[k] === r[k]));
        if (i >= 0) rows[i] = { ...rows[i], ...r };
        else rows.push({ id: `row-${rows.length + 1}`, ...r });
      }
      return Promise.resolve({ data: newRows });
    },
  };
  return chain;
}

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({ from: () => makeChain() }),
}));

jest.mock('../services/flights', () => ({
  searchFlights: jest.fn(),
  getIataCode: jest.fn().mockResolvedValue('FCO'),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn(),
}));

import { compareLeg } from '../services/compareLeg';
const { searchFlights } = require('../services/flights');
const { searchTrains } = require('../services/trains');

/** A party total, the unit searchFlights returns. */
const flightOffer = (price: number) => ({
  id: `off_${price}`,
  price,
  currency: 'USD',
  departure: '2026-06-01T08:00:00Z',
  arrival: '2026-06-01T09:10:00Z',
  durationMinutes: 70,
  stops: 0,
  carrier: 'ITA Airways',
  carrierCode: 'AZ',
  bookingUrl: '',
  raw: {},
});

const leg = (travelers: number) => ({
  origin: 'Rome',
  destination: 'Florence',
  date: '2026-06-01',
  travelers,
});

beforeEach(() => {
  jest.clearAllMocks();
  rows.length = 0;
  reads.length = 0;
  searchTrains.mockResolvedValue([]);
});

describe('leg_price_cache keying', () => {
  it('includes travelers in the cache lookup', async () => {
    searchFlights.mockResolvedValue([flightOffer(600)]);

    await compareLeg(leg(2));

    expect(reads[0]).toMatchObject({
      origin: 'rome',
      destination: 'florence',
      travel_date: '2026-06-01',
      travelers: 2,
    });
  });

  it('records the party size on the row it writes', async () => {
    searchFlights.mockResolvedValue([flightOffer(600)]);

    await compareLeg(leg(2));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'flight', travelers: 2, price: 600 });
  });

  it('serves a cached party total back to a party of the same size', async () => {
    searchFlights.mockResolvedValue([flightOffer(600)]);
    await compareLeg(leg(2));
    searchFlights.mockClear();

    const again = await compareLeg(leg(2));

    expect(searchFlights).not.toHaveBeenCalled();
    expect(again.flightOption?.price).toBe(600);
  });

  it('does not hand a 2-person total to a 4-person party', async () => {
    // $300 a seat. The 2-person row ($600) is simply the wrong number for
    // four travellers; before travelers was part of the key, compareLeg
    // served it anyway and the trip under-billed the leg by half.
    searchFlights.mockResolvedValue([flightOffer(600)]);
    await compareLeg(leg(2));

    searchFlights.mockClear();
    searchFlights.mockResolvedValue([flightOffer(1200)]);
    const four = await compareLeg(leg(4));

    expect(searchFlights).toHaveBeenCalledTimes(1);
    expect(four.flightOption?.price).toBe(1200);
    expect(rows.map((r) => r.travelers)).toEqual([2, 4]);
  });
});
