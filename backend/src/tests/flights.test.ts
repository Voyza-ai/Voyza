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
      data: [{ type: 'airport', iata_code: 'FCO', iata_country_code: 'IT' }],
    });

    // Use a city NOT in the curated override map so this exercises the
    // Duffel + Supabase cache path rather than short-circuiting.
    const code = await getIataCode('Verona');
    expect(code).toBe('FCO');
  });

  it('uses the curated override before Duffel for known cities', async () => {
    // Kyoto has no airport of its own; the override maps it to Osaka's
    // Kansai (KIX) so it never mis-resolves (it previously returned ACC).
    const code = await getIataCode('Kyoto');
    expect(code).toBe('KIX');
    expect(mockDuffel.suggestions.list).not.toHaveBeenCalled();
  });

  it('throws AppError when no IATA code found', async () => {
    mockDuffel.suggestions.list.mockResolvedValue({ data: [] });

    await expect(getIataCode('Atlantis')).rejects.toThrow('No IATA code found');
  });
});

describe('retryDelayFromHeaders', () => {
  const errWith = (headers: Record<string, string>) => ({
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
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
    const delay = retryDelayFromHeaders(errWith({ 'ratelimit-reset': httpDate }));
    // toUTCString() drops sub-second precision, so allow a second of slop.
    expect(delay).toBeGreaterThan(43_000);
    expect(delay).toBeLessThanOrEqual(45_000);
  });

  it("still parses Duffel's ISO timestamp", () => {
    const iso = new Date(Date.now() + 60_000).toISOString();
    expect(retryDelayFromHeaders(errWith({ 'ratelimit-reset': iso }))).toBe(60_000);
  });

  it('clamps a window that already reset to 0', () => {
    const past = new Date(Date.now() - 30_000).toISOString();
    expect(retryDelayFromHeaders(errWith({ 'ratelimit-reset': past }))).toBe(0);
  });

  it('caps an absurd delay rather than stalling the request', () => {
    expect(retryDelayFromHeaders(errWith({ 'ratelimit-reset': '3600' }))).toBe(120_000);
  });

  it('treats an epoch-seconds reset as an absolute time', () => {
    const epochSecs = String(Math.floor((Date.now() + 45_000) / 1000));
    const delay = retryDelayFromHeaders(errWith({ 'ratelimit-reset': epochSecs }));
    expect(delay).toBeGreaterThan(43_000);
    expect(delay).toBeLessThanOrEqual(45_000);
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
