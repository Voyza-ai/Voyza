/**
 * Per-city nights (website audit m11): "Plan a similar trip" on a preset
 * that says Lisbon 3 nights + Sintra 1 came back as 2 + 2, because the
 * optimizer only took a total and spread it evenly by position. With
 * `cityNights` each city keeps its own nights wherever the optimizer puts
 * it; without it, nothing changes.
 *
 * Duffel, Supabase and rail are mocked; nothing here touches the network.
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

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([]),
}));

import { cityNightsByName, optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';

const mockedSearchFlights = searchFlights as jest.Mock;

/** A same-day flight on `date` (local wall clock, as Duffel gives it). */
const offer = (price: number, date: string) => ({
  id: `f-${price}-${date}`,
  price,
  durationMinutes: 120,
  carrier: 'Test Air',
  carrierCode: 'TA',
  departure: `${date}T09:00:00`,
  arrival: `${date}T11:00:00`,
  currency: 'USD',
  stops: 0,
  bookingUrl: '',
  raw: {},
});

/**
 * Home → Rome is cheap and home → Paris dear, so the optimizer puts Rome
 * first even though Paris was typed first. Every other flight is $100.
 */
function romeFirstFares() {
  mockedSearchFlights.mockImplementation(async ({ origin, destination, date }: any) => {
    if (origin === 'HOM' && destination === 'PAR') return [offer(900, date)];
    if (origin === 'HOM' && destination === 'ROM') return [offer(200, date)];
    return [offer(100, date)];
  });
}

const trip = (extra: Record<string, unknown> = {}) => ({
  cities: [{ name: 'Paris' }, { name: 'Rome' }],
  startDate: '2030-12-08',
  travelers: 2,
  origin: 'New York',
  originAirports: ['HOM'],
  returnToHome: true,
  totalNights: 4,
  ...extra,
});

/** The dates the inter-city leg (Rome → Paris) was searched on. */
const legSearchDates = () =>
  mockedSearchFlights.mock.calls
    .map(([p]: any[]) => p)
    .filter((p: any) => p.origin === 'ROM' && p.destination === 'PAR')
    .map((p: any) => p.date);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('optimize() with cityNights', () => {
  it('keeps each city its own nights after reordering (Paris 1, Rome 3 → Rome first, 3 then 1)', async () => {
    romeFirstFares();
    const result = await optimize(trip({ cityNights: { Paris: 1, Rome: 3 } }));
    expect(result.bestRoute.ordering).toEqual(['Rome', 'Paris']);
    expect(result.dates.Rome).toEqual({ arrival: '2030-12-08', departure: '2030-12-11' });
    expect(result.dates.Paris).toEqual({ arrival: '2030-12-11', departure: '2030-12-12' });
  }, 30000);

  it('searches the winner’s leg on the day it is taken (Dec 11, after Rome’s 3 nights)', async () => {
    romeFirstFares();
    await optimize(trip({ cityNights: { Paris: 1, Rome: 3 } }));
    expect(legSearchDates()).toContain('2030-12-11');
  }, 30000);

  it('flies home after the whole stay, as before', async () => {
    romeFirstFares();
    const result = await optimize(trip({ cityNights: { Paris: 1, Rome: 3 } }));
    expect(result.returnLeg?.departDate).toBe('2030-12-12');
  }, 30000);

  it('matches city names however they are cased or spaced', async () => {
    romeFirstFares();
    const result = await optimize(trip({ cityNights: { ' paris ': 1, ROME: 3 } }));
    expect(result.dates.Rome).toEqual({ arrival: '2030-12-08', departure: '2030-12-11' });
  }, 30000);

  it.each([
    ['a city missing', { Rome: 3 }],
    ['a total that disagrees with totalNights', { Paris: 1, Rome: 2 }],
  ])('is ignored with %s: nights are spread evenly, as without it', async (_why, cityNights) => {
    romeFirstFares();
    const result = await optimize(trip({ cityNights }));
    expect(result.dates.Rome).toEqual({ arrival: '2030-12-08', departure: '2030-12-10' });
    expect(result.dates.Paris).toEqual({ arrival: '2030-12-10', departure: '2030-12-12' });
  }, 30000);

  it('without it, plans exactly as before (even split, extra night up front)', async () => {
    romeFirstFares();
    const result = await optimize(trip({ totalNights: 5 }));
    expect(result.dates.Rome).toEqual({ arrival: '2030-12-08', departure: '2030-12-11' });
    expect(result.dates.Paris).toEqual({ arrival: '2030-12-11', departure: '2030-12-13' });
  }, 30000);
});

describe('cityNightsByName', () => {
  const cities = [{ name: 'Lisbon' }, { name: 'Sintra' }];

  it('keys a full split by trimmed, lower-cased name', () => {
    expect(cityNightsByName({ Lisbon: 3, Sintra: 1 }, cities, 4)).toEqual(
      new Map([
        ['lisbon', 3],
        ['sintra', 1],
      ]),
    );
    expect(cityNightsByName({ Lisbon: 3, Sintra: 1 }, cities, undefined)?.size).toBe(2);
  });

  it.each([
    ['nothing given', undefined, 4],
    ['a zero', { Lisbon: 4, Sintra: 0 }, 4],
    ['a fraction', { Lisbon: 2.5, Sintra: 1.5 }, 4],
    ['an extra city', { Lisbon: 2, Sintra: 1, Porto: 1 }, 4],
    ['one city named twice', { Lisbon: 2, lisbon: 2 }, 4],
    ['a wrong total', { Lisbon: 3, Sintra: 1 }, 5],
  ])('is null for %s', (_why, given, total) => {
    expect(cityNightsByName(given as any, cities, total)).toBeNull();
  });
});
