/**
 * The planner must not pick a 22-hour itinerary for a one-hour hop.
 *
 * Production, 2026-11-16 (Prague, Munich, Vienna from New York, Dec 23–31,
 * 2 travellers): the new plan's Prague → Vienna card was a $301 flight taking
 * 22h 50m. A 55m nonstop at $368 was on offer. Both places the planner picks a
 * flight took the cheapest offer whatever its length:
 *   - compareLeg (route ranking, and re-pricing a card): `reduce` by price;
 *   - searchLegOptions (the options a new plan's leg card is filled from,
 *     options[0] on the card): sorted by price.
 * Both now use the chat's long-journey rule (longJourney.ts: over 2× the
 * fastest AND over 3h longer = long) and pick the cheapest sensible option.
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
  const writtenRows: any[] = [];
  const createChain = (): any => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'order', 'delete', 'in', 'lt']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.single = jest.fn().mockResolvedValue({ data: null });
    chain.upsert = jest.fn((rows: any[]) => {
      writtenRows.push(...(Array.isArray(rows) ? rows : [rows]));
      return Promise.resolve({ data: null });
    });
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return { getSupabase: () => ({ from: () => createChain() }), __writtenRows: writtenRows };
});

const mockIata: Record<string, string> = { Prague: 'PRG', Vienna: 'VIE', Munich: 'MUC', London: 'LON', 'New York': 'JFK' };
jest.mock('../services/flights', () => {
  const { AppError } = jest.requireActual('../middleware/error');
  return {
    getIataCode: jest.fn(async (name: string) => {
      const code = mockIata[name];
      if (!code) throw new AppError(404, `No IATA code found for "${name}"`);
      return code;
    }),
    searchFlights: jest.fn(),
  };
});

// Rail is off in production: no train for any leg.
jest.mock('../services/trains', () => ({ searchTrains: jest.fn().mockResolvedValue([]) }));

import { compareLeg } from '../services/compareLeg';
import { searchLegOptions } from '../services/legOptions';
import { optimize } from '../services/optimizer';
import { cheapestSensible, longJourneyLimit, sensibleFirst } from '../services/longJourney';
import { searchFlights } from '../services/flights';

const mockedSearchFlights = searchFlights as jest.Mock;
const { __writtenRows: writtenRows } = require('../services/supabase');

const offer = (price: number, durationMinutes: number, carrier = 'Test Air', departure = '2026-12-26T10:00:00', stops = 0) => ({
  id: `f-${price}-${durationMinutes}`,
  price,
  durationMinutes,
  carrier,
  carrierCode: carrier.slice(0, 2).toUpperCase(),
  departure,
  arrival: '',
  currency: 'USD',
  stops,
  bookingUrl: '',
  raw: {},
});

/** Production's Prague → Vienna offers, Dec 26 2026 (party totals for 2). */
const PRAGUE_VIENNA = [
  offer(301, 22 * 60 + 50, 'Duffel Airways', '2026-12-26T18:00:00', 2), // the 22h 50m production showed
  offer(368, 55, 'Austrian', '2026-12-26T16:50:00'),
  offer(412, 65, 'Czech Airlines', '2026-12-26T07:10:00'),
  offer(590, 4 * 60 + 30, 'Lufthansa', '2026-12-26T08:45:00', 1), // via Munich: long (> 55m + 3h)
];

beforeEach(() => {
  jest.clearAllMocks();
  writtenRows.length = 0;
});

describe('the rule (longJourney.ts)', () => {
  it('a one-hour hop: limit = fastest + 3h; the 22h 50m and the 4h 30m one-stop are long', () => {
    expect(longJourneyLimit(PRAGUE_VIENNA.map((o) => o.durationMinutes))).toBe(55 + 180);
    expect(cheapestSensible(PRAGUE_VIENNA)?.price).toBe(368);
    expect(sensibleFirst(PRAGUE_VIENNA).map((o) => o.price)).toEqual([368, 412, 301, 590]);
  });

  it('transatlantic: ordinary one-stops stay, overnight 30h connections go (limit = 2× the nonstop)', () => {
    const london = [offer(500, 30 * 60 + 30), offer(700, 12 * 60 + 5), offer(900, 8 * 60)];
    expect(longJourneyLimit(london.map((o) => o.durationMinutes))).toBe(16 * 60);
    expect(cheapestSensible(london)?.price).toBe(700);
  });

  it('unknown durations are never long, and a lone offer is always picked', () => {
    expect(cheapestSensible([offer(200, 0), offer(300, 60)])?.price).toBe(200);
    expect(cheapestSensible([offer(250, 9 * 60)])?.price).toBe(250);
    expect(cheapestSensible([])).toBeUndefined();
  });
});

