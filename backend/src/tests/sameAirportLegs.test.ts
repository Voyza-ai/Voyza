/**
 * F3 — a leg whose two ends share an airport has no flight option.
 *
 * Interlaken has no airport and is priced through Zurich, so a Zurich →
 * Interlaken leg resolves to ZRH → ZRH. Integrated run, 2026-10-30 (NYC →
 * Zurich, Interlaken, Geneva): two ZRH → ZRH offer requests reached Duffel.
 * The leg is ground travel. The same holds for a metro code and its own
 * airports (Oxford is LON, and LHR is London's), at home and between stops.
 *
 * Real optimize() / searchLegOptions / buildHomeLeg / compareLeg ->
 * getIataCode -> curated table and location artifact; Duffel, Supabase and
 * rail mocked. Every offer request is recorded, and the mock answers EVERY
 * pair with a $100 offer — so a same-airport search, if made, also shows up
 * as a bogus flight option.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

// Every read misses, every write succeeds.
jest.mock('../services/supabase', () => {
  const createChain = (): any => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gte', 'limit', 'insert', 'order']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.upsert = jest.fn().mockResolvedValue({ data: null, error: null });
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return { getSupabase: () => ({ from: () => createChain() }) };
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
                id: `o-${s.origin}-${s.destination}-${s.departure_date}`,
                total_amount: '100',
                total_currency: 'USD',
                slices: [
                  {
                    duration: 'PT1H',
                    segments: [
                      {
                        departing_at: `${s.departure_date}T09:00:00`,
                        arriving_at: `${s.departure_date}T10:00:00`,
                        origin: { time_zone: 'Europe/Zurich' },
                        destination: { time_zone: 'Europe/Zurich' },
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

// Production's rail provider is down: no train answers any leg.
jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

import { optimize, buildHomeLeg } from '../services/optimizer';
import { searchLegOptions } from '../services/legOptions';
import { compareLeg } from '../services/compareLeg';
import { searchFlights } from '../services/flights';

/** Offer requests from a code to itself, or between LON and its airports. */
const sameAirportAsks = () =>
  mockAsked.filter((pair) => {
    const [a, b] = pair.split('>');
    const london = ['LON', 'LHR', 'LGW', 'STN', 'LTN', 'LCY', 'SEN'];
    return a === b || (london.includes(a) && london.includes(b));
  });

beforeEach(() => {
  mockAsked.length = 0;
});

describe('F3 — same-airport legs are never searched', () => {
  it('optimize(): NYC → Zurich, Interlaken, Geneva sends no ZRH → ZRH search', async () => {
    const result = await optimize({
      cities: [{ name: 'Zurich' }, { name: 'Interlaken' }, { name: 'Geneva' }],
      startDate: '2030-12-08',
      travelers: 2,
      origin: 'New York',
      originAirports: ['JFK', 'LGA', 'EWR'],
      returnToHome: true,
      totalNights: 7,
    });

    expect(mockAsked.length).toBeGreaterThan(0);
    // Before: ZRH>ZRH, once per leg date it was priced on.
    expect(sameAirportAsks()).toEqual([]);
    // No leg of the chosen route is a ZRH → ZRH "flight".
    for (const leg of result.bestRoute.legs) {
      const zurichInterlaken =
        [leg.from, leg.to].sort().join('|') === 'Interlaken|Zurich';
      if (zurichInterlaken) expect(leg.comparison?.flightOption ?? null).toBeNull();
    }
  }, 60000);

  it('searchLegOptions (chat "cheaper way"): Zurich → Interlaken offers no flight', async () => {
    const { options } = await searchLegOptions({
      from: 'Zurich',
      to: 'Interlaken',
      date: '2030-12-10',
      travelers: 2,
      tripCityNames: ['Zurich', 'Interlaken', 'Geneva'],
    });
    // Before: a $100 ZRH → ZRH "flight".
    expect(options.filter((o) => o.mode === 'flight')).toEqual([]);
    expect(sameAirportAsks()).toEqual([]);
  });

  it('compareLeg: Zurich → Interlaken has no flight option and, with no rail, is unavailable', async () => {
    const cmp = await compareLeg({ origin: 'Zurich', destination: 'Interlaken', date: '2030-12-10', travelers: 2 });
    expect(cmp.flightOption).toBeNull();
    expect(cmp.recommendation).toBe('unavailable');
    expect(sameAirportAsks()).toEqual([]);
  });

  it('a real leg next to it is still searched and priced', async () => {
    const cmp = await compareLeg({ origin: 'Geneva', destination: 'Interlaken', date: '2030-12-10', travelers: 2 });
    expect(mockAsked).toEqual(['GVA>ZRH']);
    expect(cmp.flightOption?.price).toBe(100);
  });

  it('home legs: home Zurich → first stop Interlaken has no outbound flight', async () => {
    const leg = await buildHomeLeg({
      originAirports: ['ZRH'],
      destinationCity: 'Interlaken',
      date: '2030-12-08',
      travelers: 2,
    });
    expect(leg).toBeNull();
    expect(sameAirportAsks()).toEqual([]);
  });

  it('metro codes: home London (LHR, LGW) → Oxford (LON) has no flight, either way', async () => {
    const out = await buildHomeLeg({
      originAirports: ['LHR', 'LGW'],
      destinationCity: 'Oxford',
      date: '2030-12-08',
      travelers: 2,
    });
    const back = await buildHomeLeg({
      originAirports: ['LHR', 'LGW'],
      destinationCity: 'Oxford',
      date: '2030-12-15',
      travelers: 2,
      reverse: true,
    });
    expect(out).toBeNull();
    expect(back).toBeNull();
    expect(sameAirportAsks()).toEqual([]);
  });

  it('searchFlights itself never sends a place-to-itself request', async () => {
    expect(await searchFlights({ origin: 'ZRH', destination: 'ZRH', date: '2030-12-10', travelers: 1 })).toEqual([]);
    expect(await searchFlights({ origin: 'LHR', destination: 'LON', date: '2030-12-10', travelers: 1 })).toEqual([]);
    expect(mockAsked).toEqual([]);
  });
});
