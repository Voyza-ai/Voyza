/**
 * lib/track: usage events go to PostHog only when a project key is set, carry
 * an anonymous id (never a name or email), and never break the app.
 */

function load(key?: string) {
  let mod: typeof import('@/lib/track');
  jest.isolateModules(() => {
    if (key === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    else process.env.NEXT_PUBLIC_POSTHOG_KEY = key;
    mod = require('@/lib/track');
  });
  return mod!;
}

const fetchMock = jest.fn(() => Promise.resolve(new Response('{}')));
beforeEach(() => {
  fetchMock.mockClear();
  (global as any).fetch = fetchMock;
  localStorage.clear();
  sessionStorage.clear();
  Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true });
});
afterAll(() => delete process.env.NEXT_PUBLIC_POSTHOG_KEY);

it('sends nothing without a key', () => {
  load().track('plan_started', { mode: 'destination' });
  expect(fetchMock).not.toHaveBeenCalled();
});

it('with a key: one POST to the capture endpoint, an anonymous id kept across events, the props as given', () => {
  const { track } = load('phc_test');
  track('trip_search_started', { cities: 2, travelers: 2 });
  track('trip_saved', { cities: 2 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const [url, init] = fetchMock.mock.calls[0] as any;
  expect(url).toBe('https://us.i.posthog.com/i/v0/e/');
  const body = JSON.parse(init.body);
  expect(body).toMatchObject({ api_key: 'phc_test', event: 'trip_search_started', properties: { cities: 2, travelers: 2, app: 'web' } });
  const second = JSON.parse((fetchMock.mock.calls[1] as any)[1].body);
  expect(second.distinct_id).toBe(body.distinct_id);
  expect(body.distinct_id).toBe(localStorage.getItem('bluemurr.anonId'));
  expect(JSON.stringify(body)).not.toMatch(/@/); // no email anywhere
});

it('Do Not Track turns it off', () => {
  Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
  load('phc_test').track('plan_started');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('a failing network call never throws', async () => {
  fetchMock.mockImplementationOnce(() => Promise.reject(new Error('offline')));
  expect(() => load('phc_test').track('plan_started')).not.toThrow();
  await Promise.resolve();
});

it('moneyBucket groups totals instead of sending exact prices', () => {
  const { moneyBucket } = load();
  expect([moneyBucket(0), moneyBucket(420), moneyBucket(963), moneyBucket(2400), moneyBucket(9000)]).toEqual([null, '<500', '500-1k', '1k-2.5k', '5k+']);
});
