/**
 * A search on a metro code (CHI, LON…) answers with flights from several
 * airports. The optimizer prices home flights that way and must still say
 * which airport the traveller leaves from — and drop the ones they did not
 * ask for (London's search includes City and Southend) — so every offer
 * carries the airports it really flies from and to.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));
jest.mock('../services/supabase', () => ({ getSupabase: () => ({ from: () => ({}) }) }));
jest.mock('../services/currency', () => ({ convertToUsd: async (amount: number) => amount }));
const mockCreate = jest.fn();
jest.mock('../services/duffel', () => ({ getDuffel: () => ({ offerRequests: { create: mockCreate } }) }));
// Not what this file is about, and it builds the whole location index.
jest.mock('../services/location/sameAirportArea', () => ({ sameAirportArea: () => false }));

import { searchFlights } from '../services/flights';

const segment = (from: string, to: string) => ({
  departing_at: '2030-05-04T09:00:00',
  arriving_at: '2030-05-04T23:10:00',
  duration: 'PT8H10M',
  origin: { iata_code: from, time_zone: 'America/Chicago' },
  destination: { iata_code: to, time_zone: 'Europe/Lisbon' },
  operating_carrier: { name: 'Test Air', iata_code: 'TA' },
});

const offer = (id: string, price: string, segments: any[]) => ({
  id,
  total_amount: price,
  total_currency: 'USD',
  slices: [{ duration: 'PT10H', segments }],
});

it('names the first departure and last arrival airport of each offer', async () => {
  mockCreate.mockResolvedValue({
    data: {
      offers: [
        offer('o1', '640.00', [segment('ORD', 'OPO')]),
        // A connection: leaves Midway, changes in Newark, lands in Porto.
        offer('o2', '610.00', [segment('MDW', 'EWR'), segment('EWR', 'OPO')]),
      ],
    },
  });

  const offers = await searchFlights({ origin: 'CHI', destination: 'OPO', date: '2030-05-04', travelers: 4 });

  expect(offers.map((o) => [o.id, o.originAirport, o.destinationAirport])).toEqual([
    ['o1', 'ORD', 'OPO'],
    ['o2', 'MDW', 'OPO'],
  ]);
});
