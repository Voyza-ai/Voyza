/**
 * Deutsche Bahn REST circuit breaker (trains.ts).
 *
 * Production measurement, 2026-10-29: db.transport.rest answered 503 after
 * ~10.5s, so the 4.5s DB_TIMEOUT_MS abort fired on EVERY rail search and
 * every optimize leg waited it out — +7.3s on a 3-city trip, +28.3s on a
 * 5-city one. These tests pin the fix: one upstream failure pauses Deutsche
 * Bahn for everyone, a background probe (never a user request) brings it
 * back, and per-query failures do not count as an outage.
 */

jest.mock('../config/env', () => ({
  env: {
    DB_REST_BASE_URL: 'https://db.test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

// Counts db_stops reads so a test can prove the breaker skips them.
const supabaseFrom = jest.fn(() => ({
  select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
  upsert: () => Promise.resolve({ data: null }),
}));
jest.mock('../services/supabase', () => ({
  getSupabase: () => ({ from: supabaseFrom }),
}));

jest.mock('../services/currency', () => ({
  convertToUsd: jest.fn(async (amount: number) => amount),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

import * as trains from '../services/trains';
import { searchTrains, clearTrainSearchCache } from '../services/trains';

const BREAKER_MS = 5 * 60 * 1000;

const leg = (origin: string, destination: string) => ({
  origin,
  destination,
  date: '2030-06-01',
  travelers: 1,
});

/** A fetch that hangs like the real 503-after-10.5s upstream, until our abort fires. */
const hangUntilAborted = (_url: string, init?: any) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(init.signal.reason ?? new DOMException('This operation was aborted', 'AbortError')),
    );
  });

/** A healthy DB REST for one Frankfurt → Munich journey. */
const healthyDb = (url: string) => {
  const u = new URL(url);
  if (u.pathname === '/locations') {
    const q = u.searchParams.get('query') ?? '';
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ id: `stop-${q}` }]) });
  }
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        journeys: [
          {
            legs: [
              {
                departure: '2030-06-01T08:00:00+02:00',
                arrival: '2030-06-01T12:00:00+02:00',
                origin: { name: 'Frankfurt(Main)Hbf' },
                destination: { name: 'Munich Hbf' },
                line: { operator: { name: 'Deutsche Bahn' }, productName: 'ICE' },
              },
            ],
            price: { amount: '49.90', currency: 'EUR' },
          },
        ],
      }),
  });
};

/** Resolves to true if `p` settles once pending microtasks/timers at 0ms have run. */
async function settlesWithoutWaiting(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await jest.advanceTimersByTimeAsync(0);
  return settled;
}

