jest.mock('../config/env', () => ({
  env: {
    RAPIDAPI_KEY: 'test_rapid_key',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
  },
}));

jest.mock('../services/supabase', () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: null }),
        }),
      }),
      upsert: () => Promise.resolve({ data: null }),
    }),
  }),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

import { searchHotels } from '../services/hotels';

describe('searchHotels', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes hotel results and filters by rating >= 7.0', async () => {
    // First call: getDestinationId
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([
            { dest_id: '12345', dest_type: 'city', name: 'Rome' },
          ]),
      })
      // Second call: search
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            result: [
              {
                hotel_id: 'h1',
                hotel_name: 'Grand Hotel',
                min_total_price: '300',
                currency_code: 'USD',
                review_score: '8.5',
                review_nr: '1200',
                class: '4',
                main_photo_url: 'https://img.example.com/h1.jpg',
                url: 'https://booking.com/hotel/h1',
              },
              {
                hotel_id: 'h2',
                hotel_name: 'Budget Hostel',
                min_total_price: '80',
                currency_code: 'USD',
                review_score: '5.2',
                review_nr: '50',
                class: '1',
                main_photo_url: 'https://img.example.com/h2.jpg',
                url: 'https://booking.com/hotel/h2',
              },
              {
                hotel_id: 'h3',
                hotel_name: 'Nice B&B',
                min_total_price: '200',
                currency_code: 'USD',
                review_score: '7.8',
                review_nr: '300',
                class: '3',
                main_photo_url: 'https://img.example.com/h3.jpg',
                url: 'https://booking.com/hotel/h3',
              },
            ],
          }),
      });

    const hotels = await searchHotels({
      city: 'Rome',
      checkin: '2026-06-01',
      checkout: '2026-06-04',
      adults: 2,
      rooms: 1,
    });

    // Budget Hostel should be filtered out (5.2 < 7.0)
    expect(hotels).toHaveLength(2);
    expect(hotels.find((h) => h.name === 'Budget Hostel')).toBeUndefined();
    expect(hotels[0].name).toBe('Grand Hotel');
    expect(hotels[0].price).toBe(300);
    expect(hotels[0].pricePerNight).toBe(100); // 300 / 3 nights
    expect(hotels[1].name).toBe('Nice B&B');
  });

  it('returns empty array when RAPIDAPI_KEY is missing', async () => {
    // Override env for this test
    const envMod = require('../config/env');
    const origKey = envMod.env.RAPIDAPI_KEY;
    envMod.env.RAPIDAPI_KEY = undefined;

    const hotels = await searchHotels({
      city: 'Rome',
      checkin: '2026-06-01',
      checkout: '2026-06-04',
      adults: 2,
      rooms: 1,
    });

    expect(hotels).toEqual([]);
    envMod.env.RAPIDAPI_KEY = origKey;
  });

  it('applies maxPrice filter', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve([{ dest_id: '12345', dest_type: 'city' }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            result: [
              {
                hotel_id: 'h1',
                hotel_name: 'Expensive Hotel',
                min_total_price: '500',
                currency_code: 'USD',
                review_score: '9.0',
                class: '5',
              },
              {
                hotel_id: 'h2',
                hotel_name: 'Affordable Hotel',
                min_total_price: '150',
                currency_code: 'USD',
                review_score: '7.5',
                class: '3',
              },
            ],
          }),
      });

    const hotels = await searchHotels({
      city: 'Rome',
      checkin: '2026-06-01',
      checkout: '2026-06-04',
      adults: 2,
      rooms: 1,
      maxPrice: 200,
    });

    expect(hotels).toHaveLength(1);
    expect(hotels[0].name).toBe('Affordable Hotel');
  });
});
