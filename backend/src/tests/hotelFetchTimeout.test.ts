jest.mock('../config/env', () => ({
  env: {
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

/**
 * Every Booking.com fetch is bounded.
 *
 * They had no timeout at all, so a provider that accepted the connection and
 * never answered held the search for undici's defaults — five minutes for the
 * headers, five more for the body — while the planner sat on "Finding
 * hotels..." and the canvas save route, which awaits this service inline,
 * held its request open the same way.
 */

const cacheMiss = {
  data: null,
  error: { code: 'PGRST116', message: 'no rows', details: '', hint: null },
};

jest.mock('../services/supabase', () => ({
  getSupabase: () => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      upsert: () => builder,
      retry: () => builder,
      abortSignal: () => builder,
      single: () => Promise.resolve(cacheMiss),
      then: (onOk: any, onErr: any) =>
        Promise.resolve({ data: null, error: null }).then(onOk, onErr),
    };
    return { from: () => builder };
  },
}));

import { searchHotels } from '../services/hotels';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** A fetch that never answers, and rejects only when its signal aborts. */
const hang = (_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
  });

const answer = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

/**
 * `AbortSignal.timeout`, made to fire after 20 ms instead of its real delay so
 * the test can watch a hung request end. The requested delays are recorded so
 * the real sizing is asserted too.
 */
let requestedMs: number[];
beforeEach(() => {
  mockFetch.mockReset();
  requestedMs = [];
  jest.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
    requestedMs.push(ms);
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 20);
    return c.signal;
  });
});
afterEach(() => jest.restoreAllMocks());

const search = (city: string) =>
  searchHotels({ city, checkin: '2027-03-01', checkout: '2027-03-04', adults: 2 });

it('a hung hotel search ends empty instead of holding the caller', async () => {
  mockFetch.mockImplementation((url: string, init?: RequestInit) =>
    String(url).includes('/locations')
      ? answer([{ dest_id: '-1', dest_type: 'city' }])
      : hang(url, init),
  );

  await expect(search('Hungville')).resolves.toEqual([]);
});

it('a hung destination lookup ends empty too', async () => {
  mockFetch.mockImplementation(hang);
  await expect(search('Lookupville')).resolves.toEqual([]);
});

it('every Booking fetch carries a signal, sized at 10s', async () => {
  mockFetch.mockImplementation((url: string) =>
    String(url).includes('/locations')
      ? answer([{ dest_id: '-2', dest_type: 'city' }])
      : answer({ result: [] }),
  );
  await search('Signalville');

  const bookingCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('rapidapi.com'));
  expect(bookingCalls.length).toBe(2); // locations + search
  for (const [, init] of bookingCalls) {
    expect((init as RequestInit)?.signal).toBeInstanceOf(AbortSignal);
  }
  expect(requestedMs).toContain(10_000);
});
