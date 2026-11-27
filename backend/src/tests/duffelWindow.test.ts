/**
 * Duffel's window, read off its own answers (prototype, exp/optimizer-speed).
 *
 * Every Duffel response carries `ratelimit-limit: 30`, `ratelimit-remaining`
 * and `ratelimit-reset` (the next wall-clock minute) — measured 2026-11-24.
 * Once an answer says the window is spent, flights.ts sends nothing more
 * until the reset, instead of sending searches only to have them refused.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) }) }),
}));

jest.mock('../services/duffel', () => {
  const mockDuffel = { offerRequests: { create: jest.fn() }, suggestions: { list: jest.fn() } };
  return { getDuffel: () => mockDuffel, __mockDuffel: mockDuffel };
});
jest.mock('../services/location/sameAirportArea', () => ({ sameAirportArea: () => false }));

import { duffelWindowState, isFlightSearchCached, resetDuffelRateLimitPause, searchFlights } from '../services/flights';

const { __mockDuffel: mockDuffel } = require('../services/duffel');

const headers = (remaining: number, resetInMs: number) => {
  const map: Record<string, string> = {
    'ratelimit-limit': '30',
    'ratelimit-remaining': String(remaining),
    'ratelimit-reset': new Date(Date.now() + resetInMs).toUTCString(),
  };
  return { get: (k: string) => map[k.toLowerCase()] ?? null };
};

const answer = (remaining: number, resetInMs: number) => ({
  data: { offers: [] },
  headers: headers(remaining, resetInMs),
});

beforeEach(() => {
  jest.clearAllMocks();
  resetDuffelRateLimitPause();
});

describe("Duffel's window", () => {
  it('remembers what the last answer said', async () => {
    mockDuffel.offerRequests.create.mockResolvedValueOnce(answer(17, 40_000));
    await searchFlights({ origin: 'JFK', destination: 'CDG', date: '2031-01-10', travelers: 1 });
    expect(duffelWindowState()).toMatchObject({ limit: 30, remaining: 17 });
  });

  it('once an answer says the window is spent, the next search waits for the reset instead of being sent', async () => {
    // Whole seconds: an HTTP date has no milliseconds.
    mockDuffel.offerRequests.create.mockResolvedValueOnce(answer(0, 2_000));
    await searchFlights({ origin: 'JFK', destination: 'CDG', date: '2031-01-11', travelers: 1 });

    let sentAt = 0;
    mockDuffel.offerRequests.create.mockImplementationOnce(async () => {
      sentAt = Date.now();
      return answer(29, 60_000);
    });
    const started = Date.now();
    await searchFlights({ origin: 'JFK', destination: 'FCO', date: '2031-01-11', travelers: 1 });
    expect(mockDuffel.offerRequests.create).toHaveBeenCalledTimes(2);
    // Not refused and retried: sent once, after the reset.
    expect(sentAt - started).toBeGreaterThanOrEqual(900);
  }, 10_000);

  it('a burst bigger than the places left sends only that many, and the rest after the reset', async () => {
    // One window, ending on a whole second (an HTTP date has no ms), with 2
    // places left; the next one starts empty.
    const resetAt = Math.ceil((Date.now() + 2_000) / 1000) * 1000;
    mockDuffel.offerRequests.create.mockResolvedValueOnce(answer(2, resetAt - Date.now()));
    await searchFlights({ origin: 'JFK', destination: 'CDG', date: '2031-01-14', travelers: 1 });

    const sentAt: number[] = [];
    let left = 2;
    mockDuffel.offerRequests.create.mockImplementation(async () => {
      sentAt.push(Date.now());
      // Duffel's own count of the window this request landed in.
      if (Date.now() >= resetAt) return answer(29 - (sentAt.length - 3), resetAt + 60_000 - Date.now());
      left = Math.max(0, left - 1);
      return answer(left, resetAt - Date.now());
    });
    const started = Date.now();
    await Promise.all(
      ['FCO', 'MAD', 'LIS', 'BCN'].map((destination) =>
        searchFlights({ origin: 'JFK', destination, date: '2031-01-14', travelers: 1 }),
      ),
    );
    mockDuffel.offerRequests.create.mockReset();
    // Four sent, none refused: two at once, two once the window reset.
    expect(sentAt).toHaveLength(4);
    const early = sentAt.filter((t) => t - started < 500).length;
    expect(early).toBe(2);
    expect(sentAt.filter((t) => t >= resetAt)).toHaveLength(2);
  }, 10_000);

  it('a window with room left sends at once', async () => {
    mockDuffel.offerRequests.create.mockResolvedValueOnce(answer(5, 30_000));
    await searchFlights({ origin: 'JFK', destination: 'CDG', date: '2031-01-12', travelers: 1 });
    mockDuffel.offerRequests.create.mockResolvedValueOnce(answer(4, 30_000));
    const started = Date.now();
    await searchFlights({ origin: 'JFK', destination: 'MAD', date: '2031-01-12', travelers: 1 });
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('isFlightSearchCached', () => {
  it('says whether a search would cost a Duffel request', async () => {
    const params = { origin: 'EWR', destination: 'AMS', date: '2031-01-13', travelers: 2 };
    expect(isFlightSearchCached(params)).toBe(false);
    mockDuffel.offerRequests.create.mockResolvedValueOnce(answer(10, 30_000));
    await searchFlights(params);
    expect(isFlightSearchCached(params)).toBe(true);
    expect(isFlightSearchCached({ ...params, travelers: 3 })).toBe(false);
  });
});
