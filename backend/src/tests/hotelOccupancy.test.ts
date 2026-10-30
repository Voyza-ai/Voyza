jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

/**
 * How many rooms a hotel search prices, end to end through `POST /api/hotels/search`.
 *
 * Every caller in the app sends `adults: travelers` and no `rooms`, so the
 * route's old `rooms: 1` default decided the occupancy for every trip. For a
 * group that asked Booking for ONE unit sleeping the whole party, and Booking
 * answered with what fits that: hostels, apartments, a campsite as Rome's top
 * pick, all shown as "6 travelers · 1 room".
 *
 * Measured against production on 2026-10-29 (same city and dates, only the
 * occupancy changed): `adults:6 rooms:3` against `adults:2 rooms:1` came back
 * at exactly 3.00x for 13 of 19 Paris hotels and 10 of 15 London hotels,
 * median 3.00x in both. So Booking's `min_total_price` already covers every
 * room requested — the price is a party total and nothing downstream may
 * multiply it again.
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

import express from 'express';
import request from 'supertest';

import hotels from '../routes/hotels';
import { errorHandler } from '../middleware/error';
import {
  dropUnusablePrices,
  flagSuspectPrices,
  roomsFor,
  type HotelResult,
} from '../services/hotels';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api/hotels', hotels);
  app.use(errorHandler);
  return app;
}
const app = makeApp();

/** A raw Booking search row, priced for the whole stay. */
const raw = (id: string, name: string, totalPrice: number, stars: number, rating = 8.4) => ({
  hotel_id: id,
  hotel_name: name,
  min_total_price: String(totalPrice),
  currency_code: 'USD',
  review_score: String(rating),
  review_nr: '900',
  class: String(stars),
  url: `https://www.booking.com/hotel/fr/${id}.html`,
});

/** Answers the locations lookup and the search; records every URL fetched. */
function stubBooking(rows: unknown[]) {
  mockFetch.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('/v1/hotels/locations')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve([{ dest_id: '-1456928', dest_type: 'city' }]),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ result: rows }),
    });
  });
}

const searchUrls = () =>
  mockFetch.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes('/v1/hotels/search'))
    .map((u) => new URL(u));

beforeEach(() => {
  mockFetch.mockReset();
});

// Each case uses its own dates so no two requests share a search: the result
// is what the provider was asked, never an earlier answer.
let day = 1;
const stay = () => {
  const d = String(day++).padStart(2, '0');
  return { checkin: `2027-02-${d}`, checkout: `2027-02-${String(Number(d) + 3).padStart(2, '0')}` };
};

describe('POST /api/hotels/search — occupancy the app actually sends', () => {
  it.each([
    [1, 1],
    [2, 1],
    [3, 2],
    [5, 3],
    [6, 3],
  ])('%i adults and no rooms asks Booking for %i room(s)', async (adults, rooms) => {
    stubBooking([raw('h1', 'Hotel One', 900, 3)]);
    const res = await request(app)
      .post('/api/hotels/search')
      .send({ city: 'Paris', ...stay(), adults });

    expect(res.status).toBe(200);
    const [url] = searchUrls();
    expect(url.searchParams.get('adults_number')).toBe(String(adults));
    expect(url.searchParams.get('room_number')).toBe(String(rooms));
  });

  it('honours an explicit room count', async () => {
    stubBooking([raw('h1', 'Hotel One', 900, 3)]);
    await request(app)
      .post('/api/hotels/search')
      .send({ city: 'Paris', ...stay(), adults: 6, rooms: 2 });

    expect(searchUrls()[0].searchParams.get('room_number')).toBe('2');
  });

  it('defaults to two adults in one room when the caller sends neither', async () => {
    stubBooking([raw('h1', 'Hotel One', 900, 3)]);
    await request(app).post('/api/hotels/search').send({ city: 'Paris', ...stay() });

    const [url] = searchUrls();
    expect(url.searchParams.get('adults_number')).toBe('2');
    expect(url.searchParams.get('room_number')).toBe('1');
  });

  it('returns the provider price as the party total — nothing multiplies it', async () => {
    // 3 nights, three rooms, $1803.78 for the lot: Mercure Tour Eiffel
    // Grenelle in the 2026-10-29 production capture for 6 adults / 3 rooms.
    stubBooking([raw('51086', 'Mercure Tour Eiffel Grenelle', 1803.78, 4)]);
    const res = await request(app)
      .post('/api/hotels/search')
      .send({ city: 'Paris', ...stay(), adults: 6 });

    expect(res.body.hotels[0].price).toBe(1803.78);
    expect(res.body.hotels[0].pricePerNight).toBe(601.26);
  });
});

/**
 * The price guards in `services/hotels.ts` were calibrated on single rooms.
 * A party total for three rooms is three times the number they were tuned on,
 * so each absolute threshold has to be read per room or it changes meaning.
 */
