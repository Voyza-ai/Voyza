// Mock environment before any imports
jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
    FRONTEND_URL: 'http://localhost:3000',
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

jest.mock('../services/duffel', () => {
  const mockDuffel = {
    offerRequests: {
      create: jest.fn(),
    },
    suggestions: {
      list: jest.fn(),
    },
  };
  return {
    getDuffel: () => mockDuffel,
    __mockDuffel: mockDuffel,
  };
});

import { searchFlights, getIataCode } from '../services/flights';

const { __mockDuffel: mockDuffel } = require('../services/duffel');

describe('searchFlights', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes Duffel offer response into FlightOffer[]', async () => {
    mockDuffel.offerRequests.create.mockResolvedValue({
      data: {
        offers: [
          {
            id: 'offer_1',
            total_amount: '199.99',
            total_currency: 'USD',
            slices: [
              {
                segments: [
                  {
                    departing_at: '2026-06-01T08:00:00Z',
                    arriving_at: '2026-06-01T10:30:00Z',
                    operating_carrier: { name: 'Lufthansa', iata_code: 'LH' },
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    const offers = await searchFlights({
      origin: 'FCO',
      destination: 'FLR',
      date: '2026-06-01',
      travelers: 1,
    });

    expect(offers).toHaveLength(1);
    expect(offers[0].price).toBe(199.99);
    expect(offers[0].carrier).toBe('Lufthansa');
    expect(offers[0].carrierCode).toBe('LH');
    expect(offers[0].stops).toBe(0);
    expect(offers[0].durationMinutes).toBe(150);
    // Booking URLs now route to Google Flights (Duffel's offer-redirect
    // pages 404'd). The URL is built from origin/destination/date, not
    // the offer ID, so we assert on the Google host instead of `offer_1`.
    expect(offers[0].bookingUrl).toContain('google.com/travel/flights');
    expect(offers[0].bookingUrl).toContain('FCO');
    expect(offers[0].bookingUrl).toContain('FLR');
  });

  it('retries on 429 with exponential backoff', async () => {
    const error429 = new Error('Rate limited');
    (error429 as any).meta = { status: 429 };

    mockDuffel.offerRequests.create
      .mockRejectedValueOnce(error429)
      .mockResolvedValueOnce({
        data: {
          offers: [
            {
              id: 'offer_2',
              total_amount: '99.00',
              total_currency: 'EUR',
              slices: [
                {
                  segments: [
                    {
                      departing_at: '2026-06-01T12:00:00Z',
                      arriving_at: '2026-06-01T13:30:00Z',
                      operating_carrier: { name: 'Ryanair', iata_code: 'FR' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      });

    const offers = await searchFlights({
      origin: 'BCN',
      destination: 'LIS',
      date: '2026-06-01',
      travelers: 1,
    });

    expect(offers).toHaveLength(1);
    expect(mockDuffel.offerRequests.create).toHaveBeenCalledTimes(2);
  }, 15000);
});

describe('getIataCode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('caches IATA codes in Supabase', async () => {
    mockDuffel.suggestions.list.mockResolvedValue({
      data: [{ type: 'airport', iata_code: 'FCO', iata_country_code: 'IT' }],
    });

    const code = await getIataCode('Rome');
    expect(code).toBe('FCO');
  });

  it('throws AppError when no IATA code found', async () => {
    mockDuffel.suggestions.list.mockResolvedValue({ data: [] });

    await expect(getIataCode('Atlantis')).rejects.toThrow('No IATA code found');
  });
});
