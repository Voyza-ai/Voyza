/**
 * The date-shift probe ("start a day earlier, save $X") never holds the plan.
 *
 * It is a banner, but optimize() used to wait for it: on a 5-city trip it was
 * the last 20 Duffel searches of the response — 8.2s of 52.8s at production's
 * ~2.5 searches/s (mocked-latency harness). Now, once the core result is ready
 * (winner, leg alternatives, home legs), a 4+ city probe gets
 * DATE_SHIFT_GRACE_MS (1.5s) more; past that the plan goes out with no
 * suggestion and dateShiftChecked: false, and the probe's unsent searches are
 * dropped. 1-3 city trips keep their probe — it is what shows "Best price for
 * these dates" — with a 10s allowance instead.
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

// IATA = first three letters, upper-cased ("Alpha" → ALP, "Home" → HOM).
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

const mockedFlights = searchFlights as jest.Mock;
const mockedHotels = searchHotels as jest.Mock;

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fares: inter-city $100; home → Alpha $500 (every other city $900, so Alpha
 * goes first); every return $500; home → Alpha the day before the start $100
 * — a $400 saving the probe can find. A search on a date the plan itself
 * travels answers at once; any other date (only the probe asks for those)
 * after `probeDelayMs`.
 */
function fares(planDates: string[], probeDelayMs: number, dayBefore: string) {
  const asked: Array<{ key: string; at: number }> = [];
  mockedFlights.mockImplementation(async ({ origin, destination, date }: any) => {
    asked.push({ key: `${origin}>${destination}@${date}`, at: Date.now() });
    if (!planDates.includes(date)) await sleep(probeDelayMs);
    if (origin === 'HOM') return [offer(destination !== 'ALP' ? 900 : date === dayBefore ? 100 : 500)];
    if (destination === 'HOM') return [offer(500)];
    return [offer(100)];
  });
  return asked;
}

/** $100 a night in every city, on any dates — the shift saves on flights alone. */
function flatHotels() {
  mockedHotels.mockImplementation(async ({ city, checkin, checkout }: any) => {
    const nights = Math.round((Date.parse(checkout) - Date.parse(checkin)) / 864e5);
    return [
      {
        id: city,
        name: `${city} Hotel`,
        price: 100 * nights,
        pricePerNight: 100,
        currency: 'USD',
        rating: 8.5,
        reviewCount: 800,
        stars: 3,
        thumbnail: '',
        bookingUrl: '',
        amenities: [],
      },
    ];
  });
}

const FOUR = {
  cities: [{ name: 'Alpha' }, { name: 'Bravo' }, { name: 'Charlie' }, { name: 'Delta' }],
  startDate: '2030-06-10',
  travelers: 2,
  origin: 'Home',
  originAirports: ['HOM'],
  returnToHome: true,
  totalNights: 8,
};
// Start, the three leg days (2 nights a city) and the flight home.
const FOUR_PLAN_DATES = ['2030-06-10', '2030-06-12', '2030-06-14', '2030-06-16', '2030-06-18'];

const THREE = { ...FOUR, cities: FOUR.cities.slice(0, 3), totalNights: 6 };
const THREE_PLAN_DATES = ['2030-06-10', '2030-06-12', '2030-06-14', '2030-06-16'];

// The first optimize() in a process loads the location artifact (seconds);
// load it here so the timings below are the probe's, not that.
beforeAll(async () => {
  fares(FOUR_PLAN_DATES, 0, '');
  flatHotels();
  await optimize({ ...FOUR, cities: FOUR.cities.slice(0, 1), totalNights: 2 });
}, 30000);

beforeEach(() => {
  jest.clearAllMocks();
  flatHotels();
});

describe('the date-shift probe never holds the plan (4+ cities)', () => {
  it('a probe still pricing after the grace: no suggestion, not checked, and the plan goes out', async () => {
    const PROBE_DELAY = 3000;
    const asked = fares(FOUR_PLAN_DATES, PROBE_DELAY, '2030-06-09');

    const result = await optimize(FOUR);
    const returnedAt = Date.now();
    const probeAsked = asked.filter((a) => !FOUR_PLAN_DATES.includes(a.key.split('@')[1]));
    expect(probeAsked.length).toBeGreaterThan(0);
    const probeStarted = Math.min(...probeAsked.map((a) => a.at));

    // Before: the plan waited for the probe's searches (3s each) and came
    // back with the $400 suggestion and dateShiftChecked: true.
    expect(returnedAt - probeStarted).toBeLessThan(PROBE_DELAY);
    expect(returnedAt - probeStarted).toBeGreaterThanOrEqual(1400); // the grace was given
    expect(result.dateShiftSuggestion).toBeUndefined();
    expect(result.dateShiftChecked).toBe(false);

    // The plan itself is whole.
    expect(result.bestRoute.ordering[0]).toBe('Alpha');
    expect(result.bestRoute.legs).toHaveLength(3);
    expect(result.outboundLeg?.price).toBe(500);
    expect(result.returnLeg?.price).toBe(500);

    // At most one gate's worth of probe searches was ever sent...
    expect(probeAsked.length).toBeLessThanOrEqual(6);

    // ...and once those land, nothing more is sent, and no hotel is re-priced.
    await sleep(PROBE_DELAY + 500);
    expect(asked.filter((a) => a.at >= returnedAt)).toHaveLength(0);
    expect(mockedHotels).not.toHaveBeenCalled();
  }, 30000);

  it('a probe that lands inside the grace: suggestion offered and checked', async () => {
    fares(FOUR_PLAN_DATES, 100, '2030-06-09');

    const result = await optimize(FOUR);

    expect(result.dateShiftChecked).toBe(true);
    expect(result.dateShiftSuggestion).toMatchObject({ dayOffset: -1, newStartDate: '2030-06-09', savings: 400 });
  }, 30000);
});

describe('1-3 city trips keep their probe', () => {
  it('a 3-city probe slower than the 4+ city grace still lands', async () => {
    const PROBE_DELAY = 2500;
    fares(THREE_PLAN_DATES, PROBE_DELAY, '2030-06-09');

    const started = Date.now();
    const result = await optimize(THREE);

    expect(Date.now() - started).toBeGreaterThanOrEqual(PROBE_DELAY);
    expect(result.dateShiftChecked).toBe(true);
    expect(result.dateShiftSuggestion).toMatchObject({ dayOffset: -1, newStartDate: '2030-06-09', savings: 400 });
  }, 30000);
});
