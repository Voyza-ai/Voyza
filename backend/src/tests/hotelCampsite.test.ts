jest.mock('../config/env', () => ({
  env: { RAPIDAPI_KEY: 'test_rapid_key', SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test_key' },
}));
jest.mock('../services/supabase', () => ({
  getSupabase: () => {
    const builder: any = {
      select: () => builder, eq: () => builder, upsert: () => builder, retry: () => builder, abortSignal: () => builder,
      single: () => Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'no rows', details: '', hint: null } }),
      then: (ok: any, err: any) => Promise.resolve({ data: null, error: null }).then(ok, err),
    };
    return { from: () => builder };
  },
}));

import { isCampsite, plannerHotelPick, trustedFirst, searchHotels, type HotelResult } from '../services/hotels';

/**
 * Website audit (m8): "hu Roma Camping In Town" was the planner's hotel for a
 * Culture trip to Rome. A campsite stays in the results and stays choosable,
 * but neither the planner's pick nor `hotels[0]` (the canvas route's default)
 * is ever one.
 */
const row = (name: string, rating: number, pricePerNight: number, extra: Partial<HotelResult> = {}): HotelResult => ({
  id: name, name, price: pricePerNight * 3, pricePerNight, currency: 'USD', rating, reviewCount: 2000, stars: 3,
  thumbnail: '', bookingUrl: '', amenities: [], ...extra,
});

describe('campsites', () => {
  it('isCampsite: by name, or by Booking\'s property type', () => {
    expect(isCampsite({ name: 'hu Roma Camping In Town' })).toBe(true);
    expect(isCampsite({ name: 'Roma Green Village', accommodationType: 'Campsites' })).toBe(true);
    expect(isCampsite({ name: 'Camp Nou Suites' })).toBe(false);
    expect(isCampsite({ name: 'Hotel Artemide', accommodationType: 'Hotels' })).toBe(false);
  });

  it("the planner's pick is a hotel even when the campsite scores best", () => {
    const pick = plannerHotelPick([row('hu Roma Camping In Town', 8.9, 61), row('Hotel Artemide', 8.8, 138)]);
    expect(pick?.name).toBe('Hotel Artemide');
  });

  it('trustedFirst: hotels, then campsites, then distrusted prices', () => {
    const out = trustedFirst([row('Glitch', 9, 10, { priceSuspect: true }), row('Camping Roma', 9, 60), row('Hotel A', 8, 140)]);
    expect(out.map((h) => h.name)).toEqual(['Hotel A', 'Camping Roma', 'Glitch']);
  });

  it("a search keeps Booking's property type and puts the campsite after the hotels", async () => {
    const result = [
      { hotel_id: '1', hotel_name: 'Roma Green Village', min_total_price: '180', currency_code: 'USD', review_score: '9.1', review_nr: '900', class: '0', accommodation_type_name: 'Campsites' },
      ...[1, 2, 3, 4].map((i) => ({ hotel_id: String(10 + i), hotel_name: `Hotel ${i}`, min_total_price: String(300 + i * 30), currency_code: 'USD', review_score: '8.5', review_nr: '800', class: '3', accommodation_type_name: 'Hotels' })),
    ];
    (global as any).fetch = jest.fn((url: string) => Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve(String(url).includes('/locations') ? [{ dest_id: '-126693', dest_type: 'city' }] : { result }),
    }));
    const hotels = await searchHotels({ city: 'RomeCampTest', checkin: '2027-03-10', checkout: '2027-03-13', adults: 2 });
    expect(hotels).toHaveLength(5);
    expect(hotels[hotels.length - 1]).toMatchObject({ name: 'Roma Green Village', accommodationType: 'Campsites' });
    expect(hotels[0].accommodationType).toBe('Hotels');
  });
});