describe('price guards read a multi-room price per room', () => {
  // Normal 3-star stock for 6 adults in 3 rooms, 3 nights: $190-$300 per room
  // per night, so $570-$900 a night for the party.
  const normal3Star = [
    raw('n1', 'Chalet A', 3 * 3 * 190, 3),
    raw('n2', 'Chalet B', 3 * 3 * 230, 3),
    raw('n3', 'Chalet C', 3 * 3 * 260, 3),
    raw('n4', 'Chalet D', 3 * 3 * 300, 3),
  ];

  it('does not condemn a real 3-star room just because three of them pass $2000', async () => {
    // $860.58 per room per night is the dearest legitimate 1-3 star row in the
    // captured corpus (a Courchevel chalet in February) — the number the
    // $2000 star ceiling was calibrated against. Three of them are $2581.74 a
    // night, which a per-party reading of that ceiling flags.
    const chalet = raw('c1', 'Courchevel Chalet', 3 * 3 * 860.58, 3);
    stubBooking([...normal3Star, chalet]);

    const res = await request(app)
      .post('/api/hotels/search')
      .send({ city: 'Courchevel', ...stay(), adults: 6 });

    const row = res.body.hotels.find((h: any) => h.name === 'Courchevel Chalet');
    expect(row).toBeDefined();
    expect(row.priceSuspect).toBeFalsy();
  });

  it('still flags the Aldobrandini glitch when it is priced for three rooms', async () => {
    // $5383.47/night for "Hotel Aldobrandini", stars: 3 — the glitch the star
    // ceiling exists for — quoted for each of three rooms.
    const glitch = raw('g1', 'Hotel Aldobrandini', 3 * 3 * 5383.47, 3);
    stubBooking([...normal3Star, glitch]);

    const res = await request(app)
      .post('/api/hotels/search')
      .send({ city: 'Florence', ...stay(), adults: 6 });

    const row = res.body.hotels.find((h: any) => h.name === 'Hotel Aldobrandini');
    expect(row.priceSuspect).toBe(true);
    expect(row.priceSuspectReason).toBe('above-star-ceiling');
    // ...and it is not the hotel the trip would take.
    expect(res.body.hotels[0].name).not.toBe('Hotel Aldobrandini');
  });

  it('judges an odd party per room too: 5 adults are three rooms, not 2.5', async () => {
    // $780 per room per night: real 3-star stock, under the ceiling per room,
    // over it for the party of three rooms ($2340).
    const dear = raw('d1', 'Dear but real', 3 * 3 * 780, 3);
    stubBooking([...normal3Star, dear]);

    const res = await request(app)
      .post('/api/hotels/search')
      .send({ city: 'Zermatt', ...stay(), adults: 5 });

    expect(searchUrls()[0].searchParams.get('room_number')).toBe('3');
    const row = res.body.hotels.find((h: any) => h.name === 'Dear but real');
    expect(row.priceSuspect).toBeFalsy();
  });
});

describe('guards on a multi-room price give the single-room verdicts', () => {
  const row = (name: string, perRoomNight: number, stars: number, rooms: number) =>
    ({
      id: name,
      name,
      rating: 8,
      reviewCount: 100,
      stars,
      pricePerNight: perRoomNight * rooms,
      price: perRoomNight * rooms * 3,
      currency: 'USD',
      thumbnail: '',
      bookingUrl: '',
      amenities: [],
    }) as HotelResult;

  // One search with something for every rule: a normal 3-star tier, a 4-star
  // tier with an under-priced row, the Aldobrandini glitch, the Courchevel
  // chalet, an unrated tier and a thin luxury pair.
  const corpus = (rooms: number) => [
    ...[150, 170, 190, 210, 240].map((p, i) => row(`3star-${i}`, p, 3, rooms)),
    row('Hotel Aldobrandini', 5383.47, 3, rooms),
    row('Courchevel Chalet', 860.58, 3, rooms),
    ...[260, 280, 300, 320].map((p, i) => row(`4star-${i}`, p, 4, rooms)),
    row('4star-underpriced', 18, 4, rooms),
    ...[60, 80, 95, 110].map((p, i) => row(`unrated-${i}`, p, 0, rooms)),
    row('Overwater A', 1900, 5, rooms),
    row('Overwater B', 2400, 5, rooms),
  ];
  const verdicts = (rows: HotelResult[]) =>
    rows.map((h) => `${h.name}:${h.priceSuspect ? h.priceSuspectReason : 'ok'}`);

  it.each([2, 3, 5])('%i rooms: identical verdicts to one room', (rooms) => {
    const single = verdicts(flagSuspectPrices(corpus(1), 'Mixed'));
    const multi = verdicts(flagSuspectPrices(corpus(rooms), 'Mixed', rooms));
    expect(multi).toEqual(single);
    // The fixture really does exercise the rules it claims to.
    expect(single).toEqual(
      expect.arrayContaining([
        'Hotel Aldobrandini:above-star-ceiling',
        'Courchevel Chalet:ok',
        '4star-underpriced:below-tier-median',
        'Overwater B:ok',
      ]),
    );
  });

  it('leaves the party totals on the rows untouched', () => {
    const out = flagSuspectPrices(corpus(3), 'Mixed', 3);
    expect(out.find((h) => h.name === 'Courchevel Chalet')!.pricePerNight).toBeCloseTo(860.58 * 3);
  });

  it('applies the $1 floor per room', () => {
    // A cheap real room in the weakest markets converts to about $4.43
    // (70,000 IDR) — three of them must survive. A party total of $2 a night
    // for three rooms is 67 cents a room, which no room costs.
    const kept = dropUnusablePrices(
      [row('Real budget', 4.43, 1, 3), row('Not a price', 2 / 3, 1, 3)],
      'Lombok',
      3,
    );
    expect(kept.map((h) => h.name)).toEqual(['Real budget']);
  });

  it('defaults to one room per two adults, rounding an odd adult up', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(roomsFor)).toEqual([1, 1, 2, 2, 3, 3, 4]);
  });
});
