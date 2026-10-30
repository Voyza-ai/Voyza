// Mock environment before any imports
jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
    FRONTEND_URL: 'http://localhost:3000',
  },
}));

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null }),
        }),
      }),
      upsert: () => Promise.resolve({ data: null }),
    }),
  }),
}));

jest.mock('../services/duffel', () => {
  const mockDuffel = {
    offerRequests: {
      create: jest.fn(),
    },
    suggestions: {
      list: jest.fn(),
    },
  };
  return {
    getDuffel: () => mockDuffel,
    __mockDuffel: mockDuffel,
  };
});

import { searchFlights, getIataCode, sliceDurationMinutes, retryDelayFromHeaders } from '../services/flights';

const { __mockDuffel: mockDuffel } = require('../services/duffel');

/**
 * Build a segment in the shape Duffel really returns.
 *
 * The important detail is that `departing_at` / `arriving_at` carry NO UTC
 * offset — they are local wall-clock times at each airport. The fixtures here
 * used to append 'Z', which quietly turned them into instants and hid the
 * timezone bug entirely: a westbound flight computed a NEGATIVE duration in
 * production while the suite stayed green. Never put an offset on these.
 */
function segment(opts: {
  departingAt: string;
  arrivingAt: string;
  originIata: string;
  originTimeZone: string;
  destinationIata: string;
  destinationTimeZone: string;
  duration?: string | null;
  carrier?: { name: string; iata_code: string };
}) {
  return {
    departing_at: opts.departingAt,
    arriving_at: opts.arrivingAt,
    duration: opts.duration ?? null,
    origin: { iata_code: opts.originIata, time_zone: opts.originTimeZone },
    destination: {
      iata_code: opts.destinationIata,
      time_zone: opts.destinationTimeZone,
    },
    operating_carrier: opts.carrier ?? { name: 'Lufthansa', iata_code: 'LH' },
  };
}

describe('searchFlights', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes Duffel offer response into FlightOffer[]', async () => {
    mockDuffel.offerRequests.create.mockResolvedValue({
      data: {
        offers: [
          {
            id: 'offer_1',
            total_amount: '199.99',
            total_currency: 'USD',
            slices: [
              {
                duration: 'PT2H30M',
                segments: [
                  segment({
                    departingAt: '2026-06-01T08:00:00',
                    arrivingAt: '2026-06-01T10:30:00',
                    originIata: 'FCO',
                    originTimeZone: 'Europe/Rome',
                    destinationIata: 'FLR',
                    destinationTimeZone: 'Europe/Rome',
                    duration: 'PT2H30M',
                  }),
                ],
              },
            ],
          },
        ],
      },
    });

    const offers = await searchFlights({
      origin: 'FCO',
      destination: 'FLR',
      date: '2026-06-01',
      travelers: 1,
    });

    expect(offers).toHaveLength(1);
    expect(offers[0].price).toBe(199.99);
    expect(offers[0].carrier).toBe('Lufthansa');
    expect(offers[0].carrierCode).toBe('LH');
    expect(offers[0].stops).toBe(0);
    expect(offers[0].durationMinutes).toBe(150);
    // Booking URLs now route to Google Flights (Duffel's offer-redirect
    // pages 404'd). The URL is built from origin/destination/date, not
    // the offer ID, so we assert on the Google host instead of `offer_1`.
    expect(offers[0].bookingUrl).toContain('google.com/travel/flights');
    expect(offers[0].bookingUrl).toContain('FCO');
    expect(offers[0].bookingUrl).toContain('FLR');
  });

  it('retries on 429 with exponential backoff', async () => {
    const error429 = new Error('Rate limited');
    (error429 as any).meta = { status: 429 };

    mockDuffel.offerRequests.create
      .mockRejectedValueOnce(error429)
      .mockResolvedValueOnce({
        data: {
          offers: [
            {
              id: 'offer_2',
              total_amount: '99.00',
              total_currency: 'EUR',
              slices: [
                {
                  duration: 'PT1H30M',
                  segments: [
                    segment({
                      departingAt: '2026-06-01T12:00:00',
                      arrivingAt: '2026-06-01T13:30:00',
                      originIata: 'BCN',
                      originTimeZone: 'Europe/Madrid',
                      destinationIata: 'LIS',
                      destinationTimeZone: 'Europe/Lisbon',
                      duration: 'PT1H30M',
                      carrier: { name: 'Ryanair', iata_code: 'FR' },
                    }),
                  ],
                },
              ],
            },
          ],
        },
      });

    const offers = await searchFlights({
      origin: 'BCN',
      destination: 'LIS',
      date: '2026-06-01',
      travelers: 1,
    });

    expect(offers).toHaveLength(1);
    expect(mockDuffel.offerRequests.create).toHaveBeenCalledTimes(2);
  }, 15000);

  it('reports a westbound date-line flight as positive minutes', async () => {
    // NRT 21:00 JST → HNL 09:00 HST on the SAME calendar day. Subtracting
    // these naive timestamps gave -720, which rendered as a blank duration
    // and made the flight beat every train door-to-door.
    mockDuffel.offerRequests.create.mockResolvedValue({
      data: {
        offers: [
          {
            id: 'offer_nrt_hnl',
            total_amount: '780.00',
            total_currency: 'USD',
            slices: [
              {
                duration: null, // airline gave no duration — force the fallback
                segments: [
                  segment({
                    departingAt: '2026-06-01T21:00:00',
                    arrivingAt: '2026-06-01T09:00:00',
                    originIata: 'NRT',
                    originTimeZone: 'Asia/Tokyo',
                    destinationIata: 'HNL',
                    destinationTimeZone: 'Pacific/Honolulu',
                    carrier: { name: 'Japan Airlines', iata_code: 'JL' },
                  }),
                ],
              },
            ],
          },
        ],
      },
    });

    const offers = await searchFlights({
      origin: 'NRT',
      destination: 'HNL',
      date: '2026-06-01',
      travelers: 1,
    });

    expect(offers[0].durationMinutes).toBe(420);
  });
});

