/**
 * searchTrains: the one place rail fares become party totals.
 *
 * All Aboard is the only provider. Deutsche Bahn's community REST API
 * (db.transport.rest) was removed in 2026-11 after it failed every search on
 * production for weeks; these tests used to drive the per-person → party
 * scaling through it, and now drive it through All Aboard's provider shape.
 *
 * Every provider quotes ONE adult, and the API and the frontend speak party
 * totals (Duffel's total_amount covers the whole passenger set; the
 * per-person toggle divides by travelers). Before searchTrains scaled, a rail
 * leg rendered at 1/N of its real cost in 'total' mode and 1/N² in
 * 'perPerson' mode, and the optimizer preferred trains that weren't cheaper.
 */

const env: Record<string, string | undefined> = {
  ALLABOARD_API_KEY: 'k_test_key',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test_key',
};
jest.mock('../config/env', () => ({ env }));

jest.mock('../services/allaboard', () => ({
  searchAllAboardDetailed: jest.fn(),
}));

// Nothing here may reach a network: All Aboard is mocked, and no other
// provider exists any more.
const mockFetch = jest.fn(() => Promise.reject(new Error('no network in this test')));
global.fetch = mockFetch as any;

import { searchTrains, clearTrainSearchCache } from '../services/trains';
import { searchAllAboardDetailed } from '../services/allaboard';

const mockedAllAboard = searchAllAboardDetailed as jest.Mock;

/** One €49.90 Frankfurt → Munich ICE, per adult, the way allaboard.ts hands it over. */
const ice = (pricePerPerson: number | null) => ({
  id: 'aa-ice-1',
  pricePerPerson,
  currency: 'USD',
  departure: '2026-06-01T08:00:00+02:00',
  arrival: '2026-06-01T12:00:00+02:00',
  durationMinutes: 240,
  operator: 'DB Fernverkehr',
  trainType: 'ICE',
  bookingUrl: null,
  limitedCoverage: pricePerPerson == null,
  ...(pricePerPerson == null ? {} : { priceSource: { kind: 'live', provider: 'All Aboard', testApi: true } }),
});

const frankfurtMunich = (travelers: number) => ({
  origin: 'Frankfurt',
  destination: 'Munich',
  date: '2026-06-01',
  travelers,
  originCountry: 'DE',
  destinationCountry: 'DE',
});

beforeEach(() => {
  jest.clearAllMocks();
  clearTrainSearchCache();
  env.ALLABOARD_API_KEY = 'k_test_key';
});

describe('searchTrains', () => {
  it('scales the provider per-person fare to a party total', async () => {
    mockedAllAboard.mockResolvedValue({ offers: [ice(49.9)], complete: true });
    const offers = await searchTrains(frankfurtMunich(3));
    expect(offers).toHaveLength(1);
    expect(offers[0].price).toBe(149.7); // 49.90 per adult × 3
  });

  it('keeps the provider’s price source', async () => {
    mockedAllAboard.mockResolvedValue({ offers: [ice(49.9)], complete: true });
    const offers = await searchTrains(frankfurtMunich(7));
    expect(offers[0].priceSource).toEqual({ kind: 'live', provider: 'All Aboard', testApi: true });
  });

  it('does not expose the provider per-person field to callers', async () => {
    mockedAllAboard.mockResolvedValue({ offers: [ice(49.9)], complete: true });
    const offers = await searchTrains(frankfurtMunich(2));
    expect(offers[0].price).toBe(99.8);
    expect(offers[0]).not.toHaveProperty('pricePerPerson');
  });

  it('leaves an unpriced journey null instead of multiplying it to $0', async () => {
    mockedAllAboard.mockResolvedValue({ offers: [ice(null)], complete: true });
    const offers = await searchTrains(frankfurtMunich(4));
    expect(offers[0].price).toBeNull();
    expect(offers[0].priceSource).toBeUndefined();
    expect(offers[0].limitedCoverage).toBe(true);
  });

  it('falls back to a party of one when travelers is zero', async () => {
    // A zero/NaN count would otherwise zero out every fare, and a $0 leg
    // reads as a free train rather than a data gap.
    mockedAllAboard.mockResolvedValue({ offers: [ice(49.9)], complete: true });
    const offers = await searchTrains(frankfurtMunich(0));
    expect(offers[0].price).toBe(49.9);
  });

  it('returns no trains when the provider fails, instead of failing the leg', async () => {
    mockedAllAboard.mockRejectedValue(new Error('gateway down'));
    await expect(searchTrains(frankfurtMunich(2))).resolves.toEqual([]);
  });

  it('asks All Aboard only: no other rail service is called', async () => {
    mockedAllAboard.mockResolvedValue({ offers: [ice(49.9)], complete: true });
    await searchTrains(frankfurtMunich(2));
    expect(mockedAllAboard).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('without an All Aboard key there is no rail search at all', async () => {
    env.ALLABOARD_API_KEY = undefined;
    await expect(searchTrains(frankfurtMunich(2))).resolves.toEqual([]);
    expect(mockedAllAboard).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
