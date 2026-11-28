/**
 * Rail quota: ranking searches each city pair's trains on ONE day, the
 * winner is re-priced on its real days, and the date-shift probe reuses the
 * winner's trains instead of searching ±1/±2 days.
 *
 * Why: All Aboard charges ~11 of its 500 hourly timetable units per new
 * route-and-day (repeats are free). A cold 3-city trip searched 18
 * route-days — 6 pairs on 2 days each for ranking, and 8 more for the probe —
 * ~95 units, a fifth of the hour, on a key production shares.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));

const upserts: any[] = [];
jest.mock('../services/supabase', () => {
  const createChain = (): any => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'order']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.upsert = jest.fn((rows: any) => {
      upserts.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve({ error: null });
    });
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

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn(),
}));

jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: jest.fn(),
}));

import { optimize } from '../services/optimizer';
import { compareLeg } from '../services/compareLeg';
import { searchFlights } from '../services/flights';
import { searchTrains } from '../services/trains';
import { searchHotels } from '../services/hotels';

const mockedFlights = searchFlights as jest.Mock;
const mockedTrains = searchTrains as jest.Mock;
const mockedHotels = searchHotels as jest.Mock;

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Train fare moves a little by day, so a mixed-up day would show in the total. */
const trainFare = (o: string, d: string, date: string) => 60 + (hash(`${o}${d}`) % 60) + (hash(date) % 5);

beforeEach(() => {
  jest.clearAllMocks();
  upserts.length = 0;
  mockedFlights.mockImplementation(async ({ origin, destination, date, travelers }: any) => [
    {
      id: `f-${origin}-${destination}-${date}`,
      price: (300 + (hash(`${origin}${destination}${date}`) % 200)) * travelers,
      durationMinutes: 90,
      carrier: 'Air',
      carrierCode: 'AA',
      departure: `${date}T08:00:00`,
      arrival: `${date}T10:00:00`,
      currency: 'USD',
      stops: 0,
      bookingUrl: '',
      raw: {},
    },
  ]);
  mockedTrains.mockImplementation(async ({ origin, destination, date, travelers }: any) => [
    {
      id: `t-${origin}-${destination}-${date}`,
      price: trainFare(origin, destination, date) * travelers,
      currency: 'USD',
      departure: `${date}T09:00:00`,
      arrival: `${date}T13:00:00`,
      durationMinutes: 240,
      operator: 'ÖBB',
      trainType: 'Railjet',
      bookingUrl: null,
      limitedCoverage: false,
    },
  ]);
  mockedHotels.mockImplementation(async ({ city, checkin, checkout }: any) => {
    const nights = Math.round((Date.parse(checkout) - Date.parse(checkin)) / 864e5);
    return [
      {
        id: `${city}-hotel`, name: `${city} Hotel`, price: 100 * nights, pricePerNight: 100, currency: 'USD',
        rating: 8.4, reviewCount: 900, stars: 3, thumbnail: '', bookingUrl: '', amenities: [],
      },
    ];
  });
});

const routeDays = () =>
  new Set(mockedTrains.mock.calls.map(([p]: any[]) => `${p.origin}>${p.destination}@${p.date}`));