describe('sliceDurationMinutes', () => {
  it('prefers the airline ISO duration over any arithmetic', () => {
    const slice = {
      duration: 'PT7H35M',
      segments: [
        segment({
          // Deliberately inconsistent with the slice duration: if this ever
          // returns 420 the provider field is being ignored.
          departingAt: '2026-06-01T21:00:00',
          arrivingAt: '2026-06-01T09:00:00',
          originIata: 'NRT',
          originTimeZone: 'Asia/Tokyo',
          destinationIata: 'HNL',
          destinationTimeZone: 'Pacific/Honolulu',
        }),
      ],
    };
    expect(sliceDurationMinutes(slice)).toBe(455);
  });

  it('uses the slice duration for a multi-segment itinerary, layovers included', () => {
    const slice = {
      duration: 'PT13H50M',
      segments: [
        segment({
          departingAt: '2026-06-01T18:30:00',
          arrivingAt: '2026-06-02T06:45:00',
          originIata: 'JFK',
          originTimeZone: 'America/New_York',
          destinationIata: 'CDG',
          destinationTimeZone: 'Europe/Paris',
          duration: 'PT7H15M',
        }),
        segment({
          departingAt: '2026-06-02T10:20:00',
          arrivingAt: '2026-06-02T12:20:00',
          originIata: 'CDG',
          originTimeZone: 'Europe/Paris',
          destinationIata: 'FCO',
          destinationTimeZone: 'Europe/Rome',
          duration: 'PT2H',
        }),
      ],
    };
    // 7h15 flying + 3h35 layover + 2h flying — not the 9h15 of flight time.
    expect(sliceDurationMinutes(slice)).toBe(830);
  });

  it('falls back to the segment duration on a single-segment slice', () => {
    const slice = {
      duration: null,
      segments: [
        segment({
          departingAt: '2026-06-01T08:00:00',
          arrivingAt: '2026-06-01T09:00:00',
          originIata: 'FCO',
          originTimeZone: 'Europe/Rome',
          destinationIata: 'FLR',
          destinationTimeZone: 'Europe/Rome',
          duration: 'PT55M',
        }),
      ],
    };
    expect(sliceDurationMinutes(slice)).toBe(55);
  });

  it('falls back to zone-aware arithmetic when no ISO duration is given', () => {
    const slice = {
      duration: null,
      segments: [
        segment({
          departingAt: '2026-06-01T22:00:00',
          arrivingAt: '2026-06-02T10:00:00',
          originIata: 'JFK',
          originTimeZone: 'America/New_York',
          destinationIata: 'LHR',
          destinationTimeZone: 'Europe/London',
        }),
      ],
    };
    // 12h on the clock, 7h in the air.
    expect(sliceDurationMinutes(slice)).toBe(420);
  });

  it('returns null rather than a negative number when the payload is unusable', () => {
    // No ISO duration and no airport time zones: nothing to anchor the
    // naive timestamps to, so the honest answer is "unknown".
    expect(
      sliceDurationMinutes({
        duration: null,
        segments: [
          {
            departing_at: '2026-06-01T21:00:00',
            arriving_at: '2026-06-01T09:00:00',
            duration: null,
            origin: { iata_code: 'NRT' },
            destination: { iata_code: 'HNL' },
          },
        ],
      }),
    ).toBeNull();

    expect(sliceDurationMinutes({ duration: null, segments: [] })).toBeNull();
    expect(sliceDurationMinutes(undefined)).toBeNull();
  });

  it('never returns a non-positive duration', () => {
    const slice = {
      duration: 'PT0M',
      segments: [
        segment({
          departingAt: '2026-06-01T10:00:00',
          arrivingAt: '2026-06-01T10:00:00',
          originIata: 'FCO',
          originTimeZone: 'Europe/Rome',
          destinationIata: 'FCO',
          destinationTimeZone: 'Europe/Rome',
          duration: 'PT0M',
        }),
      ],
    };
    expect(sliceDurationMinutes(slice)).toBeNull();
  });
});

