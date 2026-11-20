jest.mock('../config/env', () => ({
  env: {
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

/**
 * `priceUnverified`: a search too thin to price-check (fewer than
 * MIN_RESULTS_TO_FILTER rows) used to only log. Every row of such a search is
 * unchecked, so every row now carries the flag — and the price is kept.
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
import { logger } from '../utils/logger';

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

function stubBooking(rows: unknown[]) {
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

let n = 0;
const base = () => ({ city: `Thin${++n}`, checkin: '2027-05-01', checkout: '2027-05-04', adults: 2 });

beforeEach(() => {
  mockFetch.mockReset();
  jest.restoreAllMocks();
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});

describe('priceUnverified on a search too thin to price-check', () => {
  it('flags the only row of a 1-row search, keeps its price, and still logs', async () => {
    stubBooking([raw('a', 600)]);
    const out = await searchHotels(base());
    expect(out).toHaveLength(1);
    expect(out[0].priceUnverified).toBe(true);
    expect(out[0].price).toBe(600);
    expect(out[0].pricePerNight).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('too thin to price-check'),
      expect.objectContaining({ rows: 1 }),
    );
  });

  it('flags every row of a 3-row search, not just [0]', async () => {
    stubBooking([raw('a', 600), raw('b', 900), raw('c', 1200)]);
    const out = await searchHotels(base());
    expect(out).toHaveLength(3);
    expect(out.every((h) => h.priceUnverified === true)).toBe(true);
  });

  it('flags none of a normal-size search', async () => {
    stubBooking([raw('a', 600), raw('b', 900), raw('c', 1200), raw('d', 1500), raw('e', 1800)]);
    const out = await searchHotels(base());
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(out.some((h) => 'priceUnverified' in h)).toBe(false);
  });

  it('an empty search returns []', async () => {
    stubBooking([]);
    expect(await searchHotels(base())).toEqual([]);
  });

  it('a cached repeat carries the flag too', async () => {
    stubBooking([raw('a', 600), raw('b', 900)]);
    const p = base();
    await searchHotels(p);
    const again = await searchHotels(p);
    const searches = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/v1/hotels/search'));
    expect(searches).toHaveLength(1);
    expect(again.every((h) => h.priceUnverified === true)).toBe(true);
  });

  it('is judged on the rows returned after the price cap', async () => {
    stubBooking([raw('a', 600), raw('b', 900), raw('c', 1200), raw('d', 1500), raw('e', 1800)]);
    const p = base();
    const full = await searchHotels(p);
    expect(full.some((h) => h.priceUnverified)).toBe(false);
    const capped = await searchHotels({ ...p, maxPrice: 1000 });
    expect(capped).toHaveLength(2);
    expect(capped.every((h) => h.priceUnverified === true)).toBe(true);
    // The cap never annotates the cached rows the uncapped search is served.
    const fullAgain = await searchHotels(p);
    expect(fullAgain.some((h) => h.priceUnverified)).toBe(false);
  });
});
