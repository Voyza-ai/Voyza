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

  it('flags an ambiguous origin EVEN WHEN the caller supplied airports', async () => {
    // The bug this pins: the clarification used to be computed only in the
    // branch taken when `originAirports` was absent. The frontend answers
    // "Portland" from its own copy of the artifact with ["PDX","SLE"], so the
    // branch never ran in the real flow and the results page had nothing to
    // show. The two clearest ambiguous origins — Portland and Melbourne —
    // could therefore never produce the question, while a name the hot set
    // happened to MISS could. Exactly backwards.
    const result = await optimize({
      cities: [{ name: 'Rome' }],
      startDate: '2030-10-01',
      travelers: 1,
      origin: 'Portland',
      originAirports: ['PDX', 'SLE'], // what the frontend really sends
      returnToHome: false,
    });

    expect(result.originClarification).toBeDefined();
    expect(result.originClarification!.input).toBe('Portland');
    const labels = result.originClarification!.candidates.map((c) => c.label);
    expect(labels.length).toBeGreaterThan(1);
    expect(labels.some((l) => /Oregon/i.test(l))).toBe(true);
    expect(labels.some((l) => /Maine/i.test(l))).toBe(true);

    // ...and the caller's airports still decide what was actually PRICED.
    // The clarification must not quietly re-point the trip.
    expect(originsSearched()).toEqual(expect.arrayContaining(['PDX']));
    expect(originsSearched()).not.toContain('PWM');
  }, 30000);

  it('stays quiet for an origin with only one real reading', async () => {
    // Negative control: if this ever starts returning a clarification, the
    // rule has gone too broad and every trip grows a question it does not
    // need. Venice resolves cleanly despite Dayton, Ohio carrying "venice"
    // as a crowd-sourced alias.
    const result = await optimize({
      cities: [{ name: 'Rome' }],
      startDate: '2030-10-02',
      travelers: 1,
      origin: 'Venice',
      originAirports: ['VCE', 'TSF'],
      returnToHome: false,
    });

    expect(result.originClarification).toBeUndefined();
  }, 30000);

  it('still falls back to getIataCode for a name the resolver cannot answer', async () => {
    // Was "Texas", on the grounds that the retired table deliberately left it
    // unmapped. Texas now resolves (pinned to Dallas, Houston and Austin), so
    // that input no longer reaches this path at all.
    //
    // `Kyiv` does, and for a reason worth recording: Ukrainian airports carry
    // `scheduled_service=no` upstream, so the pipeline's filter drops them and
    // the city ships with no airports — which `answer()` refuses. 2,470 of
    // 36,009 places are airport-less this way, 300 of them Ukrainian.
    //
    // So the single-code path must stay reachable rather than the run
    // returning nothing. That is what this proves.
    await optimize({
      cities: [{ name: 'Rome' }],
      startDate: '2030-09-01',
      travelers: 1,
      origin: 'Kyiv',
      returnToHome: false,
    });

    expect(mockedGetIataCode.mock.calls.map((c: any[]) => c[0])).toContain('Kyiv');
    expect(originsSearched()).toContain('KYI');
  }, 30000);
});