describe('getIataCode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('caches IATA codes in Supabase', async () => {
    mockDuffel.suggestions.list.mockResolvedValue({
      data: [
        {
          type: 'airport',
          iata_code: 'ZRH',
          iata_country_code: 'CH',
          name: 'Zürich Airport',
          latitude: 47.4647,
          longitude: 8.5492,
        },
      ],
    });

    // A name neither the curated map NOR the artifact answers, so this
    // exercises the Duffel + Supabase cache path. It used to be Verona ->
    // FCO, which the artifact now answers as VRN, its own airport — and
    // which a suggestion check would refuse anyway. The trip is what lets a
    // suggestion be checked, and so cached: see getIataCodeArtifact.test.ts.
    const code = await getIataCode('Wengen', { tripDestinationNames: ['Zurich'] });
    expect(code).toBe('ZRH');
  });

  it('uses the curated override before Duffel for known cities', async () => {
    // Kyoto has no airport of its own; the override maps it to the Osaka
    // metro so it never mis-resolves (it previously returned ACC, Accra).
    //
    // OSA rather than KIX since the destination-side decisions in
    // `data/cityAirports.ts` were made: one metro code searches Kansai,
    // Itami and Kobe, and the Tokyo-Itami service is how a traveller on a
    // multi-city Japan trip actually reaches Kyoto. The KIX pin that stops a
    // HOME leg being priced from Itami is a separate, opposite decision and
    // lives in `scripts/location-data/curated.ts`;
    // `cityAirportsDecisions.test.ts` asserts both.
    const code = await getIataCode('Kyoto');
    expect(code).toBe('OSA');
    expect(mockDuffel.suggestions.list).not.toHaveBeenCalled();
  });

  it('throws AppError when no IATA code found', async () => {
    mockDuffel.suggestions.list.mockResolvedValue({ data: [] });

    // Not `Atlantis` any more: the artifact knows Atlantis, Western Cape,
    // 47 km from Cape Town, and answers CPT.
    await expect(getIataCode('Zzyzx')).rejects.toThrow('No IATA code found');
  });
});