beforeEach(() => {
  jest.useFakeTimers({ now: new Date('2030-01-01T00:00:00Z') });
  mockFetch.mockReset();
  supabaseFrom.mockClear();
  clearTrainSearchCache();
  // Optional-call so this file still runs (and fails for the right reason)
  // against code that predates the breaker.
  (trains as any).resetDbBreaker?.();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Deutsche Bahn circuit breaker', () => {
  it('after one timed-out search, the next leg answers at once without touching DB REST', async () => {
    mockFetch.mockImplementation(hangUntilAborted);

    const first = searchTrains(leg('Paris', 'Amsterdam'));
    await jest.advanceTimersByTimeAsync(4500);
    await expect(first).resolves.toEqual([]);
    const fetchesAfterFirst = mockFetch.mock.calls.length;
    const stopReadsAfterFirst = supabaseFrom.mock.calls.length;

    // Before the breaker this leg waited another full 4.5s for the same 503.
    const second = searchTrains(leg('Berlin', 'Prague'));
    expect(await settlesWithoutWaiting(second)).toBe(true);
    await expect(second).resolves.toEqual([]);
    expect(mockFetch.mock.calls.length).toBe(fetchesAfterFirst);
    // ...and skips the db_stops cache reads too.
    expect(supabaseFrom.mock.calls.length).toBe(stopReadsAfterFirst);
  });

  it('opens on an HTTP 5xx from the journeys endpoint', async () => {
    mockFetch.mockImplementation((url: string) =>
      new URL(url).pathname === '/locations'
        ? healthyDb(url)
        : Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }),
    );
    await expect(searchTrains(leg('Frankfurt', 'Munich'))).resolves.toEqual([]);
    const calls = mockFetch.mock.calls.length;

    await expect(searchTrains(leg('Berlin', 'Hamburg'))).resolves.toEqual([]);
    expect(mockFetch.mock.calls.length).toBe(calls);
  });

  it("opens on undici's network failure (TypeError: fetch failed)", async () => {
    mockFetch.mockRejectedValue(new TypeError('fetch failed'));
    await expect(searchTrains(leg('Frankfurt', 'Munich'))).resolves.toEqual([]);
    const calls = mockFetch.mock.calls.length;

    await expect(searchTrains(leg('Berlin', 'Hamburg'))).resolves.toEqual([]);
    expect(mockFetch.mock.calls.length).toBe(calls);
  });

  it('does not open on a per-query failure (no stop found, 4xx)', async () => {
    // "No stop found" for an unknown city, then a 404 on journeys: both are
    // about that query. The next leg must still be searched.
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve([]) });
    await expect(searchTrains(leg('Atlantis', 'Lemuria'))).resolves.toEqual([]);

    mockFetch.mockImplementation((url: string) =>
      new URL(url).pathname === '/locations'
        ? healthyDb(url)
        : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) }),
    );
    await expect(searchTrains(leg('Bonn', 'Cologne'))).resolves.toEqual([]);

    mockFetch.mockImplementation(healthyDb);
    const offers = await searchTrains(leg('Frankfurt', 'Munich'));
    expect(offers).toHaveLength(1);
    expect(offers[0].price).toBe(49.9);
  });

  it('re-probes once in the background when the window ends, and resumes when DB REST answers', async () => {
    mockFetch.mockImplementation(hangUntilAborted);
    const first = searchTrains(leg('Paris', 'Amsterdam'));
    await jest.advanceTimersByTimeAsync(4500);
    await first;

    // DB REST recovers while the breaker is open; nobody notices yet.
    mockFetch.mockReset();
    mockFetch.mockImplementation(healthyDb);
    await jest.advanceTimersByTimeAsync(BREAKER_MS);

    // The first searches after the window still answer immediately — a user
    // request never pays for the probe — and they start exactly ONE probe.
    const a = searchTrains(leg('Frankfurt', 'Munich'));
    const b = searchTrains(leg('Berlin', 'Hamburg'));
    expect(await settlesWithoutWaiting(Promise.all([a, b]))).toBe(true);
    await expect(a).resolves.toEqual([]);
    await expect(b).resolves.toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain('/locations');

    // Probe succeeded → closed: the next leg is a real search. (A new date,
    // because searchTrains caches the [] answered above for 10 minutes.)
    const offers = await searchTrains({ ...leg('Frankfurt', 'Munich'), date: '2030-06-02' });
    expect(offers).toHaveLength(1);
  });

  it('stays open for another window when the re-probe fails', async () => {
    mockFetch.mockImplementation(hangUntilAborted);
    const first = searchTrains(leg('Paris', 'Amsterdam'));
    await jest.advanceTimersByTimeAsync(4500);
    await first;

    await jest.advanceTimersByTimeAsync(BREAKER_MS);
    mockFetch.mockClear();
    // Window over → this search starts the probe, which times out.
    await expect(searchTrains(leg('Rome', 'Milan'))).resolves.toEqual([]);
    await jest.advanceTimersByTimeAsync(4500);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Re-opened: well inside the new window nothing reaches DB REST.
    await jest.advanceTimersByTimeAsync(BREAKER_MS / 2);
    await expect(searchTrains(leg('Lyon', 'Nice'))).resolves.toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
