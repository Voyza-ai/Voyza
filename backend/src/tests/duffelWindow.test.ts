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

import {
  _resetBackgroundSearches,
  duffelWindowState,
  isFlightSearchCached,
  resetDuffelRateLimitPause,
  searchFlights,
  searchFlightsInBackground,
} from '../services/flights';
import { withDuffelCancel } from '../services/duffelBudget';

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
  mockDuffel.offerRequests.create.mockReset();
  resetDuffelRateLimitPause();
  _resetBackgroundSearches();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A reset on a whole second, at least `ms` away (an HTTP date has no milliseconds). */
const wholeSecondIn = (ms: number) => Math.ceil((Date.now() + ms) / 1000) * 1000;

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

describe("Duffel's window: searches sent before it was known", () => {
  it('count against it: an answer from before them cannot give their places back', async () => {
    // A fresh process: A and B go out with the window unknown. A's answer
    // (Duffel's count when it accepted A: 29 left) lets C go; B's answer then
    // says 28 — its count from before C. Three were sent: 27 are left.
    const resetIn = 50_000;
    const later = (ms: number, remaining: number) => async () => {
      await sleep(ms);
      return answer(remaining, resetIn);
    };
    mockDuffel.offerRequests.create
      .mockImplementationOnce(later(50, 29))
      .mockImplementationOnce(later(250, 28))
      .mockImplementationOnce(later(400, 27));
    const a = searchFlights({ origin: 'JFK', destination: 'CDG', date: '2031-02-05', travelers: 1 });
    const b = searchFlights({ origin: 'JFK', destination: 'FCO', date: '2031-02-05', travelers: 1 });
    await a;
    const c = searchFlights({ origin: 'JFK', destination: 'MAD', date: '2031-02-05', travelers: 1 });
    await b;
    expect(duffelWindowState()).toMatchObject({ remaining: 27 });
    await c;
    expect(duffelWindowState()).toMatchObject({ remaining: 27 });
  });
});

describe("Duffel's window: late answers", () => {
  it('an answer from the minute that just ended never replaces the one in force', async () => {
    mockDuffel.offerRequests.create.mockResolvedValueOnce(answer(20, 40_000));
    await searchFlights({ origin: 'JFK', destination: 'CDG', date: '2031-02-01', travelers: 1 });
    expect(duffelWindowState()).toMatchObject({ remaining: 20 });
    // Sent before the minute turned, answered after: that minute is spent and
    // its reset is now (a whole second, already past).
    mockDuffel.offerRequests.create.mockResolvedValueOnce(answer(0, Math.floor(Date.now() / 1000) * 1000 - Date.now()));
    await searchFlights({ origin: 'JFK', destination: 'FCO', date: '2031-02-01', travelers: 1 });
    // Still the current minute: 20, less the place that search took.
    expect(duffelWindowState()).toMatchObject({ remaining: 19 });
  });
});

describe('a search its caller gave up on (withDuffelCancel)', () => {
  it('waiting for the next Duffel minute, it is never sent once the caller has left', async () => {
    const resetAt = wholeSecondIn(1_000);
    mockDuffel.offerRequests.create.mockResolvedValueOnce(answer(0, resetAt - Date.now()));
    await searchFlights({ origin: 'JFK', destination: 'CDG', date: '2031-02-02', travelers: 1 });
    expect(mockDuffel.offerRequests.create).toHaveBeenCalledTimes(1);

    let gaveUp = false;
    const probe = withDuffelCancel(
      () => gaveUp,
      () => searchFlights({ origin: 'JFK', destination: 'MAD', date: '2031-02-02', travelers: 1 }),
    );
    await sleep(200);
    gaveUp = true; // the plan's answer went out
    await expect(probe).rejects.toBeTruthy();
    await sleep(Math.max(0, resetAt - Date.now()) + 1_300);
    expect(mockDuffel.offerRequests.create).toHaveBeenCalledTimes(1);
  }, 10_000);
});

describe('background (pre-search) searches give way to plans', () => {
  it('not sent into a nearly spent minute: it waits for the next one', async () => {
    const resetAt = wholeSecondIn(1_000);
    mockDuffel.offerRequests.create.mockResolvedValueOnce(answer(8, resetAt - Date.now()));
    await searchFlights({ origin: 'JFK', destination: 'CDG', date: '2031-02-03', travelers: 1 });
    _resetBackgroundSearches(); // that plan is long done

    let sentAt = 0;
    mockDuffel.offerRequests.create.mockImplementationOnce(async () => {
      sentAt = Date.now();
      return answer(29, 60_000);
    });
    const offers = await searchFlightsInBackground({ origin: 'JFK', destination: 'LIS', date: '2031-02-03', travelers: 1 });
    expect(offers).toEqual([]);
    expect(sentAt).toBeGreaterThanOrEqual(resetAt);
  }, 10_000);

  it('dropped, unsent, when a plan starts searching while it waits', async () => {
    const resetAt = wholeSecondIn(1_000);
    mockDuffel.offerRequests.create.mockResolvedValueOnce(answer(5, resetAt - Date.now()));
    await searchFlights({ origin: 'JFK', destination: 'CDG', date: '2031-02-04', travelers: 1 });
    _resetBackgroundSearches();

    const pre = searchFlightsInBackground({ origin: 'JFK', destination: 'BCN', date: '2031-02-04', travelers: 1 });
    await sleep(100);
    // A plan searches meanwhile, and is still at it when the minute turns.
    mockDuffel.offerRequests.create.mockImplementationOnce(async () => {
      await sleep(2_500);
      return answer(4, resetAt - Date.now());
    });
    const plan = searchFlights({ origin: 'JFK', destination: 'ATH', date: '2031-02-04', travelers: 1 });
    expect(await pre).toBeNull();
    await plan;
    // The setup search and the plan's: the pre-search was never sent.
    expect(mockDuffel.offerRequests.create).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("never holds one of a plan's six slots", async () => {
    const sentAt: number[] = [];
    mockDuffel.offerRequests.create.mockImplementation(async () => {
      sentAt.push(Date.now());
      await sleep(400);
      return answer(25, 50_000);
    });
    const pre = [1, 2].map((d) => searchFlightsInBackground({ origin: 'JFK', destination: 'OPO', date: `2031-02-1${d}`, travelers: 1 }));
    await sleep(20);
    const started = Date.now();
    const plan = [1, 2, 3, 4, 5, 6].map((d) => searchFlights({ origin: 'JFK', destination: 'NAP', date: `2031-02-2${d}`, travelers: 1 }));
    await Promise.all([...pre, ...plan]);
    // All six of the plan's went out at once, beside the two pre-searches.
    expect(sentAt.filter((t) => t >= started && t - started < 200)).toHaveLength(6);
  }, 10_000);
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
