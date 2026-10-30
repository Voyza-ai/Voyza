jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));
jest.mock('../services/supabase', () => ({ getSupabase: () => ({ from: () => ({}) }) }));
const mockSearched: string[] = [];
jest.mock('../services/flights', () => ({
  getIataCode: jest.fn(async () => 'FLR'),
  // Duffel's test mode prices a flight from ANY airport — here Hanscom is the
  // cheapest of Boston's three, as it was on production for a Boston trip.
  searchFlights: jest.fn(async ({ origin }: any) => {
    mockSearched.push(origin);
    const price = origin === 'BED' ? 300 : origin === 'PVD' ? 480 : 495;
    return [{ id: `o-${origin}`, price, currency: 'USD', departure: '2027-03-12T08:30:00', arrival: '2027-03-12T23:36:00', durationMinutes: 546, stops: 1, carrier: 'Test Air', carrierCode: 'TA', bookingUrl: '', raw: {} }];
  }),
}));
// Not what this file is about, and it builds the whole location index.
jest.mock('../services/location/sameAirportArea', () => ({ sameAirportArea: () => false }));

import { buildHomeLeg } from '../services/optimizer';

/**
 * Production, 2026-10-30, a cold Boston → Florence / Rome / Venice trip on
 * bluemurr.com: the home card read "Laurence G Hanscom Field (BED)". The
 * resolver lists Boston as BOS, PVD, BED; Hanscom is a general-aviation field
 * with no airline service, which OurAirports still flags as scheduled. Duffel's
 * test mode invents a fare from any airport, so it can win; a live key would
 * return nothing and just waste the search.
 */
describe('home flights are never searched from a field with no airline service', () => {
  beforeEach(() => (mockSearched.length = 0));

  it('Boston: BOS and PVD are searched, Hanscom is not, and the leg leaves from a real airport', async () => {
    const leg = await buildHomeLeg({ originAirports: ['BOS', 'PVD', 'BED'], destinationCity: 'Florence', date: '2027-03-12', travelers: 2 });
    expect(mockSearched.sort()).toEqual(['BOS', 'PVD']);
    expect(leg?.originAirport).toBe('PVD');
  });

  it('a list with nothing else in it keeps the field (better a search than none)', async () => {
    await buildHomeLeg({ originAirports: ['BED'], destinationCity: 'Florence', date: '2027-03-12', travelers: 2 });
    expect(mockSearched).toEqual(['BED']);
  });
});
