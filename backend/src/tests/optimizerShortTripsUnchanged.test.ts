/**
 * 1-3 city trips are exactly what they were before the date-shift deadline:
 * the same Duffel searches, the same hotel searches and the same result,
 * field for field, as the optimizer at 7683057 gave for the same fares.
 *
 * fixtures/optimizer-short-trips-7683057.json was recorded by running this
 * file against that commit's optimizer.ts with RECORD_SHORT_TRIPS=1. The
 * fares vary by route and by date (±30%) and the trip has two home
 * airports, so the ordering, the airport choice, savingsVsNaive and the
 * date-shift probe (and its hotel check) all have something to decide.
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

// IATA = first three letters, upper-cased ("Paris" → PAR).
jest.mock('../services/flights', () => ({
  getIataCode: jest.fn(async (name: string) => name.slice(0, 3).toUpperCase()),
  searchFlights: jest.fn(),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: jest.fn(),
}));

import * as fs from 'fs';
import * as path from 'path';
import { optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';
import { searchHotels } from '../services/hotels';

const mockedFlights = searchFlights as jest.Mock;
const mockedHotels = searchHotels as jest.Mock;

const FIXTURE = path.join(__dirname, 'fixtures', 'optimizer-short-trips-7683057.json');

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

/** A route's base fare, moved ±30% by the date. Party total, in USD. */
function fare(origin: string, destination: string, date: string, travelers: number): number {
  const base = 100 + (hash(`${origin}${destination}`) % 400);
  const swing = ((hash(`${origin}${destination}${date}`) % 61) - 30) / 100;
  return Math.round(base * (1 + swing) * travelers * 100) / 100;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedFlights.mockImplementation(async ({ origin, destination, date, travelers }: any) =>
    [0, 1].map((i) => ({
      id: `f-${origin}-${destination}-${date}-${i}`,
      price: fare(origin, destination, date, travelers) + 40 * i,
      durationMinutes: 90 + (hash(origin + destination) % 400),
      carrier: `Air ${i}`,
      carrierCode: `A${i}`,
      departure: `${date}T0${8 + i}:00:00`,
      // Outbound home flights land the next morning: the first stay starts then.
      arrival: origin.startsWith('HM') ? `${nextDay(date)}T07:00:00` : `${date}T21:00:00`,
      currency: 'USD',
      stops: i,
      bookingUrl: `https://example.test/${origin}-${destination}-${date}`,
      raw: {},
    })),
  );
  mockedHotels.mockImplementation(async ({ city, checkin, checkout }: any) => {
    const nights = Math.round((Date.parse(checkout) - Date.parse(checkin)) / 864e5);
    const perNight = 80 + (hash(`${city}${checkin}`) % 120);
    return [
      {
        id: `${city}-hotel`,
        name: `${city} Hotel`,
        price: perNight * nights,
        pricePerNight: perNight,
        currency: 'USD',
        rating: 8.4,
        reviewCount: 900,
        stars: 3,
        thumbnail: '',
        bookingUrl: '',
        amenities: [],
      },
    ];
  });
});

const TRIPS = {
  one: { cities: [{ name: 'Lisbon' }], totalNights: 5, travelers: 2 },
  two: { cities: [{ name: 'Amsterdam' }, { name: 'Paris' }], totalNights: 6, travelers: 2 },
  three: { cities: [{ name: 'London' }, { name: 'Paris' }, { name: 'Zurich' }], totalNights: 7, travelers: 6 },
} as const;

async function run(trip: (typeof TRIPS)[keyof typeof TRIPS]) {
  const result = await optimize({
    cities: [...trip.cities],
    startDate: '2030-01-10',
    travelers: trip.travelers,
    origin: 'Home',
    originAirports: ['HMA', 'HMB'],
    returnToHome: true,
    totalNights: trip.totalNights,
  });
  return {
    flights: mockedFlights.mock.calls.map(([p]: any[]) => `${p.origin}>${p.destination}@${p.date}#${p.travelers}`).sort(),
    hotels: mockedHotels.mock.calls.map(([p]: any[]) => `${p.city}@${p.checkin}..${p.checkout}#${p.adults}`).sort(),
    result: JSON.parse(JSON.stringify(result)),
  };
}

describe('1-3 city trips: same searches, same result as before the probe deadline', () => {
  const recorded: Record<string, unknown> = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) : {};
  const fresh: Record<string, unknown> = {};

  afterAll(() => {
    if (process.env.RECORD_SHORT_TRIPS) fs.writeFileSync(FIXTURE, `${JSON.stringify(fresh, null, 2)}\n`);
  });

  for (const name of Object.keys(TRIPS) as Array<keyof typeof TRIPS>) {
    it(`${TRIPS[name].cities.length} city`, async () => {
      fresh[name] = await run(TRIPS[name]);
      if (process.env.RECORD_SHORT_TRIPS) return;
      expect(fresh[name]).toEqual(recorded[name]);
    }, 60000);
  }
});
