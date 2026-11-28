jest.mock('../config/env', () => ({
  env: {
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

/**
 * The city guide's photo strip: a hotel's gallery from Booking's photos
 * endpoint, large size, capped, cached, and refused for anything that is not
 * a Booking hotel id.
 */

import request from 'supertest';
import express from 'express';
import hotelsRouter from '../routes/hotels';
import { photoUrls, hotelPhotos, clearHotelPhotoCache, PHOTO_LIMIT } from '../services/hotelPhotos';

const row = (id: number) => ({
  photo_id: id,
  url_square60: `https://cf.bstatic.com/xdata/images/hotel/square60/${id}.jpg`,
  url_max: `https://cf.bstatic.com/xdata/images/hotel/max1280x900/${id}.jpg`,
  url_1440: `https://cf.bstatic.com/xdata/images/hotel/1440x1440/${id}.jpg`,
});

const app = express();
app.use(express.json());
app.use('/api/hotels', hotelsRouter);

const fetchMock = jest.fn();
beforeEach(() => {
  clearHotelPhotoCache();
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});

describe('photoUrls', () => {
  it('takes the large size, once each, in Booking’s order', () => {
    expect(photoUrls([row(1), row(2), row(1)])).toEqual([row(1).url_max, row(2).url_max]);
  });

  it('falls back to the 1440 size, and skips rows with no usable URL', () => {
    expect(photoUrls([{ url_1440: row(3).url_1440 }, { url_max: 'http://insecure/x.jpg' }, {}, null])).toEqual([row(3).url_1440]);
  });

  it(`keeps at most ${PHOTO_LIMIT}`, () => {
    expect(photoUrls(Array.from({ length: 30 }, (_, i) => row(i)))).toHaveLength(PHOTO_LIMIT);
  });

  it('anything but a list is no photos', () => {
    expect(photoUrls({ message: 'You are not subscribed' })).toEqual([]);
  });
});

describe('hotelPhotos', () => {
  it('asks Booking once per hotel, then answers from memory', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [row(1), row(2)] });
    expect(await hotelPhotos('15248006')).toHaveLength(2);
    expect(await hotelPhotos('15248006')).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/hotels/photos?hotel_id=15248006');
    expect(fetchMock.mock.calls[0][1].headers['X-RapidAPI-Key']).toBe('test_rapid_key');
  });

  it('a failure is [] and is asked again next time', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => [row(1)] });
    expect(await hotelPhotos('1')).toEqual([]);
    expect(await hotelPhotos('1')).toEqual([row(1).url_max]);
  });

  it('a thrown fetch (timeout, offline) is []', async () => {
    fetchMock.mockRejectedValueOnce(new Error('timeout'));
    expect(await hotelPhotos('2')).toEqual([]);
  });
});

describe('GET /api/hotels/photos', () => {
  it('returns the hotel’s photos', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [row(7)] });
    const res = await request(app).get('/api/hotels/photos?hotelId=217618');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ photos: [row(7).url_max] });
  });

  it('refuses anything that is not a Booking hotel id, without calling Booking', async () => {
    for (const bad of ['', 'abc', '1;drop', '1234567890123']) {
      const res = await request(app).get(`/api/hotels/photos?hotelId=${encodeURIComponent(bad)}`);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
