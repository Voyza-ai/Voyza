jest.mock('../config/env', () => ({
  env: {
    ALLABOARD_API_KEY: 'k_test_key',
    ALLABOARD_API_URL: 'https://test.api-gateway.allaboard.eu',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { env } from '../config/env';
import {
  searchAllAboard,
  getAllAboardLocationUid,
  clearLocationCache,
} from '../services/allaboard';

// ── Fixtures mirror REAL response shapes from the test gateway ──────────

const gqlOk = (data: any) => ({
  ok: true,
  json: () => Promise.resolve({ data }),
});

const parisLocations = {
  getLocations: [
    { uid: '7N6Cj_NH', name: 'Paris' },
    { uid: 'QW9l6uNd', name: 'Palermo' }, // real fuzzy-match noise
    { uid: 'ovPXawh4', name: 'Paris Gare de Lyon' },
  ],
};

const amsterdamLocations = {
  getLocations: [{ uid: 'tPfl5r1Z', name: 'Amsterdam' }],
};

const journey = (id: string, dep: string, arr: string, ops: string[]) => ({
  id,
  itinerary: [
    {
      segments: ops.map((op, i) => ({
        origin: { name: i === 0 ? 'Paris Nord' : 'Bruxelles-Midi' },
        destination: { name: i === ops.length - 1 ? 'Amsterdam Centraal' : 'Bruxelles-Midi' },
        departureAt: dep,
        arrivalAt: arr,
        operator: { name: op },
      })),
    },
  ],
});

const journeysResponse = {
  getJourneys: [
    journey('j1', '2026-08-19T06:49:00+02:00', '2026-08-19T10:50:00+02:00', ['Eurostar']),
    journey('j2', '2026-08-19T09:47:00+02:00', '2026-08-19T13:42:00+02:00', [
      'Eurostar',
      'Nederlandse Spoorwegen (NS)',
    ]),
    journey('j3', '2026-08-19T18:20:00+02:00', '2026-08-19T22:20:00+02:00', ['Eurostar']),
  ],
};

// Offer amounts are CENTS (real API shape: $39.85 arrives as 3985).
const offerResponse = (cents: number[]) => ({
  getJourneyOffer: {
    itinerary: [
      {
        offers: cents.map((amount, i) => ({
          id: `o${i}`,
          price: { amount, currency: 'USD' },
        })),
      },
    ],
  },
});

/** Route fetch calls by query content so parallel calls stay deterministic. */
const routeFetch = (
  handlers: Array<{ match: (body: string) => boolean; data: any }>,
) => {
  mockFetch.mockImplementation((_url: string, init: any) => {
    const body = init?.body ?? '';
    const handler = handlers.find((h) => h.match(body));
    if (!handler) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    return Promise.resolve(gqlOk(handler.data));
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  clearLocationCache();
  (env as any).ALLABOARD_API_KEY = 'k_test_key';
});

describe('getAllAboardLocationUid', () => {
  it('picks the location matching the city, not fuzzy noise like Palermo', async () => {
    mockFetch.mockResolvedValueOnce(gqlOk(parisLocations));
    const uid = await getAllAboardLocationUid('Paris', 's1');
    expect(uid).toBe('7N6Cj_NH');
  });

  it('caches lookups so repeat searches skip the API', async () => {
    mockFetch.mockResolvedValueOnce(gqlOk(parisLocations));
    await getAllAboardLocationUid('Paris', 's1');
    await getAllAboardLocationUid('Paris', 's2');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns null (and caches it) for cities All Aboard does not know', async () => {
    mockFetch.mockResolvedValueOnce(gqlOk({ getLocations: [] }));
    expect(await getAllAboardLocationUid('Tokyo', 's1')).toBeNull();
    expect(await getAllAboardLocationUid('Tokyo', 's1')).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('searchAllAboard', () => {
  const happyHandlers = () => [
    { match: (b: string) => b.includes('getLocations') && b.includes('Paris'), data: parisLocations },
    { match: (b: string) => b.includes('getLocations') && b.includes('Amsterdam'), data: amsterdamLocations },
    { match: (b: string) => b.includes('getJourneys'), data: journeysResponse },
    { match: (b: string) => b.includes('getJourneyOffer'), data: offerResponse([3985, 10133, 18786]) },
  ];

  const params = { origin: 'Paris', destination: 'Amsterdam', date: '2026-08-19', travelers: 2 };

  it('returns priced per-person offers with cents converted to dollars', async () => {
    routeFetch(happyHandlers());
    const offers = await searchAllAboard(params);
    expect(offers.length).toBeGreaterThan(0);
    const cheapest = offers[0];
    expect(cheapest.price).toBe(39.85); // 3985 cents, cheapest of the three fares
    expect(cheapest.currency).toBe('USD');
    expect(cheapest.limitedCoverage).toBe(false);
    expect(cheapest.operator).toContain('Eurostar');
    expect(cheapest.id).toMatch(/^aa-/);
  });

  it('computes duration from segment times', async () => {
    routeFetch(happyHandlers());
    const offers = await searchAllAboard(params);
    // 06:49 → 10:50 = 4h 1m = 241 minutes.
    expect(offers[0].durationMinutes).toBe(241);
  });

  it('prices all journeys when there are 3 or fewer (spread selection)', async () => {
    routeFetch(happyHandlers());
    const offers = await searchAllAboard(params);
    const priced = offers.filter((o) => o.price != null);
    expect(priced).toHaveLength(3);
  });

  it('joins multi-operator journeys into one operator label', async () => {
    routeFetch(happyHandlers());
    const offers = await searchAllAboard(params);
    const multi = offers.find((o) => o.operator.includes('+'));
    expect(multi?.operator).toBe('Eurostar + Nederlandse Spoorwegen (NS)');
  });

  it('returns [] when no API key is configured (provider off)', async () => {
    (env as any).ALLABOARD_API_KEY = undefined;
    const offers = await searchAllAboard(params);
    expect(offers).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns [] when a city is outside coverage', async () => {
    routeFetch([
      { match: (b) => b.includes('getLocations') && b.includes('Paris'), data: parisLocations },
      { match: (b) => b.includes('getLocations') && b.includes('Hanoi'), data: { getLocations: [] } },
    ]);
    const offers = await searchAllAboard({ ...params, destination: 'Hanoi' });
    expect(offers).toEqual([]);
  });

  it('returns [] when the journeys call fails (non-fatal)', async () => {
    routeFetch([
      { match: (b) => b.includes('getLocations') && b.includes('Paris'), data: parisLocations },
      { match: (b) => b.includes('getLocations') && b.includes('Amsterdam'), data: amsterdamLocations },
      // no getJourneys handler → 500
    ]);
    await expect(searchAllAboard(params)).resolves.toEqual([]);
  });

  it('falls back to unpriced schedules (limitedCoverage) when pricing fails', async () => {
    routeFetch([
      { match: (b) => b.includes('getLocations') && b.includes('Paris'), data: parisLocations },
      { match: (b) => b.includes('getLocations') && b.includes('Amsterdam'), data: amsterdamLocations },
      { match: (b) => b.includes('getJourneys'), data: journeysResponse },
      // no getJourneyOffer handler → every pricing call 500s
    ]);
    const offers = await searchAllAboard(params);
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.price === null && o.limitedCoverage)).toBe(true);
  });

  it('skips journeys with empty itineraries', async () => {
    routeFetch([
      { match: (b) => b.includes('getLocations') && b.includes('Paris'), data: parisLocations },
      { match: (b) => b.includes('getLocations') && b.includes('Amsterdam'), data: amsterdamLocations },
      { match: (b) => b.includes('getJourneys'), data: { getJourneys: [{ id: 'empty', itinerary: [] }] } },
    ]);
    const offers = await searchAllAboard(params);
    expect(offers).toEqual([]);
  });

  it('sends the api-key and a session header on every request', async () => {
    routeFetch(happyHandlers());
    await searchAllAboard(params);
    for (const call of mockFetch.mock.calls) {
      expect(call[1].headers['api-key']).toBe('k_test_key');
      expect(call[1].headers.session).toBeTruthy();
    }
  });
});

describe('provider registry integration', () => {
  it('searchTrains merges All Aboard results with Deutsche Bahn', async () => {
    jest.isolateModules(() => {
      /* re-import inside isolation below */
    });
    // Route by URL: All Aboard calls hit the gateway, DB REST calls 500 out.
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (String(url).includes('api-gateway.allaboard.eu')) {
        const body = init?.body ?? '';
        if (body.includes('getLocations') && body.includes('Paris'))
          return Promise.resolve(gqlOk(parisLocations));
        if (body.includes('getLocations') && body.includes('Amsterdam'))
          return Promise.resolve(gqlOk(amsterdamLocations));
        if (body.includes('getJourneys')) return Promise.resolve(gqlOk(journeysResponse));
        if (body.includes('getJourneyOffer'))
          return Promise.resolve(gqlOk(offerResponse([3985])));
      }
      // Deutsche Bahn path: fail fast, provider returns [] non-fatally.
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    });

    // Supabase is only used by the DB provider's stop cache.
    jest.doMock('../services/supabase', () => ({
      getSupabase: () => ({
        from: () => ({
          select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
          upsert: () => Promise.resolve({ data: null }),
        }),
      }),
    }));

    const { searchTrains } = require('../services/trains');
    return searchTrains({
      origin: 'Paris',
      destination: 'Amsterdam',
      date: '2026-08-19',
      travelers: 1,
    }).then((offers: any[]) => {
      const aa = offers.filter((o) => o.id.startsWith('aa-'));
      expect(aa.length).toBeGreaterThan(0);
      expect(aa[0].price).toBe(39.85);
    });
  });
});
