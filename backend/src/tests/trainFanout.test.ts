/**
 * Regression tests for the optimizer's train-search fan-out.
 *
 * The optimizer scores every candidate ordering in parallel, and each
 * ordering asks compareLeg → searchTrains for its legs. For a 5-city trip
 * that is 480 concurrent searchTrains calls for only 80 distinct legs.
 * Three things keep that from hammering the rail providers, and each has
 * a test here:
 *
 *   1. searchTrains dedupes concurrent calls for the same leg onto ONE
 *      in-flight promise (same pattern as flights.ts / Duffel).
 *   2. searchTrains gates how many distinct legs are searched at once.
 *   3. All Aboard's location cache stores the in-flight PROMISE, so
 *      concurrent lookups for the same city share one getLocations call
 *      instead of all missing (the key used to be written after the await).
 */

jest.mock('../config/env', () => ({
  env: {
    ALLABOARD_API_KEY: 'k_test_key',
    ALLABOARD_API_URL: 'https://test.api-gateway.allaboard.eu',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

// Only the Deutsche Bahn provider's stop cache touches Supabase.
jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
      upsert: () => Promise.resolve({ data: null }),
    }),
  }),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { searchTrains, clearTrainSearchCache } from '../services/trains';
import { getAllAboardLocationUid, clearLocationCache } from '../services/allaboard';

const gqlOk = (data: any) => ({ ok: true, json: () => Promise.resolve({ data }) });

