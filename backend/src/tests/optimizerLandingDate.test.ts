/**
 * B1 — the first stay starts on the day the outbound flight LANDS.
 *
 * Seen live (production, 2026-10-29): JFK 19:25 Dec 8 → Paris 12:00 Dec 9,
 * but Paris's arrival came back as Dec 8. PlanningChat checks hotels in on
 * `city.dates.arrival`, so a hotel night was booked on the plane ($362-405
 * on the owner's trip) and the schedule put a Paris lunch and evening on
 * Dec 8 while the traveller was at JFK. The optimizer kept only the TIME of
 * Duffel's `arriving_at` and set city 0's arrival to the trip start.
 *
 * Decided default: city 0 arrives on the landing date, the return date and
 * every priced leg date are unchanged, city 0 keeps at least one night.
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

import { optimize, buildHomeLeg } from '../services/optimizer';
import { searchFlights } from '../services/flights';

const mockedSearchFlights = searchFlights as jest.Mock;

/** Duffel-style local timestamps: no offset, wall clock at each airport. */
const offer = (price: number, departure: string, arrival: string) => ({
  id: `f-${price}-${departure}`,
  price,
  durationMinutes: 600,
  carrier: 'Test Air',
  carrierCode: 'TA',
  departure,
  arrival,
  currency: 'USD',
  stops: 0,
  bookingUrl: '',
  raw: {},
});

/**
 * HOM → PAR is whatever `outbound` says, HOM → ROM is $5000 (so Paris is
 * always first); every other route is a $100 same-day hop.
 */
function flightsWithOutbound(outbound: (date: string) => any[]) {
  mockedSearchFlights.mockImplementation(async ({ origin, destination, date }: any) => {
    if (origin === 'HOM' && destination === 'PAR') return outbound(date);
    if (origin === 'HOM' && destination === 'ROM') return [offer(5000, `${date}T09:00:00`, `${date}T19:00:00`)];
    return [offer(100, `${date}T09:00:00`, `${date}T11:00:00`)];
  });
}

const parisRome = (totalNights: number) => ({
  cities: [{ name: 'Paris' }, { name: 'Rome' }],
  startDate: '2030-12-08',
  travelers: 2,
  origin: 'New York',
  originAirports: ['HOM'],
  returnToHome: true,
  totalNights,
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('B1 — first city arrives on the landing date', () => {
  it('moves Paris to Dec 9 for an overnight flight; return date and Rome unchanged', async () => {
    flightsWithOutbound((date) => [offer(445.8, `${date}T19:25:00`, '2030-12-09T12:00:00')]);

    const result = await optimize(parisRome(7));

    expect(result.bestRoute.ordering).toEqual(['Paris', 'Rome']);
    expect(result.outboundLeg?.departDate).toBe('2030-12-08');
    expect(result.outboundLeg?.arriveDate).toBe('2030-12-09');
    // Before: Paris { arrival: 2030-12-08, departure: 2030-12-12 } — 4 hotel
    // nights, the first one on the plane.
    expect(result.dates.Paris).toEqual({ arrival: '2030-12-09', departure: '2030-12-12' });
    expect(result.dates.Rome).toEqual({ arrival: '2030-12-12', departure: '2030-12-15' });
    expect(result.returnLeg?.departDate).toBe('2030-12-15');
  }, 30000);

  it('leaves a same-day arrival exactly as before', async () => {
    flightsWithOutbound((date) => [offer(452.62, `${date}T05:25:00`, `${date}T19:46:00`)]);

    const result = await optimize(parisRome(7));

    expect(result.outboundLeg?.arriveDate).toBe('2030-12-08');
    expect(result.dates.Paris).toEqual({ arrival: '2030-12-08', departure: '2030-12-12' });
  }, 30000);

  it('handles a flight that lands two days later', async () => {
    flightsWithOutbound((date) => [offer(900, `${date}T23:00:00`, '2030-12-10T06:00:00')]);

    const result = await optimize(parisRome(7));

    expect(result.dates.Paris).toEqual({ arrival: '2030-12-10', departure: '2030-12-12' });
  }, 30000);

  it('keeps one night when the first city only had one (no 0-night stay)', async () => {
    // 2 nights over 2 cities = [1, 1]; landing on Paris's departure day
    // would leave it no night at all.
    flightsWithOutbound((date) => [offer(445.8, `${date}T19:25:00`, '2030-12-09T12:00:00')]);

    const result = await optimize(parisRome(2));

    expect(result.dates.Paris).toEqual({ arrival: '2030-12-08', departure: '2030-12-09' });
    expect(result.dates.Rome).toEqual({ arrival: '2030-12-09', departure: '2030-12-10' });
  }, 30000);

  it('changes nothing when Duffel gave no arrival timestamp', async () => {
    flightsWithOutbound(() => [offer(445.8, '', '')]);

    const result = await optimize(parisRome(7));

    expect(result.outboundLeg).not.toBeNull();
    expect(result.outboundLeg).not.toHaveProperty('arriveDate');
    expect(result.dates.Paris.arrival).toBe('2030-12-08');
  }, 30000);
});

describe('B1 — HomeLeg.arriveDate on /home-legs (presets) too', () => {
  it('sets arriveDate on the main leg and each alternative, from its own offer', async () => {
    mockedSearchFlights.mockResolvedValue([
      offer(445.8, '2030-12-08T19:25:00', '2030-12-09T12:00:00'),
      offer(452.62, '2030-12-08T05:25:00', '2030-12-08T19:46:00'),
    ]);

    const leg = await buildHomeLeg({
      originAirports: ['HOM'],
      destinationCity: 'Paris',
      date: '2030-12-08',
      travelers: 2,
    });

    expect(leg?.arriveDate).toBe('2030-12-09');
    expect(leg?.alternatives?.[0].arriveDate).toBe('2030-12-08');
    // Unchanged fields keep their old meaning.
    expect(leg?.departDate).toBe('2030-12-08');
    expect(leg?.arriveTime).toBe('12:00');
  });
});
