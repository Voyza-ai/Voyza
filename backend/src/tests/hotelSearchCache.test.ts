jest.mock('../config/env', () => ({
  env: {
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

/**
 * The 10-minute hotel search cache.
 *
 * Re-running a trip paid the whole hotel phase again — about 10.7s measured
 * for a re-run with nothing changed — and every repeat spent metered RapidAPI
 * quota on an answer we had just been given. Flights have had the same cache
 * since the optimizer started firing duplicate searches; hotels had none.
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

const raw = (id: string, totalPrice: number, stars = 3) => ({
  hotel_id: id,
  hotel_name: `Hotel ${id}`,
  min_total_price: String(totalPrice),
  currency_code: 'USD',
  review_score: '8.4',
  review_nr: '500',
  class: String(stars),
  url: `https://www.booking.com/hotel/fr/${id}.html`,
});

const ROWS = [raw('a', 600), raw('b', 900), raw('c', 1200), raw('d', 1500), raw('e', 1800)];

function stubBooking(rows: unknown[] = ROWS) {
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          String(url).includes('/locations')
            ? [{ dest_id: '-1456928', dest_type: 'city' }]
            : { result: rows },
        ),
    }),
  );
}

const searchCalls = () =>
  mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/v1/hotels/search'));

// Every test uses its own city, so nothing one test caches can answer another.
let n = 0;
const base = () => ({ city: `City${++n}`, checkin: '2027-05-01', checkout: '2027-05-04', adults: 2 });

beforeEach(() => {
  mockFetch.mockReset();
  jest.restoreAllMocks();
});

it('a repeated search is answered without asking Booking again', async () => {
  stubBooking();
  const p = base();
  const first = await searchHotels(p);
  const second = await searchHotels(p);

  expect(searchCalls()).toHaveLength(1);
  expect(second).toEqual(first);
  expect(first).toHaveLength(5);
});

it('concurrent identical searches share one request', async () => {
  stubBooking();
  const p = base();
  const [a, b] = await Promise.all([searchHotels(p), searchHotels(p)]);

  expect(searchCalls()).toHaveLength(1);
  expect(b).toEqual(a);
});

it.each([
  ['rooms', { rooms: 2 }],
  ['adults', { adults: 4 }],
  ['checkin', { checkin: '2027-05-02' }],
  ['checkout', { checkout: '2027-05-05' }],
  ['hotelName', { hotelName: 'Gracery Shinjuku' }],
  ['maxPrice', { maxPrice: 5000 }],
])('a different %s is a different search', async (_label, change) => {
  stubBooking();
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          String(url).includes('/locations')
            ? // The hotel-name lookup needs a matching hotel entry.
              [
                { dest_id: '-1456928', dest_type: 'city' },
                { dest_id: '99', dest_type: 'hotel', name: 'Hotel Gracery Shinjuku' },
              ]
            : { result: ROWS },
        ),
    }),
  );
  const p = base();
  await searchHotels(p);
  await searchHotels({ ...p, ...change });

  expect(searchCalls()).toHaveLength(2);
});

it('the default room count and the same count passed explicitly are one search', async () => {
  stubBooking();
  const p = { ...base(), adults: 6 };
  await searchHotels(p);
  await searchHotels({ ...p, rooms: 3 });

  expect(searchCalls()).toHaveLength(1);
});

it('a capped search is cached before the cap, so even one the cap empties repeats for free', async () => {
  // The cap is the traveller's own budget filtering what Booking sent back,
  // so "nothing under your cap" is a real answer with real rows behind it —
  // not a failure — and re-running the same trip must not re-ask Booking.
  stubBooking();
  const p = base();
  const capped = await searchHotels({ ...p, maxPrice: 1000 });
  const cappedAgain = await searchHotels({ ...p, maxPrice: 1000 });
  const emptied = await searchHotels({ ...p, maxPrice: 100 });
  const emptiedAgain = await searchHotels({ ...p, maxPrice: 100 });

  expect(capped.map((h) => h.id).sort()).toEqual(['a', 'b']);
  expect(cappedAgain).toEqual(capped);
  expect(emptied).toEqual([]);
  expect(emptiedAgain).toEqual([]);
  // One request per distinct cap; none for the repeats.
  expect(searchCalls()).toHaveLength(2);
});

it('an empty answer is not kept — the next caller tries again', async () => {
  // Every failure inside the search reports itself as [] (429s exhausted, a
  // provider error, a timeout), so caching [] would cache the outage.
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve(
      String(url).includes('/locations')
        ? { ok: true, status: 200, json: () => Promise.resolve([{ dest_id: '-1', dest_type: 'city' }]) }
        : { ok: false, status: 500, json: () => Promise.resolve({}) },
    ),
  );
  const p = base();
  expect(await searchHotels(p)).toEqual([]);

  stubBooking();
  expect(await searchHotels(p)).toHaveLength(5);
  expect(searchCalls()).toHaveLength(2);
});

it('expires after ten minutes', async () => {
  stubBooking();
  const p = base();
  const t0 = Date.now();
  const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
  await searchHotels(p);

  now.mockReturnValue(t0 + 10 * 60 * 1000 - 1);
  await searchHotels(p);
  expect(searchCalls()).toHaveLength(1);

  now.mockReturnValue(t0 + 10 * 60 * 1000 + 1);
  await searchHotels(p);
  expect(searchCalls()).toHaveLength(2);
});

it('a caller that edits its rows cannot change the next caller’s answer', async () => {
  stubBooking();
  const p = base();
  const first = await searchHotels(p);
  first[0].pricePerNight = 0;
  first[0].name = 'tampered';
  first.length = 1;

  const second = await searchHotels(p);
  expect(second).toHaveLength(5);
  expect(second.find((h) => h.name === 'tampered')).toBeUndefined();
});
