/**
 * Trip context reaches pricing.
 *
 * getIataCode(name, { tripDestinationNames }) lets the trip decide which
 * Lagos: on a Lisbon + Porto trip it is Lagos, Portugal (FAO); bare, or next
 * to Paris, it stays Lagos, Nigeria (LOS). Until this change nothing that
 * PRICES passed the context, so a Portugal trip searched Lisbon → Lagos as
 * LIS → LOS and flew the traveller home from Nigeria.
 *
 * These run the REAL optimize() → compareLeg → legOptions → getIataCode →
 * location artifact. Only Duffel, Supabase and rail are mocked, and every
 * Duffel offer request is recorded.
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
    // Nothing here should need Duffel's fuzzy place search.
    suggestions: { list: jest.fn(async () => ({ data: [] })) },
  }),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

import { optimize } from '../services/optimizer';

const touches = (code: string) => mockAsked.filter((k) => k.split('>').includes(code));

beforeEach(() => {
  mockAsked.length = 0;
  for (const k of Object.keys(mockFares)) delete mockFares[k];
});

describe('trip context reaches pricing', () => {
  it('prices Lagos on a Lisbon + Porto trip from FAO — legs, return flight and alternatives', async () => {
    // Cheapest shape: fly into Lisbon, finish in Lagos, fly home from Faro.
    Object.assign(mockFares, {
      'LHR>LIS': 50,
      'LHR>OPO': 300,
      'LHR>FAO': 300,
      'FAO>LHR': 50,
      'LIS>LHR': 300,
      'OPO>LHR': 300,
    });

    const result = await optimize({
      cities: [{ name: 'Lisbon' }, { name: 'Porto' }, { name: 'Lagos' }],
      startDate: '2030-05-10',
      travelers: 1,
      origin: 'London',
      originAirports: ['LHR'],
      returnToHome: true,
      totalNights: 6,
    });

    expect(result.iataCodes.Lagos).toBe('FAO');
    expect(result.bestRoute.ordering[result.bestRoute.ordering.length - 1]).toBe('Lagos');
    expect(result.returnLeg?.originAirport).toBe('FAO');
    // Not one search touched Nigeria — scoring, date shift, home legs and
    // the winner's alternatives (legOptions) included.
    expect(touches('LOS')).toEqual([]);
    expect(touches('FAO').length).toBeGreaterThan(0);
  }, 60000);

  it('keeps bare Lagos as Lagos, Nigeria (LOS)', async () => {
    const result = await optimize({
      cities: [{ name: 'Lagos' }],
      startDate: '2030-05-20',
      travelers: 1,
      origin: 'London',
      originAirports: ['LHR'],
      returnToHome: true,
      totalNights: 4,
    });

    expect(result.iataCodes.Lagos).toBe('LOS');
    expect(result.outboundLeg?.destAirport).toBe('LOS');
    expect(touches('FAO')).toEqual([]);
  }, 60000);

  it('keeps Lagos with Paris as Lagos, Nigeria (LOS)', async () => {
    const result = await optimize({
      cities: [{ name: 'Paris' }, { name: 'Lagos' }],
      startDate: '2030-06-01',
      travelers: 1,
      origin: 'London',
      originAirports: ['LHR'],
      returnToHome: true,
      totalNights: 4,
    });

    expect(result.iataCodes.Lagos).toBe('LOS');
    expect(touches('FAO')).toEqual([]);
    expect(touches('LOS').length).toBeGreaterThan(0);
  }, 60000);
});
