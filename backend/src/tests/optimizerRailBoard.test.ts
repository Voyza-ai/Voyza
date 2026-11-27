/**
 * Prototype B (exp/optimizer-speed): the rail board, the run's one rail call
 * per route-day, and the two-phase answer.
 *
 *  - Every city pair's trains are searched once, up front, on the ranking
 *    day; ranking waits for them at most RAIL_RANKING_WAIT_MS and ranks a
 *    pair that has not answered on its flights.
 *  - Inside one run, the first rail answer for a route-day is the run's
 *    answer, incomplete or not (variant C: one retry after the ranking).
 *  - onFirstAnswer gets the trip as soon as the ranking is decided; the
 *    full answer follows with trains on their real days and alternatives.
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

import { optimize, _railForTests, type OptimizeResult } from '../services/optimizer';
import { searchFlights } from '../services/flights';
import { searchTrains, type TrainOffer } from '../services/trains';

const { createRailBoard, createRunRail } = _railForTests;
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
    expect(board.snapshotHad('A', 'B')).toBe(true);
    expect(board.snapshotHad('B', 'A')).toBe(false);

    // It still lands, for the winner's legs to take.
    slow.resolve([train('B', 'A', base.day, 40)]);
    await sleep(0);
    expect(board.answerNow('B', 'A')?.map((t) => t.price)).toEqual([40]);
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

  it('two-phase: the first answer comes at the ranking, provisional and without alternatives; the full one finishes it', async () => {
    setFlights();
    mockedTrains.mockImplementation(async (p: any) => [train(p.origin, p.destination, p.date, p.origin === 'Bburg' ? 260 : 280)]);
    const events: string[] = [];
    let first: OptimizeResult | undefined;
    const full = await optimize({
      ...TRIP,
      railWaitMs: 20,
      onFirstAnswer: (r) => {
        events.push('first');
        first = r;
      },
    });
    events.push('full');
    expect(events).toEqual(['first', 'full']);
    expect(first!.provisional).toBe(true);
    expect(first!.dateShiftChecked).toBe(false);
    expect(first!.bestRoute.legs.every((l) => !l.options)).toBe(true);
    expect(first!.bestRoute.ordering).toEqual(full.bestRoute.ordering);
    expect(first!.outboundLeg?.price).toBe(full.outboundLeg?.price);
    expect(full.provisional).toBeUndefined();
    // A copy: finishing the full answer does not reach into the first.
    expect(first!.bestRoute).not.toBe(full.bestRoute);
  });
});
