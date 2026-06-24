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

// Stub currency conversion so EUR test prices stay deterministic — the real
// `convertToUsd` hits a live FX endpoint, which would make assertions
// flap with whatever the day's exchange rate is.
jest.mock('../services/currency', () => ({
  convertToUsd: jest.fn(async (amount: number) => amount),
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
                    // Origin/destination station names so the new
                    // station-vs-city sanity filter (added to drop bogus
                    // out-of-coverage results like Reykjavik→Faroe) doesn't
                    // reject this perfectly valid mock journey.
                    origin: { name: 'Frankfurt(Main)Hbf' },
                    destination: { name: 'Munich Hbf' },
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

  it('sets limitedCoverage when the journey has no fare data', async () => {
    // limitedCoverage is now derived from REAL data, not a hardcoded country
    // list: a journey the provider returns *without a price* can't be
    // price-compared against flights, so it's flagged limited. The mock below
    // returns a journey with no `price` field. (Cities are arbitrary — the
    // station names just need to pass the station-matches-city filter.)
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ id: '1' }]) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ id: '2' }]) })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            journeys: [
              {
                legs: [
                  {
                    departure: '2026-06-01T10:00:00Z',
                    arrival: '2026-06-01T16:00:00Z',
                    origin: { name: 'Berlin Hbf' },
                    destination: { name: 'Tokyo Station' },
                    line: {},
                  },
                ],
              },
            ],
          }),
      });

    const offers = await searchTrains({
      origin: 'Berlin',
      destination: 'Tokyo',
      date: '2026-06-01',
      travelers: 1,
      originCountry: 'DE',
      destinationCountry: 'JP',
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

  it('drops journeys whose actual stations are not the requested cities', async () => {
    // Reproduces the Reykjavik → Faroe Islands case: DB REST has no real
    // coverage for the route, but happily returns a journey between two
    // unrelated stations near the resolved stop IDs. Without the
    // station-matches-city filter that bogus journey rendered as a "$21
    // train" on the trip card. With the filter, it gets dropped and the
    // result is empty (which surfaces as the "no transport" UI fallback).
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ id: 'rkv' }]) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve([{ id: 'fae' }]) })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            journeys: [
              {
                legs: [
                  {
                    departure: '2026-06-01T08:00:00Z',
                    arrival: '2026-06-01T11:00:00Z',
                    // Stations from a totally unrelated continental Europe
                    // route — exactly the failure mode this filter exists
                    // to catch.
                    origin: { name: 'Hannover Hbf' },
                    destination: { name: 'Hamburg Hbf' },
                    line: { operator: { name: 'Deutsche Bahn' }, productName: 'ICE' },
                  },
                ],
                price: { amount: '21.06', currency: 'EUR' },
              },
            ],
          }),
      });

    const offers = await searchTrains({
      origin: 'Reykjavik',
      destination: 'Torshavn',
      date: '2026-06-01',
      travelers: 1,
    });

    expect(offers).toEqual([]);
  });
});