describe('retryDelayFromHeaders', () => {
  const errWith = (headers: Record<string, string>) => ({
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  });

  /**
   * The clock is frozen for every case in this block.
   *
   * Each absolute-time case builds its header from `Date.now()` and then
   * hands it to `retryDelayFromHeaders`, which reads the clock a SECOND
   * time. On a real clock the millisecond can tick between those two reads
   * and the delta comes back short: `Expected: 60000, Received: 59999`.
   * Measured here, that is 498 bad deltas in 200,000 executions (495 of
   * them exactly 59999), which surfaces as 1 red run in 200 on an idle
   * machine and 3 in 60 under CPU contention — the ~6% CI flake.
   *
   * Freezing is also what lets these assert EXACT values instead of a
   * tolerance band, and the band is the part that mattered. Two of the
   * forms below truncate: `toUTCString()` has no sub-second field, and the
   * epoch-seconds form floors to whole seconds. So they only ever land on a
   * round 45s when "now" is itself on a whole second — on a real clock an
   * exact assertion there is right 122 times in 200,000. Hence a frozen
   * instant on `.000Z` rather than slop added back: a tolerance band is
   * precisely what let the off-by-a-second `Date.parse` bugs documented on
   * `parseResetHeader` through in the first place, so a band is the one
   * thing these tests must not use.
   *
   * Scoped to this describe deliberately. `withRetry` sleeps on a real
   * `setTimeout`, so freezing globally would hang the 429 backoff test in
   * the `searchFlights` block above until its 15s timeout.
   */
  const FROZEN_NOW = '2026-06-01T12:00:00.000Z';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(FROZEN_NOW));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // Delta-seconds — the IETF RateLimit-Reset form, and what many proxies
  // normalise to. These used to be swallowed by Date.parse ('60' parses as
  // 1960, '120' as year 120, '2' as 2001) and clamped to a 0ms sleep, while
  // '30' parses to NaN and happened to work — the bug flipped on the digits.
  const deltaSecondCases: Array<[string, number]> = [
    ['60', 60_000],
    ['120', 120_000],
    ['2', 2_000],
    ['30', 30_000],
  ];
  for (const [reset, expected] of deltaSecondCases) {
    it(`reads "ratelimit-reset: ${reset}" as ${expected / 1000}s`, () => {
      expect(retryDelayFromHeaders(errWith({ 'ratelimit-reset': reset }))).toBe(expected);
    });
  }

  it('still parses a real HTTP-date', () => {
    const httpDate = new Date(Date.now() + 45_000).toUTCString();
    // Spelled out so this also guards the frozen clock itself: if the fake
    // timers above are ever dropped, this fails outright instead of the
    // block quietly going flaky again.
    expect(httpDate).toBe('Mon, 01 Jun 2026 12:00:45 GMT');
    expect(retryDelayFromHeaders(errWith({ 'ratelimit-reset': httpDate }))).toBe(45_000);
  });

  it("still parses Duffel's ISO timestamp", () => {
    const iso = new Date(Date.now() + 60_000).toISOString();
    expect(iso).toBe('2026-06-01T12:01:00.000Z');
    expect(retryDelayFromHeaders(errWith({ 'ratelimit-reset': iso }))).toBe(60_000);
  });

  it('clamps a window that already reset to 0', () => {
    const past = new Date(Date.now() - 30_000).toISOString();
    expect(past).toBe('2026-06-01T11:59:30.000Z');
    expect(retryDelayFromHeaders(errWith({ 'ratelimit-reset': past }))).toBe(0);
  });

  it('caps an absurd delay rather than stalling the request', () => {
    expect(retryDelayFromHeaders(errWith({ 'ratelimit-reset': '3600' }))).toBe(120_000);
  });

  it('caps an absurd absolute reset time too', () => {
    // The cap was only covered through the delta-seconds branch above, but
    // the two branches compute `ms` differently — this one goes through
    // Date.parse. Ten minutes out must still clamp to the 2-minute ceiling.
    const farFuture = new Date(Date.now() + 10 * 60_000).toISOString();
    expect(retryDelayFromHeaders(errWith({ 'ratelimit-reset': farFuture }))).toBe(120_000);
  });

  it('treats an epoch-seconds reset as an absolute time', () => {
    // 1_780_315_245 — above EPOCH_SECONDS_FLOOR (1e9), so it must be read as
    // a timestamp, not as a 1.78-billion-second delta. Flooring to whole
    // seconds costs nothing here only because FROZEN_NOW is on a whole
    // second; that is why the assertion can be exact.
    const epochSecs = String(Math.floor((Date.now() + 45_000) / 1000));
    expect(retryDelayFromHeaders(errWith({ 'ratelimit-reset': epochSecs }))).toBe(45_000);
  });

  it('falls back to retry-after when ratelimit-reset is unusable', () => {
    expect(
      retryDelayFromHeaders(errWith({ 'ratelimit-reset': 'soon', 'retry-after': '5' })),
    ).toBe(5_000);
    expect(retryDelayFromHeaders(errWith({ 'retry-after': '7' }))).toBe(7_000);
  });

  it('returns null when neither header is present', () => {
    expect(retryDelayFromHeaders(errWith({}))).toBeNull();
    expect(retryDelayFromHeaders({})).toBeNull();
  });
});

/**
 * A flight price floor, for the same reason hotels have one — except the
 * consequence here is worse. `total_amount` absent becomes parseFloat('0'),
 * compareLeg picks the CHEAPEST offer, so a $0 fare wins its leg outright,
 * lands in the trip total, and is written to leg_price_cache for two hours.
 * One bad response poisons the route for everyone until it expires.
 */
