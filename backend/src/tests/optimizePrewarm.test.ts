/**
 * The planner's home-flight pre-search (prototype, exp/optimizer-speed):
 * prewarmHomeFlights asks, during the chat, exactly the home-flight searches
 * optimize() will make — same airports, city codes, dates and party — so
 * flights.ts' cache answers them when the plan runs.
 */

jest.mock('../config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'duffel_test_jest',
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

const mockCodes: Record<string, string> = {
  Alpha: 'ZQA',
  Bravo: 'ZQB',
  Charlie: 'ZQC',
  Delta: 'ZQD',
  Echo: 'ZQE',
  Chicago: 'CHI',
  'New York': 'NYC',
};
jest.mock('../services/flights', () => {
  const { AppError } = jest.requireActual('../middleware/error');
  return {
    getIataCode: jest.fn(async (name: string) => {
      const code = mockCodes[name];
      if (!code) throw new AppError(404, `No IATA code found for "${name}"`);
      return code;
    }),
    searchFlights: jest.fn(),
  };
});
jest.mock('../services/trains', () => ({ searchTrains: jest.fn().mockResolvedValue([]) }));
jest.mock('../services/hotels', () => ({
  ...jest.requireActual('../services/hotels'),
  searchHotels: jest.fn().mockResolvedValue([]),
}));
jest.mock('../services/location/sameAirportArea', () => ({
  sameAirportArea: (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase(),
}));
jest.mock('../services/location/destinationAirport', () => ({ resolveDestinationIata: () => null }));
jest.mock('../services/location/originAirports', () => ({
  resolveOriginAirports: () => ({ airports: [], placeId: null }),
}));
jest.mock('../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { optimize, prewarmHomeFlights, _resetPrewarm } from '../services/optimizer';
import { searchFlights } from '../services/flights';
import { createFareModel } from './helpers/fareModel';
import { addDays } from '../utils/dates';

const mockedSearch = searchFlights as jest.Mock;
type Search = { origin: string; destination: string; date: string; travelers: number };
let searched: Search[] = [];
const keyOf = (s: Search) => `${s.origin}>${s.destination}@${s.date}#${s.travelers}`;

const HOME = { JFK: 1, EWR: 1, LGA: 1, ORD: 1, MDW: 1 } as Record<string, number>;
const homeKeys = (list: Search[]) => new Set(list.filter((s) => HOME[s.origin] || HOME[s.destination]).map(keyOf));

function useFares(airports: string[]) {
  const model = createFareModel({ seed: 5, swing: 0.3, cityCodes: mockCodes, homeAirports: airports, travelers: 2 });
  mockedSearch.mockImplementation(async (p: Search) => {
    searched.push(p);
    return model.offers(p);
  });
}

const trip = (cities: string[], origin: string, originAirports: string[]) => ({
  cities: cities.map((name) => ({ name })),
  startDate: '2030-06-02',
  travelers: 2,
  origin,
  originAirports,
  returnToHome: true,
  totalNights: 2 * cities.length + 1,
});

beforeEach(() => {
  jest.clearAllMocks();
  searched = [];
  _resetPrewarm();
});

describe('prewarmHomeFlights', () => {
  it.each([
    ['3 cities from New York (searchHomeFlights)', ['Alpha', 'Bravo', 'Charlie'], 'New York', ['JFK', 'EWR', 'LGA']],
    ['5 cities from Chicago (searchHomeOffers)', ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'], 'Chicago', ['ORD', 'MDW']],
  ])('%s: asks exactly the home flights the plan asks for', async (_label, cities, origin, airports) => {
    useFares(airports);
    const t = trip(cities, origin, airports);

    const outcome = await prewarmHomeFlights(t);
    const warmed = homeKeys(searched);
    expect(outcome).toEqual({ searches: 2 * cities.length * airports.length, deduped: false });
    expect(warmed.size).toBe(2 * cities.length * airports.length);

    searched = [];
    await optimize(t);
    // The plan's home searches on its own two travel days, every one of them,
    // are the pre-searched ones. (On 1-3 cities the date-shift probe also asks
    // the winner's home flights on nearby days; those depend on the winner.)
    const planDays = new Set([t.startDate, addDays(t.startDate, t.totalNights)]);
    const planned = new Set([...homeKeys(searched)].filter((k) => planDays.has(k.split('@')[1].split('#')[0])));
    expect(planned).toEqual(warmed);
  }, 30000);

  it('a repeat of the same trip asks nothing; another party size asks again', async () => {
    useFares(['JFK', 'EWR']);
    const t = trip(['Alpha', 'Bravo'], 'New York', ['JFK', 'EWR']);
    await prewarmHomeFlights(t);
    const first = searched.length;
    expect(await prewarmHomeFlights(t)).toEqual({ searches: 0, deduped: true });
    expect(searched.length).toBe(first);
    expect((await prewarmHomeFlights({ ...t, travelers: 3 })).searches).toBe(8);
  });

  it('one-way: outbound flights only', async () => {
    useFares(['JFK']);
    const outcome = await prewarmHomeFlights({ ...trip(['Alpha', 'Bravo'], 'New York', ['JFK']), returnToHome: false });
    expect(outcome.searches).toBe(2);
    expect(searched.every((s) => s.origin === 'JFK')).toBe(true);
  });

  it('no home city: nothing to pre-search', async () => {
    useFares(['JFK']);
    expect(await prewarmHomeFlights({ ...trip(['Alpha', 'Bravo'], '', []) })).toEqual({ searches: 0, deduped: false });
    expect(searched).toEqual([]);
  });
});
