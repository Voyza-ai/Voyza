// A stalled AI pick request gives up, instead of holding Edit in Canvas's
// "Saving..." (or the sign-in callback) for as long as the backend's own
// timeouts take (90 s with a retry). Standalone: the real lib/api.

jest.mock('@/lib/supabase', () => ({
  supabase: null,
  getAuthHeader: async () => ({}),
  refreshAuthHeader: async () => null,
}));

import { searchActivities, searchRestaurants, AI_PICKS_TIMEOUT_MS } from '@/lib/api';

/** fetch that never answers, but stops when its signal aborts, as browsers do. */
function stalledFetch() {
  return jest.fn((_url: string, init: RequestInit = {}) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  );
}

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = global.fetch;
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  global.fetch = realFetch;
});

it.each([
  ['activities', () => searchActivities({ city: 'Paris' })],
  ['restaurants', () => searchRestaurants({ city: 'Paris' })],
])('a stalled %s request is given up at the time limit, and not before', async (_name, call) => {
  global.fetch = stalledFetch() as any;
  let outcome: unknown = 'pending';
  call().then(
    () => (outcome = 'resolved'),
    (err) => (outcome = err),
  );

  await jest.advanceTimersByTimeAsync(AI_PICKS_TIMEOUT_MS - 1);
  expect(outcome).toBe('pending');
  await jest.advanceTimersByTimeAsync(1);
  expect(outcome).toMatchObject({ name: 'AbortError' });
  expect(AI_PICKS_TIMEOUT_MS).toBe(30_000);
});

it('an answer in time is returned, and leaves no timer behind', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ activities: [{ name: 'Louvre' }] }) })) as any;
  await expect(searchActivities({ city: 'Paris' })).resolves.toEqual([{ name: 'Louvre' }]);
  expect(jest.getTimerCount()).toBe(0);
});
