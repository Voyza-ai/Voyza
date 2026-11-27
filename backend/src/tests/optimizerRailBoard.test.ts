/**
 * Prototype B (exp/optimizer-speed): the rail board and the run's one rail
 * call per route-day.
 *
 *  - Every city pair's trains are searched once, up front, on the ranking
 *    day; ranking waits for every pair's first answer (a cap, railWaitMs /
 *    OPT_RAIL_WAIT_MS, is for tests and the benchmark: a pair that has not
 *    answered by then is ranked on its flights).
 *  - Inside one run, the first rail answer for a route-day is the run's
 *    answer, incomplete or not (variant C: one retry after the ranking).
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
    for (const m of ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'order']) {
      chain[m] = jest.fn().mockReturnValue(chain);
    }
    chain.upsert = jest.fn(() => Promise.resolve({ error: null }));
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
  searchHotels: jest.fn(async () => []),
}));

import { optimize, _railForTests } from '../services/optimizer';
import { searchFlights } from '../services/flights';
import { searchTrains, type TrainOffer } from '../services/trains';

const { createRailBoard, createRunRail, RAIL_RANKING_WAIT_MS } = _railForTests;
const mockedFlights = searchFlights as jest.Mock;
const mockedTrains = searchTrains as jest.Mock;

const train = (origin: string, destination: string, date: string, price: number | null): TrainOffer => ({
  id: `t-${origin}-${destination}-${date}`,
  price,
  currency: 'USD',
  departure: `${date}T09:00:00`,
  arrival: `${date}T12:00:00`,
  durationMinutes: 180,
  operator: 'Rail',
  trainType: 'train',
  bookingUrl: null,
  limitedCoverage: price == null,
});

const flight = (origin: string, destination: string, date: string, price: number) => ({
  id: `f-${origin}-${destination}-${date}`,
  price,
  durationMinutes: 90,
  carrier: 'Air',
  carrierCode: 'AA',
  departure: `${date}T08:00:00`,
  arrival: `${date}T09:30:00`,
  currency: 'USD',
  stops: 0,
  bookingUrl: '',
  raw: {},
});

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createRailBoard', () => {
  const base = { day: '2030-03-10', travelers: 2, countryOf: () => undefined };

  it('searches every pair once, at once, on the ranking day', () => {
    const search = jest.fn(() => new Promise<TrainOffer[]>(() => {}));
    createRailBoard({ ...base, pairs: [['A', 'B'], ['B', 'A'], ['A', 'B']], waitMs: 1000, search });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.map(([p]: any[]) => `${p.origin}>${p.destination}@${p.date}`)).toEqual([
      'A>B@2030-03-10',
      'B>A@2030-03-10',
    ]);
  });

  it('ranking reads the snapshot: a pair that answers after the wait is ranked without its train', async () => {
    const slow = deferred<TrainOffer[]>();
    const search = jest.fn(async (p: any) => (p.origin === 'A' ? [train('A', 'B', p.date, 50)] : slow.promise));
    const board = createRailBoard({ ...base, pairs: [['A', 'B'], ['B', 'A']], waitMs: 30, search });
    const params = { origin: 'A', destination: 'B', date: base.day, travelers: 2 };
    const back = { origin: 'B', destination: 'A', date: base.day, travelers: 2 };
    const [ab, ba] = await Promise.all([board.source.search(params), board.source.search(back)]);
    expect(ab.map((t) => t.price)).toEqual([50]);
    expect(ba).toEqual([]); // not in by the snapshot: flights only
    expect(board.stats()).toMatchObject({ pairs: 2, inSnapshot: 1, settled: 1 });

    // It still lands (the winner's legs take it from the run's rail memo).
    slow.resolve([train('B', 'A', base.day, 40)]);
    await sleep(0);
    // Ranking keeps reading the snapshot: one set of trains for every ordering.
    expect(await board.source.search(back)).toEqual([]);
    expect(board.stats()).toMatchObject({ pairs: 2, inSnapshot: 1, settled: 2 });
  });

  it('does not wait out the cap when every pair has answered', async () => {
    const search = jest.fn(async (p: any) => [train(p.origin, p.destination, p.date, 70)]);
    const board = createRailBoard({ ...base, pairs: [['A', 'B']], waitMs: 60_000, search });
    const started = Date.now();
    await board.source.search({ origin: 'A', destination: 'B', date: base.day, travelers: 2 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('with no cap (Infinity) the snapshot waits for the last pair, however late', async () => {
    const search = jest.fn(async (p: any) => {
      await sleep(p.origin === 'B' ? 150 : 0);
      return [train(p.origin, p.destination, p.date, p.origin === 'B' ? 40 : 70)];
    });
    const board = createRailBoard({ ...base, pairs: [['A', 'B'], ['B', 'A']], waitMs: Infinity, search });
    const back = await board.source.search({ origin: 'B', destination: 'A', date: base.day, travelers: 2 });
    expect(back.map((t) => t.price)).toEqual([40]);
    expect(board.stats()).toMatchObject({ pairs: 2, inSnapshot: 2, settled: 2 });
  });

  it('another day, or a pair it does not hold, is searched as usual', async () => {
    const search = jest.fn(async (p: any) => [train(p.origin, p.destination, p.date, 70)]);
    const board = createRailBoard({ ...base, pairs: [['A', 'B']], waitMs: 10, search });
    await board.source.search({ origin: 'A', destination: 'B', date: '2030-03-12', travelers: 2 });
    await board.source.search({ origin: 'C', destination: 'A', date: base.day, travelers: 2 });
    expect(search.mock.calls.map(([p]: any[]) => `${p.origin}>${p.destination}@${p.date}`)).toEqual([
      'A>B@2030-03-10',
      'A>B@2030-03-12',
      'C>A@2030-03-10',
    ]);
  });
});

describe('createRunRail', () => {
  const params = { origin: 'Paris', destination: 'Prague', date: '2027-01-15', travelers: 2, originCountry: 'FR', destinationCountry: 'CZ' };

  it('keeps the first answer for a route-day, incomplete or not — one call per run, on trains.ts\' key', async () => {
    const search = jest.fn(async () => [] as TrainOffer[]);
    const rail = createRunRail(search as any);
    await rail.search(params);
    await rail.search({ ...params }); // the winner's exact re-price
    await rail.search({ ...params, origin: 'paris', destination: 'PRAGUE' }); // same key: names are case-blind
    expect(search).toHaveBeenCalledTimes(1);
    await rail.search({ ...params, date: '2027-01-17' });
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('a failed search is an empty answer, not a rejection', async () => {
    const rail = createRunRail(jest.fn(async () => Promise.reject(new Error('down'))) as any);
    await expect(rail.search(params)).resolves.toEqual([]);
  });

  it('retries once, and only a route-day with no priced train', async () => {
    const search = jest
      .fn()
      .mockResolvedValueOnce([train('Paris', 'Prague', params.date, null)])
      .mockResolvedValueOnce([train('Paris', 'Prague', params.date, 120)]);
    const rail = createRunRail(search as any);
    expect((await rail.search(params))[0].price).toBeNull();
    const [a, b] = await Promise.all([rail.retry(params), rail.retry(params)]);
    expect(a[0].price).toBe(120);
    expect(b).toBe(a);
    expect(search).toHaveBeenCalledTimes(2);
    // A plain second search: incomplete answers are never remembered (trains.ts).
    expect(search.mock.calls[1]).toHaveLength(1);

    const priced = jest.fn(async () => [train('Paris', 'Prague', params.date, 99)]);
    const rail2 = createRunRail(priced as any);
    await rail2.retry(params);
    expect(priced).toHaveBeenCalledTimes(1);
  });
});

describe('optimize with the rail board', () => {
  // Two cities from home: A→B's train is cheap ($50) but slow; flights make
  // B→A ($200) cheaper than A→B ($300). Home flights cost the same either way.
  const TRIP = {
    cities: [{ name: 'Aville' }, { name: 'Bburg' }],
    startDate: '2030-03-08',
    travelers: 2,
    origin: 'Home',
    originAirports: ['HMA'],
    returnToHome: true,
    totalNights: 4,
  };

  const setFlights = () =>
    mockedFlights.mockImplementation(async ({ origin, destination, date }: any) => {
      if (origin === 'HMA' || destination === 'HMA') return [flight(origin, destination, date, 400)];
      if (origin === 'AVI') return [flight(origin, destination, date, 300)];
      return [flight(origin, destination, date, 200)];
    });

  it('ranks on flights when the cheap train answers after the wait, and on the train when it is in time', async () => {
    setFlights();
    mockedTrains.mockImplementation(async (p: any) => {
      if (p.origin !== 'Aville') return [];
      await sleep(150);
      return [train(p.origin, p.destination, p.date, 50)];
    });
    const late = await optimize({ ...TRIP, railWaitMs: 20 });
    expect(late.bestRoute.ordering).toEqual(['Bburg', 'Aville']);

    const inTime = await optimize({ ...TRIP, railWaitMs: 2000 });
    expect(inTime.bestRoute.ordering).toEqual(['Aville', 'Bburg']);
    expect(inTime.bestRoute.legs[0].comparison.trainOption?.price).toBe(50);
  });

  it('by default ranking waits for every pair\'s first rail answer, however late: a train that answers is never ranked without', async () => {
    // No cap by default (T3, 2026-11-27: an 8 s cap ranked without a train
    // that answered at ~11 s, and the trip came out $59 dearer).
    expect(RAIL_RANKING_WAIT_MS).toBe(Infinity);
    setFlights();
    mockedTrains.mockImplementation(async (p: any) => {
      if (p.origin !== 'Aville') return [];
      await sleep(400);
      return [train(p.origin, p.destination, p.date, 50)];
    });
    const result = await optimize(TRIP);
    expect(result.bestRoute.ordering).toEqual(['Aville', 'Bburg']);
    expect(result.bestRoute.legs[0].comparison.trainOption?.price).toBe(50);
  });

  it('a ranking-day pair with no priced train is retried as soon as its first answer is in, not after ranking', async () => {
    setFlights();
    const calls: Array<{ key: string; at: number }> = [];
    const started = Date.now();
    // Home flights are slow (ranking ends late); the first rail answers are quick and empty.
    mockedFlights.mockImplementation(async ({ origin, destination, date }: any) => {
      await sleep(300);
      if (origin === 'HMA' || destination === 'HMA') return [flight(origin, destination, date, 400)];
      return [flight(origin, destination, date, origin === 'AVI' ? 300 : 200)];
    });
    mockedTrains.mockImplementation(async (p: any) => {
      calls.push({ key: `${p.origin}>${p.destination}@${p.date}`, at: Date.now() - started });
      return [];
    });
    await optimize({ ...TRIP });
    for (const pair of ['Aville>Bburg@2030-03-10', 'Bburg>Aville@2030-03-10']) {
      const asked = calls.filter((c) => c.key === pair);
      expect(asked).toHaveLength(2);
      // The retry went out before any flight answered.
      expect(asked[1].at).toBeLessThan(250);
    }
  });

  const railCalls = () =>
    mockedTrains.mock.calls.map(([p, opts]: any[]) => ({
      key: `${p.origin}>${p.destination}@${p.date}`,
      quick: opts?.quick === true,
    }));

  it("ranking asks each pair once (the full search); every route-day at most twice (one retry), even when every answer is empty", async () => {
    setFlights();
    mockedTrains.mockResolvedValue([]);
    await optimize({ ...TRIP, railWaitMs: 20 });
    const calls = railCalls();
    expect(calls.filter((c) => c.quick)).toEqual([]);
    const full = calls.map((c) => c.key);
    for (const pair of ['Aville>Bburg@2030-03-10', 'Bburg>Aville@2030-03-10']) expect(full).toContain(pair);
    for (const key of new Set(full)) expect(full.filter((k) => k === key).length).toBeLessThanOrEqual(2);
  });

  it('with cityNights, a ranking-day retry only for a pair that can be the first leg on that day (any other is wasted)', async () => {
    // The ranking day is the typed first city's (Aville, 2 nights): 03-10. A
    // trip starting in Bburg (3 nights) or Cton (4) flies its first leg on
    // 03-11 or 03-12, and every later leg later still, so a second answer for
    // a Bburg or Cton pair on 03-10 is read by nobody.
    mockedFlights.mockImplementation(async ({ origin, destination, date }: any) =>
      origin === 'HMA' || destination === 'HMA' ? [flight(origin, destination, date, 400)] : [flight(origin, destination, date, 200)],
    );
    mockedTrains.mockResolvedValue([]);
    await optimize({
      cities: [{ name: 'Aville' }, { name: 'Bburg' }, { name: 'Cton' }],
      startDate: '2030-03-08',
      travelers: 2,
      origin: 'Home',
      originAirports: ['HMA'],
      returnToHome: true,
      totalNights: 9,
      cityNights: { Aville: 2, Bburg: 3, Cton: 4 },
    });
    const onRankingDay = railCalls()
      .map((c) => c.key)
      .filter((k) => k.endsWith('@2030-03-10'));
    const times = (pair: string) => onRankingDay.filter((k) => k === `${pair}@2030-03-10`).length;
    for (const pair of ['Bburg>Aville', 'Bburg>Cton', 'Cton>Aville', 'Cton>Bburg']) expect(times(pair)).toBe(1);
    for (const pair of ['Aville>Bburg', 'Aville>Cton']) expect(times(pair)).toBe(2);
  });

  it('OPT_RANKING_RAIL=quick (benchmark only): ranking asks each pair once with the lighter search', async () => {
    setFlights();
    mockedTrains.mockResolvedValue([]);
    process.env.OPT_RANKING_RAIL = 'quick';
    try {
      await optimize({ ...TRIP, railWaitMs: 20 });
    } finally {
      delete process.env.OPT_RANKING_RAIL;
    }
    const calls = railCalls();
    const quick = calls.filter((c) => c.quick).map((c) => c.key);
    expect(quick.sort()).toEqual(['Aville>Bburg@2030-03-10', 'Bburg>Aville@2030-03-10']);
    const full = calls.filter((c) => !c.quick).map((c) => c.key);
    for (const key of new Set(full)) expect(full.filter((k) => k === key).length).toBeLessThanOrEqual(2);
  });
});