describe('compareLeg (route ranking, and the card re-price)', () => {
  it('Prague → Vienna: the 55m nonstop, not the cheaper 22h 50m itinerary', async () => {
    mockedSearchFlights.mockResolvedValue(PRAGUE_VIENNA);
    const r = await compareLeg({ origin: 'Prague', destination: 'Vienna', date: '2026-12-26', travelers: 2 });
    expect(r.flightOption?.price).toBe(368);
    expect(r.flightOption?.durationMinutes).toBe(55);
    expect(r.recommendation).toBe('flight');
  });

  it('caches the flight it picked, so ranking from the cache sees the same fare', async () => {
    mockedSearchFlights.mockResolvedValue(PRAGUE_VIENNA);
    await compareLeg({ origin: 'Prague', destination: 'Vienna', date: '2026-12-26', travelers: 2 });
    const row = writtenRows.find((x: any) => x.mode === 'flight');
    expect(row).toMatchObject({ price: 368, duration_minutes: 55 });
  });

  it('the card re-price (display) picks the same flight', async () => {
    mockedSearchFlights.mockResolvedValue(PRAGUE_VIENNA);
    const r = await compareLeg({ origin: 'Prague', destination: 'Vienna', date: '2026-12-26', travelers: 2, display: true });
    expect(r.flightOption?.carrier).toBe('Austrian');
  });

  it('when every option is slow, it still picks the cheapest (and does not drop the leg)', async () => {
    mockedSearchFlights.mockResolvedValue([offer(650, 9 * 60 + 5), offer(700, 8 * 60 + 20)]);
    const r = await compareLeg({ origin: 'Prague', destination: 'Vienna', date: '2026-12-26', travelers: 2 });
    expect(r.flightOption?.price).toBe(650);
  });
});

describe('searchLegOptions (what a new plan puts on the leg card)', () => {
  it('options[0] is the 55m nonstop; long journeys come after every sensible one', async () => {
    mockedSearchFlights.mockResolvedValue(PRAGUE_VIENNA);
    const r = await searchLegOptions({ from: 'Prague', to: 'Vienna', date: '2026-12-26', travelers: 2, limit: 4 });
    expect(r.options.map((o) => [o.price, o.durationMinutes])).toEqual([
      [368, 55],
      [412, 65],
      [301, 22 * 60 + 50],
      [590, 4 * 60 + 30],
    ]);
  });

  it('with more sensible options than the card holds, the long ones are left off', async () => {
    mockedSearchFlights.mockResolvedValue([...PRAGUE_VIENNA, offer(420, 60), offer(430, 70)]);
    const r = await searchLegOptions({ from: 'Prague', to: 'Vienna', date: '2026-12-26', travelers: 2, limit: 4 });
    expect(r.options.map((o) => o.price)).toEqual([368, 412, 420, 430]);
  });

  it('a time window still applies first (the chat\'s "no flights before 5pm")', async () => {
    mockedSearchFlights.mockResolvedValue(PRAGUE_VIENNA);
    const r = await searchLegOptions({
      from: 'Prague', to: 'Vienna', date: '2026-12-26', travelers: 2, limit: 4, window: { earliestDepart: '17:00' },
    });
    // Only the 18:00 departure is left: alone, it is the fastest, so not "long".
    expect(r.options.map((o) => o.departTime)).toEqual(['18:00']);
  });
});

describe('optimize(): ranking and the plan as the user sees it', () => {
  // Home fares are equal for every city, so only the hops decide the order.
  // Prague ↔ Vienna's cheapest fare is the 22h 50m one ($301; the nonstop is
  // $368). Vienna ↔ Munich $200, Prague ↔ Munich $330.
  //   Through Prague ↔ Vienna: $301 + $200 = $501 on the long fare, $568 on the nonstop.
  //   Around it (Prague ↔ Munich ↔ Vienna): $330 + $200 = $530.
  // Ranked on the 22h 50m fare, the order through Prague ↔ Vienna "wins" by $29.
  function fares() {
    mockedSearchFlights.mockImplementation(async ({ origin, destination }: any) => {
      const pair = [origin, destination].sort().join('-');
      if (origin === 'JFK' || destination === 'JFK') return [offer(500, 9 * 60)];
      if (pair === 'PRG-VIE') return PRAGUE_VIENNA;
      if (pair === 'MUC-VIE') return [offer(200, 60)];
      if (pair === 'MUC-PRG') return [offer(330, 55)];
      return [];
    });
  }
  const run = () =>
    optimize({
      cities: [{ name: 'Prague' }, { name: 'Munich' }, { name: 'Vienna' }],
      startDate: '2030-12-23',
      travelers: 2,
      origin: 'New York',
      originAirports: ['JFK'],
      returnToHome: true,
      totalNights: 8,
    });

  it('does not choose the order because of a 22-hour fare', async () => {
    fares();
    const result = await run();
    const o = result.bestRoute.ordering;
    const hops = o.slice(1).map((c, i) => [o[i], c].sort().join('-'));
    expect(hops).not.toContain('Prague-Vienna');
  }, 30000);

  it('no leg of the plan is a long journey — on the cards (options[0]) or in the comparison', async () => {
    fares();
    const result = await run();
    for (const leg of result.bestRoute.legs as any[]) {
      expect(leg.comparison.flightOption.durationMinutes).toBeLessThanOrEqual(65);
      if (leg.options) expect(leg.options[0].durationMinutes).toBeLessThanOrEqual(65);
    }
  }, 30000);
});
