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
  handlers: Array<{ match: (body: string) => boolean; data: any | ((body: string) => any) }>,
) => {
  mockFetch.mockImplementation((_url: string, init: any) => {
    const body = init?.body ?? '';
    const handler = handlers.find((h) => h.match(body));
    if (!handler) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    return Promise.resolve(gqlOk(typeof handler.data === 'function' ? handler.data(body) : handler.data));
  });
};

/** How many passengers a getJourneyOffer request asked for. */
const adultsRequested = (body: string) => (body.match(/\{type: ADULT\}/g) ?? []).length;

/**
 * Like the real sandbox, the fare scales with the passenger count (measured
 * 2026-09-21: ratio 2.0002 for 2 adults). `perPersonCents` is what ONE adult
 * would pay; the fake returns that × the adults actually requested.
 */
const partyOfferResponse = (perPersonCents: number[]) => (body: string) =>
  offerResponse(perPersonCents.map((c) => c * adultsRequested(body)));

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
    { match: (b: string) => b.includes('getJourneyOffer'), data: partyOfferResponse([3985, 10133, 18786]) },
  ];

  const params = { origin: 'Paris', destination: 'Amsterdam', date: '2026-08-19', travelers: 2 };

  it('returns priced per-person offers with cents converted to dollars', async () => {
    routeFetch(happyHandlers());
    const offers = await searchAllAboard(params);
    expect(offers.length).toBeGreaterThan(0);
    // All Aboard returns no link at the offer stage (confirmed by them); the
    // old value here was their marketing homepage.
    expect(offers.every((o) => o.bookingUrl === null)).toBe(true);
    const cheapest = offers[0];
    // Per-person is the provider contract — searchTrains scales to the party.
    // params.travelers is 2, so the request carried two ADULTs, the fake
    // returned 7970 cents for the pair, and the adapter hands back 39.85.
    expect(cheapest.pricePerPerson).toBe(39.85);
    const offerCalls = mockFetch.mock.calls.filter(([, init]: any) => String(init?.body).includes('getJourneyOffer'));
    expect(offerCalls.length).toBeGreaterThan(0);
    expect(offerCalls.every(([, init]: any) => adultsRequested(String(init?.body)) === 2)).toBe(true);
    expect(cheapest.currency).toBe('USD');
    expect(cheapest.limitedCoverage).toBe(false);
    expect(cheapest.operator).toContain('Eurostar');
    expect(cheapest.id).toMatch(/^aa-/);
    // A real getJourneyOffer fare, from the TEST gateway (the default URL).
    expect(cheapest.priceSource).toEqual({ kind: 'live', provider: 'All Aboard', testApi: true });
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
    const priced = offers.filter((o) => o.pricePerPerson != null);
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
    expect(offers.every((o) => o.pricePerPerson === null && o.limitedCoverage)).toBe(true);
    expect(offers.every((o) => o.priceSource === undefined)).toBe(true);
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

describe('searchAllAboard: a journey sold as more than one ticket', () => {
  // Measured on the test gateway, Salzburg → Prague, 2027-03-21, 2 adults: the
  // 19:07 via Vienna is two SegmentCollections (two tickets), each with its
  // own fares — Salzburg → Wien from $257.20, Wien → Praha from $130.67.
  const salzburgPrague = {
    getJourneys: [
      {
        id: 'via-wien',
        status: 'SUCCESS',
        itinerary: [
          {
            status: 'SUCCESS',
            segments: [{ origin: { name: 'Salzburg Hbf' }, destination: { name: 'Wien Hbf' }, departureAt: '2027-03-21T19:07:00+01:00', arrivalAt: '2027-03-21T21:32:00+01:00', operator: { name: 'ÖBB' } }],
          },
          {
            status: 'SUCCESS',
            segments: [{ origin: { name: 'Wien Hbf' }, destination: { name: 'Praha hl.n.' }, departureAt: '2027-03-21T22:10:00+01:00', arrivalAt: '2027-03-22T03:09:00+01:00', operator: { name: 'ÖBB' } }],
          },
        ],
      },
    ],
  };
  const ticket = (status: string, cents: number[]) => ({
    status,
    offers: cents.map((amount, i) => ({ id: `o${i}`, price: { amount, currency: 'USD' } })),
  });
  const handlers = (tickets: any[]) => [
    { match: (b: string) => b.includes('getLocations') && b.includes('Salzburg'), data: { getLocations: [{ uid: 'szg', name: 'Salzburg' }] } },
    { match: (b: string) => b.includes('getLocations') && b.includes('Prague'), data: { getLocations: [{ uid: 'prg', name: 'Prague' }] } },
    { match: (b: string) => b.includes('getJourneys'), data: salzburgPrague },
    { match: (b: string) => b.includes('getJourneyOffer'), data: { getJourneyOffer: { itinerary: tickets } } },
  ];
  const params = { origin: 'Salzburg', destination: 'Prague', date: '2027-03-21', travelers: 2 };

  it('costs the cheapest fare of each ticket, added up', async () => {
    routeFetch(handlers([ticket('SUCCESS', [25720, 48932]), ticket('SUCCESS', [13067, 16340, 18521])]));
    const [offer] = await searchAllAboard(params);
    // ($257.20 + $130.67) for two adults — not $130.67, the Vienna → Prague
    // ticket alone, which taking the cheapest offer across tickets returned.
    expect(offer.pricePerPerson).toBeCloseTo(387.87 / 2, 2);
    expect(offer.limitedCoverage).toBe(false);
  });

  it('has no price when one of its tickets has no fare', async () => {
    // The same journey on 2027-03-20: Wien → Praha came back NO_FARES. The
    // Salzburg → Wien ticket's $257.20 is not the price of the trip.
    routeFetch(handlers([ticket('SUCCESS', [25720, 48932]), ticket('NO_FARES', [])]));
    const [offer] = await searchAllAboard(params);
    expect(offer.pricePerPerson).toBeNull();
    expect(offer.limitedCoverage).toBe(true);
    expect(offer.priceSource).toBeUndefined();
  });

  it('still prices a one-ticket journey at its cheapest fare', async () => {
    routeFetch(handlers([ticket('SUCCESS', [40817, 68806])]));
    const [offer] = await searchAllAboard(params);
    expect(offer.pricePerPerson).toBeCloseTo(204.085, 3);
  });
});

describe('provider registry integration', () => {
  it('searchTrains returns All Aboard results as party totals', async () => {
    jest.isolateModules(() => {
      /* re-import inside isolation below */
    });
    // Route by URL: All Aboard calls hit the gateway; anything else 503s.
    mockFetch.mockImplementation((url: string, init?: any) => {
      if (String(url).includes('api-gateway.allaboard.eu')) {
        const body = init?.body ?? '';
        if (body.includes('getLocations') && body.includes('Paris'))
          return Promise.resolve(gqlOk(parisLocations));
        if (body.includes('getLocations') && body.includes('Amsterdam'))
          return Promise.resolve(gqlOk(amsterdamLocations));
        if (body.includes('getJourneys')) return Promise.resolve(gqlOk(journeysResponse));
        if (body.includes('getJourneyOffer'))
          return Promise.resolve(gqlOk(partyOfferResponse([3985])(body)));
      }
      // No other rail service exists; nothing should land here.
      return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
    });

    // No rail provider touches Supabase; mocked so nothing can by accident.
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
      travelers: 2,
    }).then((offers: any[]) => {
      const aa = offers.filter((o) => o.id.startsWith('aa-'));
      expect(aa.length).toBeGreaterThan(0);
      // $39.85 is ONE adult's Eurostar fare; two travellers book two seats.
      // Party total is the unit every price leaves the backend in, so a
      // per-person fare arriving here unchanged is the headline bug.
      expect(aa[0].price).toBe(79.7);
      expect(aa[0].pricePerPerson).toBeUndefined();
      // The source survives the party-total scaling.
      expect(aa[0].priceSource).toMatchObject({ kind: 'live', provider: 'All Aboard' });
    });
  });
});