describe('offers whose price cannot be real are dropped', () => {
  const offerWith = (over: Record<string, unknown>) => ({
    id: 'offer_x',
    total_amount: '199.99',
    total_currency: 'USD',
    slices: [
      {
        duration: 'PT2H30M',
        segments: [
          segment({
            departingAt: '2026-06-01T08:00:00',
            arrivingAt: '2026-06-01T10:30:00',
            originIata: 'FCO',
            originTimeZone: 'Europe/Rome',
            destinationIata: 'FLR',
            destinationTimeZone: 'Europe/Rome',
            duration: 'PT2H30M',
          }),
        ],
      },
    ],
    ...over,
  });

  // A unique date per call: searchFlights memoises by search params for 10
  // minutes (cachedSearch), so reusing one date would serve the first test's
  // offers to every later test in this block.
  let n = 0;
  const search = () =>
    searchFlights({
      origin: 'FCO',
      destination: 'FLR',
      date: `2026-07-${String(++n).padStart(2, '0')}`,
      travelers: 1,
    });

  it('drops an offer with no total_amount at all', async () => {
    mockDuffel.offerRequests.create.mockResolvedValue({
      data: { offers: [offerWith({ total_amount: undefined })] },
    });

    expect(await search()).toEqual([]);
  });

  it('drops a zero fare', async () => {
    mockDuffel.offerRequests.create.mockResolvedValue({
      data: { offers: [offerWith({ total_amount: '0' })] },
    });

    expect(await search()).toEqual([]);
  });

  it('drops an unparseable fare', async () => {
    mockDuffel.offerRequests.create.mockResolvedValue({
      data: { offers: [offerWith({ total_amount: 'free' })] },
    });

    expect(await search()).toEqual([]);
  });

  it('keeps the real offer and drops only the broken one', async () => {
    mockDuffel.offerRequests.create.mockResolvedValue({
      data: {
        offers: [
          offerWith({ id: 'broken', total_amount: '0' }),
          offerWith({ id: 'real', total_amount: '89.50' }),
        ],
      },
    });

    const offers = await search();
    expect(offers).toHaveLength(1);
    expect(offers[0].price).toBe(89.5);
  });

  it('keeps a genuinely cheap fare', async () => {
    // The floor is $1, orders of magnitude below any bookable fare once taxes
    // are counted, so it binds on certainty rather than judgement.
    mockDuffel.offerRequests.create.mockResolvedValue({
      data: { offers: [offerWith({ total_amount: '14.99' })] },
    });

    const offers = await search();
    expect(offers).toHaveLength(1);
    expect(offers[0].price).toBe(14.99);
  });
});

/**
 * Duffel's test mode sells some routes through its own fictional airline,
 * "Duffel Airways" (IATA ZZ). The owner's production trip had it on two of
 * the three return-flight alternatives, so opening the card in a demo showed
 * a fake airline. A live token never returns it.
 */
describe('the Duffel test-mode airline is not shown when a real airline is offered', () => {
  const offerBy = (id: string, carrier: { name: string; iata_code: string }, amount: string) => ({
    id,
    total_amount: amount,
    total_currency: 'USD',
    slices: [
      {
        duration: 'PT1H30M',
        segments: [
          segment({
            departingAt: '2026-08-01T08:00:00',
            arrivingAt: '2026-08-01T08:30:00',
            originIata: 'LHR',
            originTimeZone: 'Europe/London',
            destinationIata: 'JFK',
            destinationTimeZone: 'America/New_York',
            duration: 'PT1H30M',
            carrier,
          }),
        ],
      },
    ],
  });
  const ZZ = { name: 'Duffel Airways', iata_code: 'ZZ' };
  const BA = { name: 'British Airways', iata_code: 'BA' };

  let n = 0;
  const search = () =>
    searchFlights({ origin: 'LHR', destination: 'JFK', date: `2026-08-${String(++n).padStart(2, '0')}`, travelers: 1 });

  it('drops Duffel Airways offers, even cheaper ones, when a real airline is in the results', async () => {
    mockDuffel.offerRequests.create.mockResolvedValue({
      data: { offers: [offerBy('zz1', ZZ, '120.00'), offerBy('ba', BA, '310.00'), offerBy('zz2', ZZ, '180.00')] },
    });
    const offers = await search();
    expect(offers.map((o) => o.carrier)).toEqual(['British Airways']);
  });

  it('keeps them when they are all there is, so the leg still has a price (test mode only)', async () => {
    mockDuffel.offerRequests.create.mockResolvedValue({
      data: { offers: [offerBy('zz1', ZZ, '120.00'), offerBy('zz2', ZZ, '180.00')] },
    });
    const offers = await search();
    expect(offers.map((o) => o.carrierCode)).toEqual(['ZZ', 'ZZ']);
  });
});
