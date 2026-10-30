jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));
jest.mock('../services/flights', () => ({
  getIataCode: jest.fn(async (name: string) => (name === 'Florence' ? 'FLR' : 'FCO')),
  searchFlights: jest.fn(async () => [
    {
      id: 'o1',
      price: 155,
      currency: 'USD',
      departure: '2027-03-15T19:00:00',
      arrival: '2027-03-15T19:55:00',
      durationMinutes: 55,
      stops: 0,
      carrier: 'ITA Airways',
      carrierCode: 'AZ',
      bookingUrl: '',
      raw: {},
    },
  ]),
}));
jest.mock('../services/trains', () => ({ searchTrains: jest.fn().mockResolvedValue([]) }));
// Not what this file is about, and it builds the whole location index.
jest.mock('../services/location/sameAirportArea', () => ({ sameAirportArea: () => false }));

import { searchLegOptions } from '../services/legOptions';
import { formatDurationMinutes } from '../utils/duration';

/**
 * Production, 2026-10-30, a cold Rome / Florence / Venice trip on
 * bluemurr.com: the Florence → Rome pill read "0h 55m". The optimizer's leg
 * options are worded by legOptions.ts, which printed every duration as
 * "Xh Ym" — the frontend and chat formatters were already fixed.
 */
describe('leg durations read the way people write them', () => {
  it('a 55-minute flight is "55m" on the option the trip shows', async () => {
    const { options } = await searchLegOptions({ from: 'Florence', to: 'Rome', date: '2027-03-15', travelers: 2 });
    expect(options[0].duration).toBe('55m');
  });

  it.each([
    [55, '55m'],
    [60, '1h'],
    [125, '2h 5m'],
    [645, '10h 45m'],
    [89.6, '1h 30m'],
    [0, ''],
    [-5, ''],
  ])('formatDurationMinutes(%p) → %p', (mins, text) => {
    expect(formatDurationMinutes(mins)).toBe(text);
  });
});
