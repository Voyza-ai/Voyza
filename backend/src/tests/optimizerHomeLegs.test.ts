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
    const methods = ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'upsert', 'order'];
    for (const m of methods) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.limit = jest.fn().mockReturnValue(chain);
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return {
    getSupabase: () => ({
      from: () => createChain(),
    }),
  };
});

// IATA = first three letters, upper-cased ("Alpha" → ALP, "Home" → HOM), so
// each test can key its flight prices off a readable route.
jest.mock('../services/flights', () => ({
  getIataCode: jest.fn(async (name: string) => name.slice(0, 3).toUpperCase()),
  searchFlights: jest.fn(),
}));

jest.mock('../services/trains', () => ({
  searchTrains: jest.fn().mockResolvedValue([
    {
      id: 't1',
      price: 50,
      durationMinutes: 240,
      operator: 'Test Rail',
      trainType: 'IC',
      departure: '',
      arrival: '',
      currency: 'EUR',
      bookingUrl: '',
      limitedCoverage: false,
    },
  ]),
}));

import { optimize } from '../services/optimizer';
import { searchFlights } from '../services/flights';

const mockedSearchFlights = searchFlights as jest.Mock;

const offer = (price: number) => ({
  id: `f-${price}`,
  price,
  durationMinutes: 120,
  carrier: 'Test Air',
  carrierCode: 'TA',
  departure: '',
  arrival: '',
  currency: 'USD',
  stops: 0,
  bookingUrl: '',
  raw: {},
});

/** Price every route at $100 except the overrides ("HOM>ALP": 500 or null = no offers). */
function priceRoutes(overrides: Record<string, number | null>) {
  mockedSearchFlights.mockImplementation(async ({ origin, destination }: any) => {
    const key = `${origin}>${destination}`;
    if (key in overrides) {
      const p = overrides[key];
      return p === null ? [] : [offer(p)];
    }
    return [offer(100)];
  });
}

