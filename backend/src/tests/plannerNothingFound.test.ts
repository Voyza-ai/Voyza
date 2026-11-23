/**
 * A leg where NOTHING bookable was found: no train and no flight.
 *
 * Live, 2026-11-23: "Plan a similar trip" on the Lisbon & Sintra Escape
 * preset — All Aboard doesn't cover Portugal's CP trains, the Deutsche Bahn
 * community API was down, and nothing flies Lisbon → Sintra. The card said
 * "No direct option / Try Rome2Rio" and the banner "We couldn't find a way
 * from Lisbon to Sintra", for a 40-minute train ride.
 *
 * Now compareLeg attaches a ground ESTIMATE from distance (routeGeo
 * groundEstimateFor) when the hop is close and on one landmass — never a
 * fare — and nothing when it isn't (far, or across the sea).
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

const mockIata: Record<string, string> = { Lisbon: 'LIS', Sintra: 'LIS', Berlin: 'BER', Barcelona: 'BCN', Palma: 'PMI' };
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

// No train for any leg: All Aboard has no CP (Portugal) coverage, and the DB API was down.
jest.mock('../services/trains', () => ({ searchTrains: jest.fn().mockResolvedValue([]) }));

import { compareLeg } from '../services/compareLeg';
import { groundEstimateFor, groundEstimateMinutes } from '../services/routeGeo';
import { searchFlights } from '../services/flights';

const mockedSearchFlights = searchFlights as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockedSearchFlights.mockResolvedValue([]);
});

describe('compareLeg with no train and no flight', () => {
  it('Lisbon → Sintra (≈ 22 km): unavailable, with a ground estimate of 35–45 min and no price', async () => {
    const r = await compareLeg({ origin: 'Lisbon', destination: 'Sintra', date: '2026-12-26', travelers: 2 });
    expect(r.recommendation).toBe('unavailable');
    expect(r.flightOption).toBeNull();
    expect(r.trainOption).toBeNull();
    expect((r as any).groundEstimate).toEqual({ minutes: [35, 45], km: 22 });
    expect(JSON.stringify((r as any).groundEstimate)).not.toMatch(/price|fare/i);
  });

  it('Lisbon → Berlin (far): no estimate — stays "No direct option"', async () => {
    const r = await compareLeg({ origin: 'Lisbon', destination: 'Berlin', date: '2026-12-26', travelers: 2 });
    expect(r.recommendation).toBe('unavailable');
    expect((r as any).groundEstimate).toBeUndefined();
  });

  it('Barcelona → Palma (across the sea): no estimate', async () => {
    const r = await compareLeg({ origin: 'Barcelona', destination: 'Palma', date: '2026-12-26', travelers: 2 });
    expect((r as any).groundEstimate).toBeUndefined();
  });
});

describe('groundEstimateFor: only close hops on one landmass', () => {
  it.each([
    ['Lisbon', 'Sintra', true],
    ['Lisbon', 'Porto', true],
    ['Florence', 'Siena', true],
    ['Vienna', 'Bratislava', true], // land border
    ['Strasbourg', 'Basel', true],
    ['Dublin', 'Belfast', true], // the Irish land border
    ['Lisbon', 'Berlin', false], // far
    ['Barcelona', 'Palma', false], // Balearics
    ['Tallinn', 'Helsinki', false], // Gulf of Finland
    ['London', 'Dublin', false], // Irish Sea
    ['London', 'Belfast', false],
    ['Naples', 'Ischia', false], // island inside Campania
    ['Southampton', 'Cowes', false], // Isle of Wight
    ['Athens', 'Mykonos', false], // archipelago
  ])('%s → %s: %s', (a, b, expected) => {
    expect(groundEstimateFor(a as string, b as string) != null).toBe(expected);
  });

  it('minutes under two hours, rounded to 5; hours above', () => {
    expect(groundEstimateMinutes(22)).toEqual([35, 45]);
    expect(groundEstimateMinutes(275)).toEqual([240, 360]); // Lisbon → Porto: 4–6 h
  });
});
