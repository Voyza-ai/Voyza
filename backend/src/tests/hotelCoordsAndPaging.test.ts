jest.mock('../config/env', () => ({
  env: {
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

/**
 * The city guide's hotel map and "Find more hotels".
 *
 * The map pins each hotel where Booking says it is — the search rows carry
 * `latitude`/`longitude`, which the mapping used to drop. "Find more hotels"
 * asks for a later page of the same search once the first page is used up.
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

import request from 'supertest';
import express from 'express';
import hotelsRouter from '../routes/hotels';
import { coordsFromRow, searchHotels } from '../services/hotels';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const raw = (id: string, totalPrice: number, extra: Record<string, unknown> = {}) => ({
  hotel_id: id,
  hotel_name: `Hotel ${id}`,
  min_total_price: String(totalPrice),
  currency_code: 'USD',
  review_score: '8.4',
  review_nr: '500',
  class: '3',
  url: `https://www.booking.com/hotel/fr/${id}.html`,
  ...extra,
});

const rowsFor = (prefix: string) =>
  [600, 900, 1200, 1500, 1800].map((p, i) =>
    raw(`${prefix}${i}`, p, { latitude: 48.85 + i / 100, longitude: 2.35 + i / 100 }),
  );

/** Booking stub that answers a different set of rows for each page. */
function stubBooking() {
  mockFetch.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('/locations')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([{ dest_id: '-1456928', dest_type: 'city' }]) });
    }
    const page = new URL(u).searchParams.get('page_number') ?? '0';
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ result: rowsFor(`p${page}-`) }) });
  });
}

const searchUrls = () =>
  mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/v1/hotels/search'));

let n = 0;
const base = () => ({ city: `Coords${++n}`, checkin: '2027-05-01', checkout: '2027-05-04', adults: 2 });

beforeEach(() => {
  mockFetch.mockReset();
  stubBooking();
});

describe('coordsFromRow', () => {
  it('keeps a real pair, numeric or string', () => {
    expect(coordsFromRow({ latitude: 48.8566, longitude: 2.3522 })).toEqual({ lat: 48.8566, lng: 2.3522 });
    expect(coordsFromRow({ latitude: '51.5072', longitude: '-0.1276' })).toEqual({ lat: 51.5072, lng: -0.1276 });
  });

  it('drops a missing half, garbage, out-of-range values and 0,0', () => {
    expect(coordsFromRow({ latitude: 48.8 })).toBeUndefined();
    expect(coordsFromRow({ latitude: 'abc', longitude: '2.3' })).toBeUndefined();
    expect(coordsFromRow({ latitude: 95, longitude: 2.3 })).toBeUndefined();
    expect(coordsFromRow({ latitude: 0, longitude: 0 })).toBeUndefined();
    expect(coordsFromRow(null)).toBeUndefined();
  });
});

describe('hotel search rows carry district and address', () => {
  it('as Booking sent them, trimmed; absent when Booking had none', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            String(url).includes('/locations')
              ? [{ dest_id: '-2', dest_type: 'city' }]
              : {
                  result: [600, 900, 1200, 1500, 1800].map((p, i) =>
                    raw(`d${i}`, p, i === 0 ? { district: ' Tower Hamlets ', address: '86 Brick Lane' } : { district: '', address: null }),
                  ),
                },
          ),
      }),
    );
    const hotels = await searchHotels(base());
    expect(hotels.find((h) => h.name === 'Hotel d0')).toMatchObject({ district: 'Tower Hamlets', address: '86 Brick Lane' });
    const other = hotels.find((h) => h.name === 'Hotel d1')!;
    expect(other.district).toBeUndefined();
    expect(other.address).toBeUndefined();
  });
});

describe('hotel search rows carry coordinates', () => {
  it('each hotel keeps the latitude/longitude Booking sent', async () => {
    const hotels = await searchHotels(base());
    expect(hotels.length).toBe(5);
    for (const h of hotels) {
      expect(typeof h.lat).toBe('number');
      expect(typeof h.lng).toBe('number');
    }
    const first = hotels.find((h) => h.name === 'Hotel p0-0');
    expect(first).toMatchObject({ lat: 48.85, lng: 2.35 });
  });

  it('a row without coordinates has none, rather than 0,0', async () => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            String(url).includes('/locations')
              ? [{ dest_id: '-1', dest_type: 'city' }]
              : { result: [600, 900, 1200, 1500, 1800].map((p, i) => raw(`x${i}`, p)) },
          ),
      }),
    );
    const hotels = await searchHotels(base());
    expect(hotels.length).toBe(5);
    for (const h of hotels) {
      expect('lat' in h).toBe(false);
      expect('lng' in h).toBe(false);
    }
  });
});

describe('a later page of the same search', () => {
  it('page 0 sends no page_number, so the planner request is unchanged', async () => {
    await searchHotels(base());
    expect(searchUrls()).toHaveLength(1);
    expect(new URL(searchUrls()[0]).searchParams.has('page_number')).toBe(false);
  });

  it('page 1 asks Booking for page_number=1 and returns that page’s hotels', async () => {
    const p = base();
    const first = await searchHotels(p);
    const second = await searchHotels({ ...p, page: 1 });
    expect(searchUrls()).toHaveLength(2);
    expect(new URL(searchUrls()[1]).searchParams.get('page_number')).toBe('1');
    const firstNames = new Set(first.map((h) => h.name));
    expect(second.length).toBe(5);
    expect(second.every((h) => !firstNames.has(h.name))).toBe(true);
  });

  it('each page is cached separately, and an explicit page 0 shares the default entry', async () => {
    const p = base();
    await searchHotels(p);
    await searchHotels({ ...p, page: 0 });
    await searchHotels({ ...p, page: 1 });
    await searchHotels({ ...p, page: 1 });
    expect(searchUrls()).toHaveLength(2);
  });
});

describe('POST /api/hotels/search', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/hotels', hotelsRouter);

  it('passes `page` through and returns coordinates', async () => {
    const res = await request(app)
      .post('/api/hotels/search')
      .send({ ...base(), page: 2 })
      .expect(200);
    expect(new URL(searchUrls()[0]).searchParams.get('page_number')).toBe('2');
    expect(res.body.hotels[0].name).toMatch(/^Hotel p2-/);
    expect(typeof res.body.hotels[0].lat).toBe('number');
  });

  it('rejects a page past the cap', async () => {
    const res = await request(app).post('/api/hotels/search').send({ ...base(), page: 6 });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(searchUrls()).toHaveLength(0);
  });
});
