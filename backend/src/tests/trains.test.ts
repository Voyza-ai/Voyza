jest.mock('../config/env', () => ({
  env: {
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
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

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

import { searchTrains, getStopId } from '../services/trains';

describe('getStopId', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fetches stop ID from DB API and returns it', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([{ id: '8000105', name: 'Frankfurt(Main)Hbf' }]),
    });

    const stopId = await getStopId('Frankfurt');
    expect(stopId).toBe('8000105');
  });

  it('throws error when no stop found', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([]),
    });

    await expect(getStopId('Atlantis')).rejects.toThrow('No stop found');
  });
});

describe('searchTrains', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('normalizes journey data into TrainOffer[]', async () => {
    // First two calls: getStopId for origin and destination
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ id: '8000105' }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ id: '8000261' }]),
      })
      // Third call: journeys
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            journeys: [
              {
                legs: [
                  {
                    departure: '2026-06-01T08:00:00+02:00',
                    arrival: '2026-06-01T12:00:00+02:00',
                    line: {
                      operator: { name: 'Deutsche Bahn' },
                      productName: 'ICE',
                    },
                  },
                ],
                price: { amount: '49.90', currency: 'EUR' },
              },
            ],
          }),
      });

    const offers = await searchTrains({
      origin: 'Frankfurt',
      destination: 'Munich',
      date: '2026-06-01',
      travelers: 1,
      originCountry: 'DE',
      destinationCountry: 'DE',
    });

    expect(offers).toHaveLength(1);
    expect(offers[0].price).toBe(49.9);
    expect(offers[0].operator).toBe('Deutsche Bahn');
    expect(offers[0].trainType).toBe('ICE');
    expect(offers[0].durationMinutes).toBe(240);
    expect(offers[0].limitedCoverage).toBe(false);
  });

  it('sets limitedCoverage for non-DE/AT/CH cities', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ id: '1' }]) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ id: '2' }]) })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            journeys: [
              {
                legs: [{ departure: '2026-06-01T10:00:00Z', arrival: '2026-06-01T16:00:00Z', line: {} }],
              },
            ],
          }),
      });

    const offers = await searchTrains({
      origin: 'Paris',
      destination: 'Barcelona',
      date: '2026-06-01',
      travelers: 1,
      originCountry: 'FR',
      destinationCountry: 'ES',
    });

    expect(offers).toHaveLength(1);
    expect(offers[0].limitedCoverage).toBe(true);
  });

  it('returns empty array on API failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const offers = await searchTrains({
      origin: 'Berlin',
      destination: 'Prague',
      date: '2026-06-01',
      travelers: 1,
    });

    expect(offers).toEqual([]);
  });
});
