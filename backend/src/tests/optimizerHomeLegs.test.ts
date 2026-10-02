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
