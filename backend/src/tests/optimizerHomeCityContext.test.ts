/**
 * The HOME city is resolved with NO trip context.
 *
 * Trip context exists to tell which destination a shared name means: Lagos
 * on a Lisbon + Porto trip is Faro. It says nothing about where the traveller
 * lives — if anything, a Portugal itinerary makes Lagos, Portugal LESS likely
 * to be home. Two optimizer paths resolve the home name through getIataCode,
 * and both used the run's destination context:
 *  - buildHomeLeg's metro fallback (none of the given home airports had
 *    offers): home "Lagos" flew from Faro;
 *  - the origin fallback (the origin resolver found nothing): a home town
 *    only Duffel knows was checked against the DESTINATIONS' locations, so
 *    its own, correct suggestion was refused and the trip had no home flight.
 * Real optimize() -> getIataCode -> location artifact; Duffel (offers and
 * place search), Supabase and rail mocked; every offer request recorded.
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

// Fares by IATA pair; anything unlisted is $100. `asked` records every search.
const mockAsked: string[] = [];
const mockFares: Record<string, number> = {};
jest.mock('../services/duffel', () => ({
  getDuffel: () => ({
    offerRequests: {
      create: jest.fn(async (body: any) => {
        const s = body.slices[0];
        mockAsked.push(`${s.origin}>${s.destination}`);
        // ZZZ is a home airport with no flights at all.
        if (s.origin === 'ZZZ' || s.destination === 'ZZZ') return { data: { offers: [] } };
        const price = mockFares[`${s.origin}>${s.destination}`] ?? 100;
        return {
          data: {
            offers: [
              {
                id: `o-${s.origin}-${s.destination}-${s.departure_date}`,
                total_amount: String(price),
                total_currency: 'USD',
                slices: [
                  {
                    duration: 'PT2H',
                    segments: [
                      {
                        departing_at: `${s.departure_date}T09:00:00`,
                        arriving_at: `${s.departure_date}T11:00:00`,
                        origin: { time_zone: 'Europe/London' },
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
    // Fuzzy place search knows one made-up home town, in Kansas, US.
    suggestions: {
      list: jest.fn(async ({ query }: { query: string }) => ({
        data:
          query === 'Hometownville'
            ? [
                {
                  type: 'city',
                  iata_code: 'HTV',
                  iata_country_code: 'US',
                  name: 'Hometownville',
                  latitude: 38.5,
                  longitude: -98.0,
                },
              ]
            : [],
      })),
    },
  }),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

import { optimize } from '../services/optimizer';

const touches = (code: string) => mockAsked.filter((k) => k.split('>').includes(code));

beforeEach(() => {
  mockAsked.length = 0;
});

describe('home city lookups take no trip context', () => {
  it("metro fallback: home 'Lagos' on a Lisbon + Porto trip flies from LOS, not FAO", async () => {
    // ZZZ has no offers, so buildHomeLeg falls back to the home city's code.
    const result = await optimize({
      cities: [{ name: 'Lisbon' }, { name: 'Porto' }],
      startDate: '2030-09-01',
      travelers: 1,
      origin: 'Lagos',
      originAirports: ['ZZZ'],
      returnToHome: true,
      totalNights: 4,
    });

    expect(result.outboundLeg?.originAirport).toBe('LOS');
    expect(result.returnLeg?.destAirport).toBe('LOS');
    expect(touches('FAO')).toEqual([]);
  }, 60000);

  it('the same name as home AND destination gets one answer for each (LOS home, FAO stop)', async () => {
    const result = await optimize({
      cities: [{ name: 'Lisbon' }, { name: 'Porto' }, { name: 'Lagos' }],
      startDate: '2030-09-10',
      travelers: 1,
      origin: 'Lagos',
      originAirports: ['ZZZ'],
      returnToHome: true,
      totalNights: 6,
    });

    expect(result.iataCodes.Lagos).toBe('FAO');
    expect(result.outboundLeg?.originAirport).toBe('LOS');
    // Every LOS search is a home flight; no stop of the trip was priced as LOS.
    for (const key of touches('LOS')) {
      const [from, to] = key.split('>');
      expect(['LIS', 'OPO', 'FAO']).toContain(from === 'LOS' ? to : from);
    }
    expect(touches('FAO').length).toBeGreaterThan(0);
  }, 60000);

  it("origin fallback: a home town only Duffel knows is not refused for being far from the trip", async () => {
    // No originAirports and the origin resolver cannot read the name, so the
    // optimizer asks getIataCode. Checked against Lisbon/Porto, Duffel's
    // Kansas answer was refused (404) and the trip had no home flight.
    const result = await optimize({
      cities: [{ name: 'Lisbon' }, { name: 'Porto' }],
      startDate: '2030-09-20',
      travelers: 1,
      origin: 'Hometownville',
      returnToHome: true,
      totalNights: 4,
    });

    expect(result.outboundLeg?.originAirport).toBe('HTV');
    expect(result.returnLeg?.destAirport).toBe('HTV');
  }, 60000);

  it('destination lookups keep their context (Lagos on the Portugal trip is still FAO)', async () => {
    const result = await optimize({
      cities: [{ name: 'Lisbon' }, { name: 'Porto' }, { name: 'Lagos' }],
      startDate: '2030-09-30',
      travelers: 1,
      origin: 'London',
      originAirports: ['LHR'],
      returnToHome: true,
      totalNights: 6,
    });
    expect(result.iataCodes.Lagos).toBe('FAO');
    expect(touches('LOS')).toEqual([]);
  }, 60000);
});
