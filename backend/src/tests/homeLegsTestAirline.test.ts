/**
 * Duffel's test-mode airline ("Duffel Airways", ZZ) on home flights.
 *
 * flights.ts drops it from a search's results whenever a real airline is in
 * them. Home flights merge several searches — one per home airport — and in
 * test mode MDW is served only by the test airline, cheaper than ORD's real
 * fares: the merged list then led with it, and production's 5-city Chicago
 * plans showed "Duffel Airways" on both home flights (2026-10-30, 2026-11-02).
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
  const chain: any = {};
  for (const m of ['select', 'eq', 'gte', 'limit', 'insert', 'upsert', 'order']) chain[m] = jest.fn().mockReturnValue(chain);
  chain.single = jest.fn().mockResolvedValue({ data: null });
  chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
  return { getSupabase: () => ({ from: () => chain }) };
});
const codes: Record<string, string> = { Alpha: 'ZQA', Bravo: 'ZQB', Charlie: 'ZQC', Delta: 'ZQD', Chicago: 'CHI' };
jest.mock('../services/flights', () => {
  const actual = jest.requireActual('../services/flights');
  const { AppError } = jest.requireActual('../middleware/error');
  return {
    ...actual,
    getIataCode: jest.fn(async (name: string) => {
      if (!codes[name]) throw new AppError(404, `No IATA code found for "${name}"`);
      return codes[name];
    }),
    searchFlights: jest.fn(),
  };
});
jest.mock('../services/trains', () => ({ searchTrains: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/hotels', () => ({ ...jest.requireActual('../services/hotels'), searchHotels: jest.fn().mockResolvedValue([]) }));
// Not what this file is about, and each builds the whole location index.
jest.mock('../services/location/sameAirportArea', () => ({
  sameAirportArea: (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase(),
}));
jest.mock('../services/location/destinationAirport', () => ({ resolveDestinationIata: () => null }));
jest.mock('../services/location/originAirports', () => ({ resolveOriginAirports: () => ({ airports: [], placeId: null }) }));

import { optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';

const mocked = searchFlights as jest.Mock;

const offer = (origin: string, destination: string, date: string, price: number, carrier: string, carrierCode: string) => ({
  id: `${origin}-${destination}-${date}-${carrierCode}-${price}`,
  price,
  currency: 'USD',
  departure: `${date}T09:00:00`,
  arrival: `${date}T17:00:00`,
  durationMinutes: 480,
  stops: 0,
  carrier,
  carrierCode,
  bookingUrl: '',
  raw: {},
  originAirport: origin,
  destinationAirport: destination,
});
const real = (o: string, d: string, date: string, price: number) => offer(o, d, date, price, 'Iberia', 'IB');
const fake = (o: string, d: string, date: string, price: number) => offer(o, d, date, price, 'Duffel Airways', 'ZZ');

/**
 * Test mode as measured: ORD has real airlines; MDW only the test airline,
 * cheaper; a CHI search answers with test-airline placeholders under "CHI".
 * Every inter-city leg has a real flight.
 */
function testModeFares(onlyTestAirline = false) {
  mocked.mockImplementation(async ({ origin, destination, date }: any) => {
    const home = ['ORD', 'MDW', 'CHI'];
    if (!home.includes(origin) && !home.includes(destination)) return [real(origin, destination, date, 120)];
    const ap = home.includes(origin) ? origin : destination;
    if (ap === 'CHI') return [fake(origin, destination, date, 300)];
    if (ap === 'MDW' || onlyTestAirline) return [fake(origin, destination, date, 450), fake(origin, destination, date, 470)];
    return [real(origin, destination, date, 900), real(origin, destination, date, 950)];
  });
}

const plan = (cities: string[]) =>
  optimize({
    cities: cities.map((name) => ({ name })),
    startDate: '2030-05-04',
    travelers: 2,
    origin: 'Chicago',
    originAirports: ['ORD', 'MDW'],
    returnToHome: true,
    totalNights: cities.length * 3,
  });

const noTestAirline = (leg: any) => {
  expect(leg?.operator).not.toBe('Duffel Airways');
  for (const alt of leg?.alternatives ?? []) expect(alt.operator).not.toBe('Duffel Airways');
};

beforeEach(() => jest.clearAllMocks());

it('1-3 city trips: home flights use the real airline from ORD, not the cheaper test airline from MDW', async () => {
  testModeFares();
  const result = await plan(['Alpha', 'Bravo']);
  expect(result.outboundLeg).toMatchObject({ originAirport: 'ORD', operator: 'Iberia', price: 900 });
  expect(result.returnLeg).toMatchObject({ destAirport: 'ORD', operator: 'Iberia', price: 900 });
  noTestAirline(result.outboundLeg);
  noTestAirline(result.returnLeg);
}, 30000);

it('4-5 city trips: the same, through the metro search and its per-airport fallback', async () => {
  testModeFares();
  const result = await plan(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  expect(result.outboundLeg).toMatchObject({ originAirport: 'ORD', operator: 'Iberia', price: 900 });
  expect(result.returnLeg).toMatchObject({ destAirport: 'ORD', operator: 'Iberia', price: 900 });
  noTestAirline(result.outboundLeg);
  noTestAirline(result.returnLeg);
}, 30000);

it('kept when the test airline is all there is, so the home flight still has a price', async () => {
  testModeFares(true);
  const result = await plan(['Alpha', 'Bravo']);
  expect(result.outboundLeg).toMatchObject({ operator: 'Duffel Airways', price: 450 });
}, 30000);
