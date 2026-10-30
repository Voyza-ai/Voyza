/**
 * Bounded Duffel retries (flights.ts withRetry + the search gate).
 *
 * Production, 2026-10-30: a cold 5-city optimize took 180.6s. Duffel allows
 * 60 requests per 60s window per token and a 5-city plan needs ~110, and the
 * retry policy could sleep up to 2 minutes per attempt × 3 attempts — while
 * HOLDING one of the 6 search slots, so six sleepers froze every search
 * behind them. A rate-limit model of the real code (429 + ratelimit-reset
 * above N requests/min) reproduces 191s at an effective 30/min.
 *
 * Pinned here: one call never waits more than one window in total; a known
 * rate-limit pause is shared instead of rediscovered by every call; a
 * backing-off call gives its slot back; and optional work can cap its wait.
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
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
      upsert: () => Promise.resolve({ data: null }),
    }),
  }),
}));

jest.mock('../services/currency', () => ({
  convertToUsd: jest.fn(async (amount: number) => amount),
}));

jest.mock('../services/duffel', () => {
  const mockDuffel = { offerRequests: { create: jest.fn() }, suggestions: { list: jest.fn() } };
  return { getDuffel: () => mockDuffel, __mockDuffel: mockDuffel };
});
// Not what this file is about, and it builds the whole location index.
jest.mock('../services/location/sameAirportArea', () => ({ sameAirportArea: () => false }));

import * as flights from '../services/flights';
import { searchFlights } from '../services/flights';
import * as budget from '../services/duffelBudget';

const { __mockDuffel: mockDuffel } = require('../services/duffel');
const create = mockDuffel.offerRequests.create as jest.Mock;

const NOW = new Date('2030-01-01T12:00:00Z').getTime();

/** A DuffelError-shaped 429 whose window resets `inMs` from now. */
function rateLimited(inMs: number) {
  const err: any = new Error();
  err.meta = { status: 429 };
  err.errors = [{ code: 'rate_limit_exceeded' }];
  err.headers = new Headers({ 'ratelimit-reset': new Date(Date.now() + inMs).toUTCString() });
  return err;
}

function serverError(status = 503) {
  const err: any = new Error();
  err.meta = { status };
  return err;
}

const okResponse = () => ({
  data: {
    offers: [
      {
        id: 'o1',
        total_amount: '120.00',
        total_currency: 'USD',
        slices: [
          {
            duration: 'PT2H',
            segments: [
              {
                departing_at: '2030-06-01T09:00:00',
                arriving_at: '2030-06-01T11:00:00',
                origin: { time_zone: 'Europe/Paris' },
                destination: { time_zone: 'Europe/Rome' },
                operating_carrier: { name: 'Test Air', iata_code: 'TA' },
              },
            ],
          },
        ],
      },
    ],
  },
});

let seq = 0;
/** A fresh route per call so searchFlights' dedupe cache never answers for Duffel. */
const route = () => ({ origin: 'PAR', destination: `R${String(++seq).padStart(2, '0')}`, date: '2030-06-01', travelers: 1 });

/** Settle microtasks without advancing the fake clock. */
const flush = () => jest.advanceTimersByTimeAsync(0);

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
  jest.spyOn(Math, 'random').mockReturnValue(0); // no jitter: exact timings
  create.mockReset();
  (flights as any).resetDuffelRateLimitPause?.();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('Duffel retry budget', () => {
  it('fails at once when the rate-limit window resets beyond one window away', async () => {
    // A proxy/edge that says "come back in 90s". Before: slept 90s holding a
    // slot, then again, up to 3 times.
    create.mockRejectedValue(rateLimited(90_000));

    const search = searchFlights(route());
    let settled = false;
    search.catch(() => undefined).finally(() => (settled = true));
    await flush();

    expect(settled).toBe(true);
    await expect(search).rejects.toThrow(/Flight search failed/);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('waits for the next window once, but never more than ~65s in total', async () => {
    // Each attempt is told to wait 40s (a fresh reset time per response).
    // Two waits would be 80s — past budget.
    create.mockImplementation(() => Promise.reject(rateLimited(40_000)));

    const search = searchFlights(route());
    search.catch(() => undefined);
    await flush();
    expect(create).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(40_000);
    expect(create).toHaveBeenCalledTimes(2);
    // Second 429 says another 40s: 80s total would break the budget → fail now.
    await expect(search).rejects.toThrow(/Flight search failed/);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('shares a known rate-limit pause instead of every call rediscovering it', async () => {
    create.mockRejectedValueOnce(rateLimited(20_000)).mockResolvedValue(okResponse());

    const first = searchFlights(route());
    await flush();
    expect(create).toHaveBeenCalledTimes(1);

    // A search that starts during the pause does not send a doomed request.
    const second = searchFlights(route());
    await flush();
    expect(create).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(20_000);
    await expect(first).resolves.toHaveLength(1);
    await expect(second).resolves.toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('gives its search slot back while it backs off', async () => {
    // Six searches fill the gate and each get a 503 (backoff 1s with no
    // jitter). The seventh must not sit behind six sleeping calls.
    for (let i = 0; i < 6; i++) create.mockRejectedValueOnce(serverError(503));
    create.mockResolvedValue(okResponse());

    const searches = Array.from({ length: 7 }, () => searchFlights(route()));
    await flush();

    // Before: 6 (the seventh queued until a sleeper woke and finished).
    expect(create).toHaveBeenCalledTimes(7);

    await jest.advanceTimersByTimeAsync(1_000);
    await expect(Promise.all(searches)).resolves.toHaveLength(7);
  });

  it('lets optional work cap its own wait (the date-shift probe uses this)', async () => {
    create.mockRejectedValueOnce(serverError(503)).mockResolvedValue(okResponse());
    expect(typeof (budget as any).withDuffelRetryBudget).toBe('function');

    // 0ms budget: no retry at all — the 1s backoff is over budget.
    const search = budget.withDuffelRetryBudget(0, () => searchFlights(route()));
    search.catch(() => undefined);
    await flush();
    await expect(search).rejects.toThrow(/Flight search failed/);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
