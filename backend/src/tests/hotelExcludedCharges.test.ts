jest.mock('../config/env', () => ({
  env: {
    NODE_ENV: 'test',
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

/**
 * Charges Booking lists as EXCLUDED from the price it quotes (city tax,
 * cleaning fees, service charges), end to end through `POST /api/hotels/search`.
 *
 * The mapping read `min_total_price`, which is Booking's GROSS price, and
 * nothing else — so a Paris stay was quoted without its taxe de séjour, an
 * apartment without its cleaning fee, and the planner's existing
 * "Taxes & fees" line never showed because `taxesPerNight` was never set.
 *
 * The rows below are copied field-for-field from two raw RapidAPI Booking
 * responses (no raw response from our own subscription has been recorded):
 *
 *   - a /v1/hotels/search Vienna search (rows at the top level, both the
 *     legacy `price_breakdown` and `composite_price_breakdown`);
 *   - a Paris search in the `{ data: { result } }` shape, which carries only
 *     `composite_price_breakdown`. 18 of its 20 rows have all-inclusive above
 *     gross; Kraft Hotel is €360.03 gross, €392.55 all-inclusive, the €32.52
 *     difference being Paris city tax charged per person per night.
 *
 * In every one of the 40 rows `min_total_price` equals the breakdown's gross,
 * and `all_inclusive - gross` equals Booking's own `excluded_amount`.
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

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const app = (() => {
  const a = express();
  a.use(express.json());
  a.use('/api/hotels', hotels);
  a.use(errorHandler);
  return a;
})();

/** 1 USD = 0.8 EUR, so every EUR amount is worth 1.25 USD. */
const FX = { result: 'success', rates: { USD: 1, EUR: 0.8 } };

/** Answers the locations lookup, the search and the FX table. */
function stubBooking(rows: unknown[]) {
  mockFetch.mockImplementation((url: string) => {
    const u = String(url);
    const json = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (u.includes('open.er-api.com')) return json(FX);
    if (u.includes('/v1/hotels/locations')) return json([{ dest_id: '-1456928', dest_type: 'city' }]);
    return json({ result: rows });
  });
}

const amount = (value: number, currency = 'EUR') => ({ value, currency });

/** Paris sample, Kraft Hotel: city tax €8.13 per person per night, excluded. */
const kraft = (over: Record<string, unknown> = {}) => ({
  hotel_id: 1001,
  hotel_name: 'Kraft Hotel',
  min_total_price: 360.03,
  currencycode: 'EUR',
  review_score: 8.6,
  review_nr: 1200,
  class: 3,
  url: 'https://www.booking.com/hotel/fr/kraft.html',
  composite_price_breakdown: {
    gross_amount: amount(360.03),
    all_inclusive_amount: amount(392.55),
    excluded_amount: amount(32.52),
  },
  ...over,
});

/** Vienna sample, Apps 21: legacy breakdown, €45 cleaning + €72 electricity excluded. */
const apps21 = (over: Record<string, unknown> = {}) => ({
  hotel_id: 1002,
  hotel_name: 'Apps 21',
  min_total_price: 656.64,
  currency_code: 'EUR',
  review_score: 6.9,
  review_nr: 274,
  class: 0,
  url: 'https://www.booking.com/hotel/at/apps-21.html',
  price_breakdown: {
    currency: 'EUR',
    gross_price: 656.64,
    all_inclusive_price: 773.64,
    sum_excluded_raw: '117.00',
  },
  ...over,
});

/** Paris sample, Yuna Porte-Maillot: city tax already included, nothing excluded. */
const yuna = () => ({
  hotel_id: 1003,
  hotel_name: 'Yuna Porte-Maillot - ApartHotel',
  min_total_price: 492.47,
  currencycode: 'EUR',
  review_score: 9.4,
  review_nr: 914,
  class: 4,
  url: 'https://www.booking.com/hotel/fr/yuna.html',
  composite_price_breakdown: {
    gross_amount: amount(492.47),
    all_inclusive_amount: amount(492.47),
    excluded_amount: amount(0),
  },
});

/** A row with no breakdown at all — what every recorded mapped capture looks like. */
const bare = (id: number, name: string, total: number) => ({
  hotel_id: id,
  hotel_name: name,
  min_total_price: total,
  currency_code: 'USD',
  review_score: 8.2,
  review_nr: 500,
  class: 3,
  url: `https://www.booking.com/hotel/fr/${id}.html`,
});

beforeEach(() => mockFetch.mockReset());

// Each case gets its own dates, so no two requests share a cached search.
let day = 1;
const stay = (nights = 2) => {
  const d = day++;
  const pad = (n: number) => String(n).padStart(2, '0');
  return { checkin: `2027-03-${pad(d)}`, checkout: `2027-03-${pad(d + nights)}` };
};

async function search(rows: unknown[], extra: Record<string, unknown> = {}, nights = 2) {
  stubBooking(rows);
  const res = await request(app)
    .post('/api/hotels/search')
    .send({ city: 'Paris', ...stay(nights), adults: 2, ...extra });
  expect(res.status).toBe(200);
  return res.body.hotels as any[];
}

const byName = (hotels: any[], name: string) => hotels.find((h) => h.name === name);

describe('excluded charges become taxesPerNight', () => {
  it('composite_price_breakdown: all-inclusive minus gross, per night, converted at the same rate as the price', async () => {
    const hotels = await search([kraft(), yuna(), bare(7, 'Hotel Seven', 300), bare(8, 'Hotel Eight', 320)]);
    const h = byName(hotels, 'Kraft Hotel');
    // Price: €360.03 → $450.04 for the two nights, as before.
    expect(h.price).toBe(450.04);
    expect(h.pricePerNight).toBe(225.02);
    // Excluded: €392.55 − €360.03 = €32.52 → $40.65 → $20.33 a night.
    expect(h.taxesPerNight).toBe(20.33);
  });

  it('price_breakdown (the legacy block): all_inclusive_price minus gross_price', async () => {
    const hotels = await search([apps21(), bare(7, 'Hotel Seven', 300), bare(8, 'Hotel Eight', 320), bare(9, 'Hotel Nine', 340)], {}, 3);
    const h = byName(hotels, 'Apps 21');
    // €117 → $146.25 over three nights.
    expect(h.taxesPerNight).toBe(48.75);
  });

  it('a row whose breakdown has nothing excluded says so: taxesPerNight 0', async () => {
    const hotels = await search([yuna(), bare(7, 'Hotel Seven', 300), bare(8, 'Hotel Eight', 320), bare(9, 'Hotel Nine', 340)]);
    expect(byName(hotels, 'Yuna Porte-Maillot - ApartHotel').taxesPerNight).toBe(0);
  });

  it('a row with no breakdown is left unset, not zero', async () => {
    const hotels = await search([bare(7, 'Hotel Seven', 300), bare(8, 'Hotel Eight', 320), bare(9, 'Hotel Nine', 340), bare(10, 'Hotel Ten', 360)]);
    for (const h of hotels) expect(h).not.toHaveProperty('taxesPerNight');
  });
});

describe('the price is already the party total — so are its excluded charges', () => {
  it('six adults in three rooms: the excluded amount is divided by nights only, never multiplied by rooms', async () => {
    // Paris city tax is per person per night, so Booking's all-inclusive for
    // six adults already carries six people's tax: €8.13 × 6 × 2 = €97.56.
    const party = kraft({
      min_total_price: 1080.09,
      composite_price_breakdown: {
        gross_amount: amount(1080.09),
        all_inclusive_amount: amount(1177.65),
        excluded_amount: amount(97.56),
      },
    });
    const hotels = await search([party, bare(7, 'Hotel Seven', 900), bare(8, 'Hotel Eight', 960), bare(9, 'Hotel Nine', 1020)], { adults: 6 });
    const h = byName(hotels, 'Kraft Hotel');
    const searched = new URL(String(mockFetch.mock.calls.map((c) => c[0]).find((u) => String(u).includes('/v1/hotels/search'))));
    expect(searched.searchParams.get('room_number')).toBe('3');
    expect(h.price).toBe(1350.11);
    // €97.56 → $121.95 for the stay → $60.98 a night, for the whole party.
    expect(h.taxesPerNight).toBe(60.98);
  });
});

describe('never a wrong number: anything that does not add up is left unset', () => {
  const peers = [bare(7, 'Hotel Seven', 300), bare(8, 'Hotel Eight', 320), bare(9, 'Hotel Nine', 340)];

  it.each([
    ['all-inclusive below gross', { gross_amount: amount(360.03), all_inclusive_amount: amount(350) }],
    ['all-inclusive not a number', { gross_amount: amount(360.03), all_inclusive_amount: { value: 'n/a', currency: 'EUR' } }],
    ['all-inclusive missing', { gross_amount: amount(360.03) }],
    ['gross missing', { all_inclusive_amount: amount(392.55) }],
    ['the two amounts in different currencies', { gross_amount: amount(360.03), all_inclusive_amount: amount(392.55, 'USD') }],
    ['the breakdown in another currency than the price', { gross_amount: amount(360.03, 'GBP'), all_inclusive_amount: amount(392.55, 'GBP') }],
    ['the breakdown describing another price than the one quoted', { gross_amount: amount(300), all_inclusive_amount: amount(332.52) }],
  ])('%s', async (_label, breakdown) => {
    const hotels = await search([kraft({ composite_price_breakdown: breakdown }), ...peers]);
    const h = byName(hotels, 'Kraft Hotel');
    expect(h).toBeDefined();
    expect(h).not.toHaveProperty('taxesPerNight');
  });

  it('a negative legacy difference is unset too', async () => {
    const row = apps21({ price_breakdown: { currency: 'EUR', gross_price: 656.64, all_inclusive_price: 600 } });
    const hotels = await search([row, ...peers]);
    expect(byName(hotels, 'Apps 21')).not.toHaveProperty('taxesPerNight');
  });

  it('every number that comes back is finite and non-negative', async () => {
    const rows = [kraft(), apps21(), yuna(), ...peers];
    const hotels = await search(rows);
    for (const h of hotels) {
      if (!('taxesPerNight' in h)) continue;
      expect(Number.isFinite(h.taxesPerNight)).toBe(true);
      expect(h.taxesPerNight).toBeGreaterThanOrEqual(0);
    }
  });
});
