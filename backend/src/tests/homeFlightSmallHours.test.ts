/**
 * Flights home and out are sorted cheapest first, but one leaving or landing
 * 00:00–04:59 goes after every priced one at sensible hours (longJourney.ts
 * small hours). Seen locally on 2026-11-24: Boston → Prague departing 11:36,
 * landing 01:31 the next day.
 */
jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

jest.mock('../services/supabase', () => {
  const createChain = (): any => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'upsert', 'order']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return { getSupabase: () => ({ from: () => createChain() }) };
});

jest.mock('../services/flights', () => ({
  getIataCode: jest.fn(async (name: string) => name.slice(0, 3).toUpperCase()),
  searchFlights: jest.fn(),
}));

jest.mock('../services/trains', () => ({ searchTrains: jest.fn().mockResolvedValue([]) }));

import { buildHomeLeg } from '../services/optimizer';
import { searchFlights } from '../services/flights';

const mocked = searchFlights as jest.Mock;
const offer = (price: number, departure: string, arrival: string) => ({
  id: `f-${price}-${departure}`, price, durationMinutes: 600, carrier: 'Test Air', carrierCode: 'TA',
  departure, arrival, currency: 'USD', stops: 0, bookingUrl: '', raw: {},
});

beforeEach(() => mocked.mockReset());

describe('home flights at sensible hours first', () => {
  it('Boston → Prague: the $520 flight landing 09:10 beats the $479 one landing 01:31', async () => {
    mocked.mockResolvedValue([
      offer(479, '2030-03-16T11:36:00', '2030-03-17T01:31:00'),
      offer(520, '2030-03-16T18:00:00', '2030-03-17T09:10:00'),
    ]);
    const leg = await buildHomeLeg({ originAirports: ['BOS'], destinationCity: 'Prague', date: '2030-03-16', travelers: 2 });
    expect(leg?.price).toBe(520);
    expect(leg?.arriveTime).toBe('09:10');
  });

  it('when every flight lands in the small hours, the cheapest is still picked', async () => {
    mocked.mockResolvedValue([
      offer(600, '2030-03-16T13:00:00', '2030-03-17T03:00:00'),
      offer(479, '2030-03-16T11:36:00', '2030-03-17T01:31:00'),
    ]);
    const leg = await buildHomeLeg({ originAirports: ['BOS'], destinationCity: 'Prague', date: '2030-03-16', travelers: 2 });
    expect(leg?.price).toBe(479);
  });

  it('ordinary hours: cheapest wins, unchanged', async () => {
    mocked.mockResolvedValue([
      offer(700, '2030-03-16T08:00:00', '2030-03-16T20:00:00'),
      offer(450, '2030-03-16T18:00:00', '2030-03-17T08:00:00'),
    ]);
    const leg = await buildHomeLeg({ originAirports: ['BOS'], destinationCity: 'Prague', date: '2030-03-16', travelers: 2 });
    expect(leg?.price).toBe(450);
  });
});
