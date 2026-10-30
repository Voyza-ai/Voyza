/**
 * Independent searches inside optimize() must be in flight together.
 *
 * Measured with the mocked-latency harness (Duffel 1.3-1.9s per search):
 * home-leg estimates waited for the inter-city legs, the return waited for
 * the outbound, every date-shift offset priced legs then home flights, and
 * steps 7 (date shift), 7.5 (leg alternatives) and 8 (home legs) ran one
 * after another. Same searches, same answer — just stacked end to end.
 *
 * These tests hold every search open and look at what has been ASKED FOR,
 * so they pin the shape of the work rather than a timing.
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

type Pending = { key: string; release: () => void };

/** Every search parks until released; `asked` records what was requested. */
function holdSearches(shouldHold: (p: any) => boolean = () => true) {
  const pending: Pending[] = [];
  const asked: string[] = [];
  mockedSearchFlights.mockImplementation((p: any) => {
    const key = `${p.origin}>${p.destination}@${p.date}`;
    asked.push(key);
    if (!shouldHold(p)) return Promise.resolve([offer(100)]);
    return new Promise((resolve) => pending.push({ key, release: () => resolve([offer(100)]) }));
  });
  return { pending, asked };
}

/** Let every queued microtask and timer-0 callback run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('optimize — independent searches run together', () => {
  it('asks for the outbound and the return home flights at the same time', async () => {
    const { pending, asked } = holdSearches();

    const run = optimize({
      cities: [{ name: 'Alpha' }],
      startDate: '2030-06-10',
      travelers: 1,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: true,
      totalNights: 3,
    });
    await settle();

    // Before: only HOM>ALP was in flight; ALP>HOM waited for it to land.
    expect(asked).toEqual(expect.arrayContaining(['HOM>ALP@2030-06-10', 'ALP>HOM@2030-06-13']));

    // Drain everything so the run finishes.
    while (pending.length) {
      pending.splice(0).forEach((p) => p.release());
      await settle();
    }
    await run;
  }, 30000);

  it('asks for home-leg estimates without waiting for the inter-city legs', async () => {
    const { pending, asked } = holdSearches();

    const run = optimize({
      cities: [{ name: 'Alpha' }, { name: 'Bravo' }],
      startDate: '2030-06-10',
      travelers: 1,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: true,
      totalNights: 4,
    });
    await settle();

    // Inter-city legs are parked, yet every home estimate is already asked for.
    expect(asked).toEqual(expect.arrayContaining(['ALP>BRA@2030-06-12', 'BRA>ALP@2030-06-12']));
    expect(asked).toEqual(
      expect.arrayContaining([
        'HOM>ALP@2030-06-10',
        'HOM>BRA@2030-06-10',
        'ALP>HOM@2030-06-14',
        'BRA>HOM@2030-06-14',
      ]),
    );

    while (pending.length) {
      pending.splice(0).forEach((p) => p.release());
      await settle();
    }
    await run;
  }, 30000);

  it('builds the home legs while the date-shift probe is still pricing other dates', async () => {
    // Searches on the requested dates answer at once; every shifted date is
    // held open, so the date-shift probe cannot finish.
    const requested = new Set(['2030-06-10', '2030-06-12', '2030-06-14']);
    const { pending, asked } = holdSearches((p) => !requested.has(p.date));

    const run = optimize({
      cities: [{ name: 'Alpha' }, { name: 'Bravo' }],
      startDate: '2030-06-10',
      travelers: 1,
      origin: 'Home',
      originAirports: ['HOM'],
      returnToHome: true,
      totalNights: 4,
    });
    await settle();
    expect(pending.length).toBeGreaterThan(0); // the probe is parked

    // Scoring asked for each home flight once (outbound + return per first/
    // last city). buildHomeLeg asking again — for the winner — before the
    // probe resolves is the proof that step 8 no longer waits for step 7.
    const homeOut = asked.filter((k) => k.startsWith('HOM>') && k.endsWith('@2030-06-10'));
    expect(homeOut.length).toBeGreaterThan(2);

    pending.splice(0).forEach((p) => p.release());
    await settle();
    const result = await run;
    expect(result.outboundLeg).not.toBeNull();
    expect(result.returnLeg).not.toBeNull();
  }, 30000);
});