describe('rail searches per trip', () => {
  it('3 cities: 6 pairs on one day plus the winner\'s later leg — no probe days', async () => {
    const result = await optimize({
      cities: [{ name: 'Vienna' }, { name: 'Munich' }, { name: 'Prague' }],
      startDate: '2030-02-09',
      travelers: 2,
      origin: 'Home',
      originAirports: ['HMA'],
      returnToHome: true,
      totalNights: 6,
    });

    // 2 nights each: legs leave on the 11th and the 13th.
    const days = routeDays();
    const ranking = [...days].filter((k) => k.endsWith('@2030-02-11'));
    expect(ranking).toHaveLength(6); // every ordered pair, once
    const other = [...days].filter((k) => !k.endsWith('@2030-02-11'));
    // Only the winner's second leg, on its own day. Before: 12 more.
    expect(other).toEqual([`${result.bestRoute.legs[1].from}>${result.bestRoute.legs[1].to}@2030-02-13`]);
    expect(result.dateShiftChecked).toBe(true);
  });

  it('the winner shows each leg\'s train on that leg\'s own day, at that day\'s fare', async () => {
    const result = await optimize({
      cities: [{ name: 'Vienna' }, { name: 'Munich' }, { name: 'Prague' }],
      startDate: '2030-02-09',
      travelers: 2,
      origin: 'Home',
      originAirports: ['HMA'],
      returnToHome: true,
      totalNights: 6,
    });
    const legs = result.bestRoute.legs;
    expect(legs.map((l) => l.comparison.trainOption?.departure.slice(0, 10))).toEqual(['2030-02-11', '2030-02-13']);
    for (const [i, leg] of legs.entries()) {
      const day = ['2030-02-11', '2030-02-13'][i];
      expect(leg.comparison.trainOption?.price).toBe(trainFare(leg.from, leg.to, day) * 2);
      expect(leg.cost).toBe(trainFare(leg.from, leg.to, day) * 2); // train beats the $600+ flight
    }
    // The total carries the real-day fares: legs + the two home flights.
    const legsTotal = legs.reduce((s, l) => s + l.cost, 0);
    const home = (result.outboundLeg?.price ?? 0) + (result.returnLeg?.price ?? 0);
    expect(result.bestRoute.totalCost).toBeCloseTo(legsTotal + home, 2);
  });
});

describe('real-day re-price that fails', () => {
  it('keeps the ranking-day train instead of turning the leg into a gap', async () => {
    // Only trains exist (flights return nothing); the real-day search for the
    // second leg fails, the way a hit quota or a timeout does.
    mockedFlights.mockImplementation(async ({ origin }: any) =>
      origin.startsWith('HM') || !['VIE', 'MUN', 'PRA'].includes(origin) ? [
        { id: 'h', price: 500, durationMinutes: 500, carrier: 'Air', carrierCode: 'AA', departure: '2030-02-09T08:00:00',
          arrival: '2030-02-09T20:00:00', currency: 'USD', stops: 0, bookingUrl: '', raw: {} },
      ] : [],
    );
    const base = mockedTrains.getMockImplementation()!;
    mockedTrains.mockImplementation(async (p: any) => (p.date === '2030-02-13' ? Promise.reject(new Error('quota')) : base(p)));
    const result = await optimize({
      cities: [{ name: 'Vienna' }, { name: 'Munich' }, { name: 'Prague' }],
      startDate: '2030-02-09',
      travelers: 2,
      origin: 'Home',
      originAirports: ['HMA'],
      returnToHome: true,
      totalNights: 6,
    });
    const legs = result.bestRoute.legs;
    expect(legs.every((l) => Number.isFinite(l.cost))).toBe(true);
    expect(legs[1].comparison.trainOption?.departure.startsWith('2030-02-11')).toBe(true);
  });
});

describe('compareLeg trainDate', () => {
  const params = { origin: 'Vienna', destination: 'Munich', date: '2030-02-13', travelers: 2 };

  it('searches trains on the given day and does not cache them as the leg\'s own day', async () => {
    const r = await compareLeg(params, { trainDate: '2030-02-11' });
    expect(mockedTrains).toHaveBeenCalledWith(expect.objectContaining({ date: '2030-02-11' }));
    expect(mockedFlights).toHaveBeenCalledWith(expect.objectContaining({ date: '2030-02-13' }));
    expect(r.trainOption?.departure.startsWith('2030-02-11')).toBe(true);
    expect(upserts.filter((row) => row.mode === 'train')).toHaveLength(0);
    expect(upserts.filter((row) => row.mode === 'flight')).toHaveLength(1);
  });

  it('on the leg\'s own day it caches the train as before', async () => {
    await compareLeg(params, { trainDate: '2030-02-13' });
    expect(upserts.filter((row) => row.mode === 'train' && row.travel_date === '2030-02-13')).toHaveLength(1);
  });
});