/** Let every pending microtask and I/O callback run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  clearTrainSearchCache();
  clearLocationCache();
});

describe('searchTrains fan-out', () => {
  it('dedupes concurrent calls per leg, gates distinct legs at 8, and looks each city up once', async () => {
    let locationCalls = 0;
    let journeyCalls = 0;
    let inFlightJourneys = 0;
    let peakJourneys = 0;
    // Each getJourneys call parks here until the test releases it, so we
    // can observe how many the gate lets through at once.
    const gates: Array<() => void> = [];

    mockFetch.mockImplementation((url: string, init?: any) => {
      if (!String(url).includes('allaboard.eu')) {
        // Deutsche Bahn REST: fail fast, provider returns [] non-fatally.
        return Promise.reject(new Error('DB REST down'));
      }
      const body = JSON.parse(init?.body ?? '{}');
      const query: string = body.query ?? '';
      if (query.includes('getLocations')) {
        locationCalls++;
        const city: string = body.variables.q;
        return Promise.resolve(gqlOk({ getLocations: [{ uid: `uid-${city}`, name: city }] }));
      }
      if (query.includes('getJourneys')) {
        journeyCalls++;
        inFlightJourneys++;
        peakJourneys = Math.max(peakJourneys, inFlightJourneys);
        return new Promise<void>((resolve) => gates.push(resolve)).then(() => {
          inFlightJourneys--;
          return gqlOk({
            getJourneys: [
              {
                id: `j-${body.variables.o}-${body.variables.d}`,
                itinerary: [
                  {
                    segments: [
                      {
                        origin: { name: 'A' },
                        destination: { name: 'B' },
                        departureAt: '2026-10-01T08:00:00+02:00',
                        arrivalAt: '2026-10-01T10:00:00+02:00',
                        operator: { name: 'Rail' },
                      },
                    ],
                  },
                ],
              },
            ],
          });
        });
      }
      if (query.includes('getJourneyOffer')) {
        return Promise.resolve(
          gqlOk({ getJourneyOffer: { itinerary: [{ offers: [{ id: 'o1', price: { amount: 4200, currency: 'USD' } }] }] } }),
        );
      }
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    });

    // 5 cities → 12 distinct legs, each requested 3 times concurrently, the
    // way 3 orderings that share a leg would.
    const cities = ['Paris', 'Rome', 'Madrid', 'Amsterdam', 'Lisbon'];
    const legs: Array<[string, string]> = [];
    for (const a of cities) for (const b of cities) if (a !== b && legs.length < 12) legs.push([a, b]);
    expect(legs).toHaveLength(12);

    const results = legs.flatMap(([origin, destination]) =>
      [0, 1, 2].map(() => searchTrains({ origin, destination, date: '2026-10-01', travelers: 1 })),
    );
    expect(results).toHaveLength(36);

    await settle();
    // Gate: only 8 of the 12 distinct legs got as far as getJourneys.
    expect(journeyCalls).toBe(8);
    expect(gates).toHaveLength(8);

    // Drain: releasing one journey frees one slot, which admits the next leg.
    let guard = 0;
    while (journeyCalls < 12 || gates.length > 0) {
      gates.shift()?.();
      await settle();
      if (++guard > 100) throw new Error('fan-out test did not drain');
    }
    const offers = await Promise.all(results);

    expect(journeyCalls).toBe(12); // dedupe: 36 calls → 12 provider searches
    expect(peakJourneys).toBe(8); // gate: never more than 8 in flight
    expect(locationCalls).toBe(5); // promise cache: one getLocations per city
    // Every duplicate caller got the same (deduped) result.
    for (let i = 0; i < 12; i++) {
      expect(offers[i * 3 + 1]).toBe(offers[i * 3]);
      expect(offers[i * 3 + 2]).toBe(offers[i * 3]);
    }
    expect(offers[0][0].price).toBe(42);
  });

  it('does not cache a failed search, so the next caller retries', async () => {
    // Every request fails → both providers return [] non-fatally. That is
    // not "no trains on this route": All Aboard timing out on a cold search
    // used to be cached for 10 minutes, so every trip search in that window
    // priced the route on flights only. The next caller must search again.
    mockFetch.mockRejectedValue(new Error('everything down'));
    const params = { origin: 'Oslo', destination: 'Bergen', date: '2026-10-01', travelers: 1 };
    await expect(searchTrains(params)).resolves.toEqual([]);
    await settle();
    const callsAfterFirst = mockFetch.mock.calls.length;
    await expect(searchTrains(params)).resolves.toEqual([]);
    expect(mockFetch.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('retries a route whose first search timed out, and finds the train once All Aboard answers', async () => {
    // The production failure, 2026-11-17: Vienna → Munich's first getJourneys
    // ran past the 10s timeout (cold gateway), later ones answered in ~4s.
    let journeysFail = true;
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (!String(url).includes('allaboard.eu')) return Promise.reject(new Error('DB REST down'));
      const body = JSON.parse(init?.body ?? '{}');
      const query: string = body.query ?? '';
      if (query.includes('getLocations')) {
        return Promise.resolve(gqlOk({ getLocations: [{ uid: `uid-${body.variables.q}`, name: body.variables.q }] }));
      }
      if (query.includes('getJourneys')) {
        if (journeysFail) return Promise.reject(new Error('The operation was aborted'));
        return Promise.resolve(
          gqlOk({
            getJourneys: [
              {
                id: 'j1',
                itinerary: [
                  {
                    segments: [
                      {
                        origin: { name: 'Wien Hbf' },
                        destination: { name: 'München Hbf' },
                        departureAt: '2026-12-23T14:28:00+01:00',
                        arrivalAt: '2026-12-23T18:31:00+01:00',
                        operator: { name: 'ÖBB' },
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        );
      }
      if (query.includes('getJourneyOffer')) {
        return Promise.resolve(
          gqlOk({ getJourneyOffer: { itinerary: [{ offers: [{ id: 'o1', price: { amount: 5605, currency: 'USD' } }] }] } }),
        );
      }
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    });
    const params = { origin: 'Vienna', destination: 'Munich', date: '2026-12-23', travelers: 2, originCountry: 'AT', destinationCountry: 'DE' };
    await expect(searchTrains(params)).resolves.toEqual([]);
    await settle();
    journeysFail = false;
    const second = await searchTrains(params);
    expect(second).toHaveLength(1);
    expect(second[0].operator).toBe('ÖBB');
    expect(second[0].price).toBeCloseTo(56.05, 2);
  });

  it('does not cache a search whose fares did not come back, so the price is fetched again', async () => {
    let pricingFails = true;
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (!String(url).includes('allaboard.eu')) return Promise.reject(new Error('DB REST down'));
      const body = JSON.parse(init?.body ?? '{}');
      const query: string = body.query ?? '';
      if (query.includes('getLocations')) {
        return Promise.resolve(gqlOk({ getLocations: [{ uid: `uid-${body.variables.q}`, name: body.variables.q }] }));
      }
      if (query.includes('getJourneys')) {
        return Promise.resolve(
          gqlOk({
            getJourneys: [
              {
                id: 'j1',
                itinerary: [{ segments: [{ origin: { name: 'A' }, destination: { name: 'B' }, departureAt: '2026-12-23T08:00:00+01:00', arrivalAt: '2026-12-23T12:00:00+01:00', operator: { name: 'DB' } }] }],
              },
            ],
          }),
        );
      }
      if (query.includes('getJourneyOffer')) {
        if (pricingFails) return Promise.reject(new Error('The operation was aborted'));
        return Promise.resolve(gqlOk({ getJourneyOffer: { itinerary: [{ offers: [{ id: 'o1', price: { amount: 3000, currency: 'USD' } }] }] } }));
      }
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    });
    const params = { origin: 'Munich', destination: 'Vienna', date: '2026-12-23', travelers: 1 };
    const first = await searchTrains(params);
    expect(first[0].price).toBeNull(); // timetable row, unpriced
    await settle();
    pricingFails = false;
    const second = await searchTrains(params);
    expect(second[0].price).toBe(30);
  });

  it('still caches an honest "no trains on this route" answer', async () => {
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (!String(url).includes('allaboard.eu')) {
        // Deutsche Bahn answers: no journeys.
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ journeys: [] }) });
      }
      const body = JSON.parse(init?.body ?? '{}');
      const query: string = body.query ?? '';
      if (query.includes('getLocations')) {
        return Promise.resolve(gqlOk({ getLocations: [{ uid: `uid-${body.variables.q}`, name: body.variables.q }] }));
      }
      if (query.includes('getJourneys')) return Promise.resolve(gqlOk({ getJourneys: [] }));
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    });
    const params = { origin: 'Reykjavik', destination: 'Akureyri', date: '2026-10-01', travelers: 1 };
    await expect(searchTrains(params)).resolves.toEqual([]);
    await settle();
    const callsAfterFirst = mockFetch.mock.calls.length;
    await expect(searchTrains(params)).resolves.toEqual([]);
    expect(mockFetch.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('All Aboard location cache', () => {
  it('shares one getLocations call across concurrent lookups for the same city', async () => {
    let release: (() => void) | undefined;
    mockFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(gqlOk({ getLocations: [{ uid: '7N6Cj_NH', name: 'Paris' }] }));
        }),
    );

    const lookups = ['s1', 's2', 's3', 's4', 's5'].map((s) => getAllAboardLocationUid('Paris', s));
    await settle();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    release!();
    const uids = await Promise.all(lookups);
    expect(uids).toEqual(['7N6Cj_NH', '7N6Cj_NH', '7N6Cj_NH', '7N6Cj_NH', '7N6Cj_NH']);
    // Still one call after everything settled — the cache kept the promise.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('evicts a rejected lookup so the next caller gets a fresh attempt', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('gateway blip'))
      .mockResolvedValueOnce(gqlOk({ getLocations: [{ uid: 'B1', name: 'Berlin' }] }));

    await expect(getAllAboardLocationUid('Berlin', 's1')).rejects.toThrow('gateway blip');
    await expect(getAllAboardLocationUid('Berlin', 's2')).resolves.toBe('B1');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
