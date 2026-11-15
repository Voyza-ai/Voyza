/** Live optimize progress (services/optimizeProgress.ts) and the counts optimize() reports into it. */

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

import { optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';
import { searchHotels } from '../services/hotels';
import { startProgress, readProgress, _resetProgress, type OptimizeProgress } from '../services/optimizeProgress';

const mockedFlights = searchFlights as jest.Mock;
const mockedHotels = searchHotels as jest.Mock;


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


const TRIP = {
  cities: [{ name: 'London' }, { name: 'Paris' }, { name: 'Zurich' }],
  startDate: '2030-01-10',
  travelers: 2,
  origin: 'Home',
  originAirports: ['HMA', 'HMB'],
  returnToHome: true,
  totalNights: 7,
};

const flightKey = (p: any) => [p.origin, p.destination, p.date, p.travelers, p.cabinClass ?? 'economy'].join('|');

describe('optimize progress reporting', () => {
  beforeEach(() => _resetProgress());

  it('reports real counts, in stage order, and changes nothing about the result', async () => {
    const seen: Array<Partial<OptimizeProgress>> = [];
    const sink = startProgress('test-run-1');
    const withProgress = await optimize({
      ...TRIP,
      cities: [...TRIP.cities],
      onProgress: (patch) => {
        seen.push(patch);
        sink(patch);
      },
    });
    const flightCalls = new Set(mockedFlights.mock.calls.map(([p]: any[]) => flightKey(p)));

    jest.clearAllMocks();
    const without = await optimize({ ...TRIP, cities: [...TRIP.cities] });
    expect(JSON.parse(JSON.stringify(withProgress))).toEqual(JSON.parse(JSON.stringify(without)));

    const stages = seen.filter((p) => p.stage).map((p) => p.stage);
    expect(stages).toEqual(['routes', 'finishing']);
    // 3 cities with a home: every order of the three is priced.
    expect(seen.find((p) => p.stage === 'routes')?.orderings).toBe(6);
    expect(seen.find((p) => p.stage === 'finishing')?.bestOrder).toEqual(withProgress.bestRoute.ordering);

    const final = readProgress('test-run-1')!;
    // A comparison is a pair ON a day: each of the 6 directed pairs can be the
    // first or the second leg of an order, on different days — 12 in all.
    expect(final.legsAsked).toBe(12);
    expect(final.legsPriced).toBe(final.legsAsked);
    // Counted where the run dedupes its searches: never more than were sent.
    expect(final.flightSearches).toBeGreaterThan(0);
    expect(final.flightSearches).toBeLessThanOrEqual(flightCalls.size);
    // Priced never runs ahead of asked.
    let asked = 0;
    for (const p of seen) {
      if (p.legsAsked !== undefined) asked = p.legsAsked;
      if (p.legsPriced !== undefined) expect(p.legsPriced).toBeLessThanOrEqual(asked);
    }
  }, 60000);
});

describe('progress store', () => {
  beforeEach(() => _resetProgress());

  it('starts at the airports stage with zero counts and merges patches', () => {
    let t = 1000;
    const sink = startProgress('abcdefgh', () => t);
    expect(readProgress('abcdefgh', t)).toMatchObject({ stage: 'airports', legsAsked: 0, legsPriced: 0 });
    t = 2000;
    sink({ stage: 'routes', orderings: 6 });
    sink({ legsAsked: 3 });
    expect(readProgress('abcdefgh', t)).toMatchObject({ stage: 'routes', orderings: 6, legsAsked: 3, updatedAt: 2000 });
  });

  it('forgets a run after the TTL and ignores unknown ids', () => {
    let t = 0;
    startProgress('abcdefgh', () => t);
    expect(readProgress('zzzzzzzz', 0)).toBeNull();
    expect(readProgress('abcdefgh', 10 * 60_000 + 1)).toBeNull();
  });
});