describe('optimize — home legs and savings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not let an ordering with a missing outbound flight win', async () => {
    // HOM → NOW has no offers at all. The ordering that starts in Nowhere
    // used to score its outbound as $0 and win on price.
    priceRoutes({ 'HOM>NOW': null });

    const result = await optimize({
      cities: [{ name: 'Rome' }, { name: 'Nowhere' }],
      startDate: '2030-06-01',
      travelers: 1,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: false,
    });

    expect(result.bestRoute.ordering[0]).toBe('Rome');
    // Real money only: $100 outbound + $50 train leg. No penalty leaks in.
    expect(result.bestRoute.totalCost).toBe(150);
    expect(result.outboundLeg).not.toBeNull();
  }, 30000);

  it('computes savingsVsNaive on the same basis as the best route (home legs included)', async () => {
    // Flying into Alpha first costs $500; into Bravo first $100. Everything
    // else is $100 (flight) / $50 (train).
    priceRoutes({ 'HOM>ALP': 500 });

    const result = await optimize({
      cities: [{ name: 'Alpha' }, { name: 'Bravo' }],
      startDate: '2030-06-01',
      travelers: 1,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: true,
    });

    // best  = HOM→BRA 100 + BRA→ALP 50 + ALP→HOM 100 = 250
    // naive = HOM→ALP 500 + ALP→BRA 50 + BRA→HOM 100 = 650
    expect(result.bestRoute.ordering).toEqual(['Bravo', 'Alpha']);
    expect(result.bestRoute.totalCost).toBe(250);
    expect(result.savingsVsNaive).toBe(400);
  }, 30000);

  it('does not promise a date-shift saving when shifting changes nothing', async () => {
    // Prices are date-independent in this mock, so no offset can save money.
    // The old probe compared a home-legs-included baseline against a
    // legs-only re-score and reported the airfare as "savings".
    priceRoutes({});

    const result = await optimize({
      cities: [{ name: 'Alpha' }, { name: 'Bravo' }],
      startDate: '2030-06-01',
      travelers: 1,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: true,
    });

    expect(result.dateShiftSuggestion).toBeUndefined();
  }, 30000);

  it('prices HOME flights at shifted dates and suggests a real saving', async () => {
    // The outbound home flight is $600 on the requested date (June 10) but
    // $300 if the trip starts 2 days earlier (June 8). Everything else is
    // date-independent at $100/$50. A legs-only probe can't see this at
    // all; the whole-trip probe must report the $300 the user actually saves.
    mockedSearchFlights.mockImplementation(async ({ origin, destination, date }: any) => {
      if (origin === 'HOM' && destination === 'ALP') {
        return [offer(date === '2030-06-08' ? 300 : 600)];
      }
      return [offer(100)];
    });

    const result = await optimize({
      cities: [{ name: 'Alpha' }],
      startDate: '2030-06-10',
      travelers: 1,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: true,
      totalNights: 3,
    });

    const s = result.dateShiftSuggestion;
    expect(s).toBeDefined();
    expect(s!.dayOffset).toBe(-2);
    expect(s!.newStartDate).toBe('2030-06-08');
    // Whole trip: (600 out + 100 back) → (300 out + 100 back) = $300 saved.
    expect(s!.savings).toBe(300);
    expect(s!.newTotalCost).toBe(400);
  }, 30000);

  it('never offers a date whose home flight cannot be priced', async () => {
    // Cheaper on June 8 for the outbound… but no return flight exists for
    // that shifted trip. An unpriced flight must not read as a saving.
    mockedSearchFlights.mockImplementation(async ({ origin, destination, date }: any) => {
      if (origin === 'HOM' && destination === 'ALP') return [offer(date === '2030-06-08' ? 50 : 600)];
      if (origin === 'ALP' && destination === 'HOM' && date === '2030-06-11') return [];
      return [offer(100)];
    });

    const result = await optimize({
      cities: [{ name: 'Alpha' }],
      startDate: '2030-06-10',
      travelers: 1,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: true,
      totalNights: 3,
    });

    expect(result.dateShiftSuggestion?.newStartDate).not.toBe('2030-06-08');
  }, 30000);

  it('keeps same-country cities contiguous for trips too large to permute', async () => {
    priceRoutes({});

    const result = await optimize({
      cities: [
        { name: 'Tokyo' },
        { name: 'Beijing' },
        { name: 'Osaka' },
        { name: 'Shanghai' },
        { name: 'Kyoto' },
        { name: 'Chengdu' },
      ],
      startDate: '2030-06-01',
      travelers: 1,
    });

    const JP = new Set(['Tokyo', 'Osaka', 'Kyoto']);
    for (const route of result.routes) {
      expect(route.ordering).toHaveLength(6);
      // Once we leave a country we must never come back to it.
      const countries = route.ordering.map((c) => (JP.has(c) ? 'JP' : 'CN'));
      const switches = countries.filter((c, i) => i > 0 && c !== countries[i - 1]).length;
      expect(switches).toBe(1);
    }
  }, 60000);

  it('caps the home-leg fan-out at three origin airports', async () => {
    priceRoutes({});

    await optimize({
      cities: [{ name: 'Alpha' }],
      startDate: '2030-06-01',
      travelers: 1,
      origin: 'Home',
      originAirports: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'],
      returnToHome: true,
    });

    const homeAirportsSearched = new Set<string>();
    for (const [params] of mockedSearchFlights.mock.calls) {
      if (params.destination === 'ALP') homeAirportsSearched.add(params.origin);
      if (params.origin === 'ALP') homeAirportsSearched.add(params.destination);
    }
    expect(homeAirportsSearched.has('DDD')).toBe(false);
    expect(homeAirportsSearched.has('EEE')).toBe(false);
    expect(homeAirportsSearched.size).toBeLessThanOrEqual(3);
  }, 30000);
});
