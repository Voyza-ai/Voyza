jest.mock('../config/env', () => ({
  env: {
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

/**
 * Pricing ONE named hotel (the preset refresh's path) must find THAT hotel.
 *
 * `isSameHotel` asks that every distinctive word of the preset's hotel name
 * appear in the candidate's name. The city's name counted as distinctive, so
 * for "Krabi Resort" in Krabi the only word left to check was "krabi" — which
 * every hotel in Krabi that puts the town in its name has. "Krabi La Playa
 * Resort" passed, and the preset was repriced from a different property.
 */

jest.mock('../services/supabase', () => ({
  getSupabase: () => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      upsert: () => builder,
      retry: () => builder,
      abortSignal: () => builder,
      single: () => Promise.resolve({ data: null, error: { code: 'PGRST116', message: '' } }),
      then: (onOk: any, onErr: any) =>
        Promise.resolve({ data: null, error: null }).then(onOk, onErr),
    };
    return { from: () => builder };
  },
}));

import { isSameHotel, searchHotels } from '../services/hotels';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** Booking's name lookup offers `candidates`; the search returns that property. */
function stubLookup(candidates: Array<{ dest_id: string; name: string }>) {
  mockFetch.mockImplementation((url: string) => {
    const u = String(url);
    if (u.includes('/locations')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(candidates.map((c) => ({ ...c, dest_type: 'hotel' }))),
      });
    }
    const destId = new URL(u).searchParams.get('dest_id');
    const hit = candidates.find((c) => c.dest_id === destId)!;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          result: [
            {
              hotel_id: destId,
              hotel_name: hit.name,
              min_total_price: '600',
              currency_code: 'USD',
              review_score: '8.6',
              class: '4',
            },
          ],
        }),
    });
  });
}

const priceOne = (city: string, hotelName: string, checkin = '2027-06-01') =>
  searchHotels({ city, hotelName, checkin, checkout: '2027-06-04', adults: 2, rooms: 1 });

beforeEach(() => mockFetch.mockReset());

describe('pricing one named hotel', () => {
  it('does not take a different property that merely shares the town name', async () => {
    stubLookup([{ dest_id: '501', name: 'Krabi La Playa Resort' }]);

    const offers = await priceOne('Krabi', 'Krabi Resort');

    expect(offers).toEqual([]);
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('/v1/hotels/search'))).toBe(false);
  });

  it('still finds the hotel when its name carries the city as well', async () => {
    stubLookup([
      { dest_id: '501', name: 'Krabi La Playa Resort' },
      { dest_id: '777', name: 'Hotel Gracery Shinjuku Tokyo' },
    ]);

    const offers = await priceOne('Tokyo', 'Gracery Shinjuku', '2027-06-02');

    expect(offers.map((o) => o.name)).toEqual(['Hotel Gracery Shinjuku Tokyo']);
  });
});

describe('isSameHotel with the city named', () => {
  it.each([
    ['Krabi Resort', 'Krabi La Playa Resort', 'Krabi', false],
    ['Hotel Krabi', 'Krabi Hotel & Spa', 'Krabi', false], // nothing but the town
    ['Gracery Shinjuku', 'Hotel Gracery Shinjuku Tokyo', 'Tokyo', true],
    ['Hotel Arts Barcelona', 'Hotel Arts Barcelona', 'Barcelona', true],
    ['Copacabana Palace Rio', 'Belmond Copacabana Palace', 'Rio de Janeiro', true],
    ['Hôtel Le Marais Paris', 'hotel le marais', 'Paris', true],
  ])('%s vs %s in %s → %s', (preset, result, city, same) => {
    expect(isSameHotel(preset, result, city)).toBe(same);
  });

  it('is unchanged when no city is given', () => {
    // presets.ts calls it with two arguments; those callers see the old rule.
    expect(isSameHotel('Krabi Resort', 'Krabi La Playa Resort')).toBe(true);
    expect(isSameHotel('Hotel Arts Barcelona', 'Arts Hotel Porto')).toBe(false);
  });
});
