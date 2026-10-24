/**
 * End-to-end cover for the reported bug: "from New Jersey" produced no home
 * flight at all, silently.
 *
 * This drives the real optimize() with `origin` set and `originAirports`
 * DELIBERATELY omitted, which is the state the bug report describes — the AI
 * hands back a literal place name and nothing pre-fills the IATA list. Duffel
 * and Supabase are mocked the same way optimizerHomeLegs.test.ts mocks them,
 * so no network call and no database write happen here.
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

// Same convention as optimizerHomeLegs.test.ts: IATA = first 3 letters.
// "New Jersey" would resolve to the junk code "NEW" if the origin lookup
// missed and we fell through to getIataCode().
jest.mock('../services/flights', () => ({
  getIataCode: jest.fn(async (name: string) => name.slice(0, 3).toUpperCase()),
  searchFlights: jest.fn(),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

import { optimize } from '../services/optimizer';
import { getIataCode, searchFlights } from '../services/flights';

const mockedSearchFlights = searchFlights as jest.Mock;
const mockedGetIataCode = getIataCode as jest.Mock;

const offer = (price: number) => ({
  id: `f-${price}`,
  price,
  durationMinutes: 120,
  carrier: 'Test Air',
  carrierCode: 'TA',
  departure: '',
  arrival: '',
  currency: 'USD',
  stops: 0,
  bookingUrl: '',
  raw: {},
});

/** Origins that searchFlights was asked about (i.e. the home airports used). */
function originsSearched(): string[] {
  return [
    ...new Set(
      mockedSearchFlights.mock.calls.map((c: any[]) => c[0].origin as string),
    ),
  ].sort();
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedSearchFlights.mockImplementation(async () => [offer(100)]);
});

describe('optimize — origin resolved from a state/region name', () => {
  it('searches the NJ metro airports for "New Jersey" and returns a home leg', async () => {
    const result = await optimize({
      cities: [{ name: 'Rome' }],
      startDate: '2030-07-01',
      travelers: 1,
      origin: 'New Jersey',
      // originAirports intentionally omitted — this is the bug's state.
      returnToHome: false,
    });

    // Before the alias fix this was [] and the home search never ran.
    expect(originsSearched()).toEqual(expect.arrayContaining(['EWR', 'JFK', 'LGA']));
    expect(result.outboundLeg).not.toBeNull();
    expect(['EWR', 'JFK', 'LGA']).toContain(result.outboundLeg!.originAirport);
  }, 30000);

  it('never falls through to the Duffel/DB getIataCode path for the origin', async () => {
    // getIataCode() hits Duffel AND upserts into the airport_codes table.
    // Resolving in-table avoids both. It is still called for destinations.
    await optimize({
      cities: [{ name: 'Rome' }],
      startDate: '2030-07-02',
      travelers: 1,
      origin: 'New Jersey',
      returnToHome: false,
    });

    const asked = mockedGetIataCode.mock.calls.map((c: any[]) => c[0]);
    expect(asked).not.toContain('New Jersey');
    // The junk code that the fallback would have produced is never searched.
    expect(originsSearched()).not.toContain('NEW');
  }, 30000);

  it.each([
    ['Newark', ['EWR', 'JFK', 'LGA']],
    ['Long Island', ['JFK', 'LGA']],
    ['Connecticut', ['BDL']],
  ])('resolves %s to real home airports end to end', async (origin, expected) => {
    const result = await optimize({
      cities: [{ name: 'Rome' }],
      startDate: '2030-08-01',
      travelers: 1,
      origin,
      returnToHome: false,
    });

    expect(originsSearched()).toEqual(expect.arrayContaining(expected));
    expect(result.outboundLeg).not.toBeNull();
    expect(expected).toContain(result.outboundLeg!.originAirport);
  }, 30000);

  it('still falls back to getIataCode for a name left out on purpose', async () => {
    // "Texas" is deliberately unmapped (DFW/IAH/AUS all plausible), so the
    // old single-code path must still be reachable rather than returning
    // nothing. This proves the fix narrowed the gap without closing the door.
    await optimize({
      cities: [{ name: 'Rome' }],
      startDate: '2030-09-01',
      travelers: 1,
      origin: 'Texas',
      returnToHome: false,
    });

    expect(mockedGetIataCode.mock.calls.map((c: any[]) => c[0])).toContain('Texas');
    expect(originsSearched()).toContain('TEX');
  }, 30000);
});
