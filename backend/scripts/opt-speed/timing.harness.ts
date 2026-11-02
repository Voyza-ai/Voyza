/// <reference types="jest" />
/**
 * Duffel requests and modelled wall time of a cold optimize, through the REAL
 * flights.ts (its 6-slot gate, search cache, retry and rate-limit pause) and
 * a fake Duffel that behaves like production's test token (2026-10-30):
 *
 *  - each search answers in 0.5-2s (fixed per search, so before and after
 *    pay the same latency for the same search);
 *  - a window of 45 accepted searches starts at the first request and lasts
 *    60s; past 45 Duffel answers 429 with `ratelimit-reset` at the window's
 *    end, which flights.ts waits out.
 *
 * Virtual time (jest modern fake timers): a 60s stall costs nothing to run.
 *
 *   npx jest -c scripts/opt-speed/jest.config.js timing
 *   OPT_SPEED_BASELINE=1 npx jest -c scripts/opt-speed/jest.config.js timing
 *
 * Scenarios are real city names (real airport resolution and location
 * index): the owner's production trip — Porto, Seville, Valencia, Marseille,
 * Turin from Chicago ORD + MDW, 4 travelers, 12 nights — and its 3- and
 * 4-city prefixes, plus the 5-city trip from New York (3-airport metro) and
 * from Boston (no metro code).
 */

jest.mock('../../src/config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'test_token',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test_key',
    DB_REST_BASE_URL: 'https://v6.db.transport.rest',
  },
}));
jest.mock('../../src/services/supabase', () => {
  const createChain = (): any => {
    const chain: any = {};
    for (const m of ['select', 'eq', 'gte', 'limit', 'single', 'insert', 'upsert', 'order']) chain[m] = () => chain;
    chain.single = async () => ({ data: null });
    chain.then = (fn: any) => Promise.resolve({ data: [] }).then(fn);
    return chain;
  };
  return { getSupabase: () => ({ from: () => createChain() }) };
});
const mockDuffel: { create: (req: any) => Promise<any>; suggestions: number } = {
  create: async () => ({ data: { offers: [] } }),
  suggestions: 0,
};
jest.mock('../../src/services/duffel', () => ({
  getDuffel: () => ({
    offerRequests: { create: (req: any) => mockDuffel.create(req) },
    suggestions: {
      list: async () => {
        mockDuffel.suggestions++;
        return { data: [] };
      },
    },
  }),
}));
jest.mock('../../src/services/currency', () => ({ convertToUsd: async (amount: number) => amount }));
jest.mock('../../src/services/trains', () => ({ searchTrains: async () => [] }));
jest.mock('../../src/services/hotels', () => ({
  ...jest.requireActual('../../src/services/hotels'),
  searchHotels: async ({ city, checkin, checkout }: any) => {
    const nights = Math.round((Date.parse(checkout) - Date.parse(checkin)) / 864e5);
    return [
      {
        id: `${city}-hotel`,
        name: `${city} Hotel`,
        price: 140 * nights,
        pricePerNight: 140,
        currency: 'USD',
        rating: 8.4,
        reviewCount: 900,
        stars: 3,
        thumbnail: '',
        bookingUrl: '',
        amenities: [],
      },
    ];
  },
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { createFareModel, tripDates, type TripSpec } from '../../src/tests/helpers/fareModel';
import { logger } from '../../src/utils/logger';
import { HOMES, baseline, classify, label, mean, percentile, round, type HomeSetup, type Phase } from './common';

const realSetImmediate = setImmediate;
jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'], now: Date.parse('2026-11-02T12:00:00Z') });

// flights.ts jitters its retries with Math.random: seed it, so runs repeat.
let rng = 1;
Math.random = () => {
  rng = (Math.imul(rng ^ (rng >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) | 0;
  return ((rng ^ (rng >>> 14)) >>> 0) / 4294967296;
};

const { optimize } = baseline
  ? (require('./baseline/optimizer.dev') as typeof import('../../src/services/optimizer'))
  : (require('../../src/services/optimizer') as typeof import('../../src/services/optimizer'));
const mockedInfo = logger.info as jest.Mock;

const WINDOW_MS = 60_000;
const WINDOW_LIMIT = 45;
const SLOTS_NOTE = 'flights.ts MAX_CONCURRENT_SEARCHES = 6';

const CODES: Record<string, string> = {
  Porto: 'OPO',
  Seville: 'SVQ',
  Valencia: 'VLC',
  Marseille: 'MRS',
  Turin: 'TRN',
};
const PRODUCTION = ['Porto', 'Seville', 'Valencia', 'Marseille', 'Turin'];

type Scenario = { name: string; cities: string[]; nights: number; home: HomeSetup };
const SCENARIOS: Scenario[] = [
  { name: '3-city (Porto, Seville, Valencia) from Chicago', cities: PRODUCTION.slice(0, 3), nights: 8, home: HOMES.CHI },
  { name: '4-city (+ Marseille) from Chicago', cities: PRODUCTION.slice(0, 4), nights: 10, home: HOMES.CHI },
  { name: 'production: 5-city from Chicago ORD+MDW, 4 travelers, 12 nights', cities: PRODUCTION, nights: 12, home: HOMES.CHI },
  { name: '5-city from New York JFK+LGA+EWR', cities: PRODUCTION, nights: 12, home: HOMES.NYC },
  { name: '5-city from Boston BOS+PVD (no metro code)', cities: PRODUCTION, nights: 12, home: HOMES.BOS },
];
const SEEDS = Number(process.env.TIMING_SEEDS ?? 12);

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function duffelOffer(o: { id: string; price: number; departure: string; arrival: string; originAirport: string; destinationAirport: string; stops: number }) {
  const segment = {
    departing_at: o.departure,
    arriving_at: o.arrival,
    duration: 'PT5H30M',
    origin: { iata_code: o.originAirport, time_zone: 'UTC' },
    destination: { iata_code: o.destinationAirport, time_zone: 'UTC' },
    operating_carrier: { name: 'Test Air', iata_code: 'TA' },
  };
  return { id: o.id, total_amount: o.price.toFixed(2), total_currency: 'USD', slices: [{ duration: 'PT5H30M', segments: [segment] }] };
}

/** Drive a promise to completion in virtual time; returns the virtual ms it took. */
async function inVirtualTime<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  run().then(
    (v) => {
      settled = true;
      value = v;
    },
    (e) => {
      settled = true;
      error = e;
    },
  );
  for (let guard = 0; !settled; guard++) {
    if (guard > 1_000_000) throw new Error('virtual time runaway');
    await new Promise<void>((r) => realSetImmediate(r));
    if (settled) break;
    if (jest.getTimerCount() > 0) await jest.advanceTimersToNextTimerAsync();
  }
  if (error) throw error;
  return { value: value as T, ms: Date.now() - start };
}

async function runOnce(s: Scenario, seed: number) {
  const startDate = `2030-0${3 + (seed % 6)}-${String(4 + (seed % 20)).padStart(2, '0')}`;
  const spec: TripSpec = {
    cities: s.cities,
    startDate,
    totalNights: s.nights,
    homeAirports: s.home.airports,
    returnToHome: true,
  };
  const model = createFareModel({
    seed: 7000 + seed,
    swing: 0.3,
    cityCodes: CODES,
    homeAirports: [...new Set([...s.home.airports, ...Object.values(s.home.metros).flat()])],
    metros: s.home.metros,
    travelers: 4,
    legRange: [50, 225],
    homeRange: [600, 1100],
  });

  // Cold: past flights.ts' 10-minute search cache, and a fresh rate-limit
  // window (as after the measured 75s idle).
  jest.advanceTimersByTime(11 * 60_000);
  let windowStart = -Infinity;
  let accepted = 0;
  let rejected = 0;
  const searches: Array<{ origin: string; destination: string; date: string; at: number }> = [];
  mockDuffel.create = (req: any) => {
    const slice = req.slices[0];
    const p = { origin: slice.origin, destination: slice.destination, date: slice.departure_date, travelers: req.passengers.length };
    const now = Date.now();
    if (now >= windowStart + WINDOW_MS) {
      windowStart = now;
      accepted = 0;
    }
    if (accepted >= WINDOW_LIMIT) {
      rejected++;
      const reset = new Date(windowStart + WINDOW_MS).toISOString();
      return new Promise((_, reject) =>
        setTimeout(() => {
          const err: any = new Error('rate limited');
          err.meta = { status: 429 };
          err.headers = new Map([['ratelimit-reset', reset]]);
          reject(err);
        }, 150),
      );
    }
    accepted++;
    searches.push({ ...p, at: now });
    const latency = 500 + Math.round((hash(`${p.origin}>${p.destination}@${p.date}`) / 4294967296) * 1500);
    const offers = model.offers(p).map(duffelOffer);
    return new Promise((resolve) => setTimeout(() => resolve({ data: { offers } }), latency));
  };
  mockDuffel.suggestions = 0;
  mockedInfo.mockClear();

  const { value: result, ms } = await inVirtualTime(() =>
    optimize({
      cities: s.cities.map((name) => ({ name })),
      startDate,
      travelers: 4,
      origin: s.home.origin,
      originAirports: s.home.airports,
      returnToHome: true,
      totalNights: s.nights,
    }),
  );

  const classified: Record<Phase, number> = { 'inter-city': 0, home: 0, probe: 0 };
  for (const q of searches) classified[classify(q, spec, s.home)]++;
  const ledger = mockedInfo.mock.calls.find(([m]) => m === 'Optimize flight searches')?.[1] as any;
  const d = tripDates(spec);
  return {
    ms,
    requests: searches.length + rejected,
    accepted: searches.length,
    rejected429: rejected,
    suggestions: mockDuffel.suggestions,
    classified,
    byPhase: ledger?.byPhase ?? null,
    exactRounds: ledger?.exactRounds ?? null,
    enrichOrOther: ledger ? searches.length - (ledger.searches as number) : null,
    winner: result.bestRoute.ordering.join(' > '),
    homeLegsBuilt: !!result.outboundLeg && !!result.returnLeg,
    dateShiftChecked: result.dateShiftChecked,
    planDays: [d.outbound, ...d.legs, d.ret].length,
  };
}

it(`requests and modelled time — ${label}`, async () => {
  const out: any[] = [];
  for (const s of SCENARIOS) {
    const runs: Array<Awaited<ReturnType<typeof runOnce>>> = [];
    for (let seed = 1; seed <= SEEDS; seed++) runs.push(await runOnce(s, seed));
    const secs = runs.map((r) => r.ms / 1000);
    const phases = new Set(runs.flatMap((r) => Object.keys(r.byPhase ?? {})));
    const summary = {
      scenario: s.name,
      runs: runs.length,
      seconds: { mean: round(mean(secs), 1), p50: round(percentile(secs, 0.5), 1), max: round(Math.max(...secs), 1) },
      stalledRuns: runs.filter((r) => r.rejected429 > 0).length,
      duffelRequests: { mean: round(mean(runs.map((r) => r.requests)), 1), max: Math.max(...runs.map((r) => r.requests)) },
      acceptedSearches: { mean: round(mean(runs.map((r) => r.accepted)), 1), p50: percentile(runs.map((r) => r.accepted), 0.5), max: Math.max(...runs.map((r) => r.accepted)) },
      rejected429Mean: round(mean(runs.map((r) => r.rejected429)), 1),
      byKindMean: {
        'inter-city': round(mean(runs.map((r) => r.classified['inter-city'])), 1),
        home: round(mean(runs.map((r) => r.classified.home)), 1),
        probe: round(mean(runs.map((r) => r.classified.probe)), 1),
      },
      byPhaseMean: Object.fromEntries([...phases].map((p) => [p, round(mean(runs.map((r) => r.byPhase?.[p] ?? 0)), 1)])),
      enrichOrOtherMean: runs[0].enrichOrOther === null ? null : round(mean(runs.map((r) => r.enrichOrOther ?? 0)), 2),
      exactRoundsMean: runs[0].exactRounds === null ? null : round(mean(runs.map((r) => r.exactRounds ?? 0)), 1),
      placeSuggestionLookups: runs.reduce((s2, r) => s2 + r.suggestions, 0),
      homeLegsBuilt: runs.filter((r) => r.homeLegsBuilt).length,
      dateShiftChecked: runs.filter((r) => r.dateShiftChecked).length,
    };
    out.push({ summary, runs });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  }
  const file = path.join(__dirname, 'results', `timing-${baseline ? 'before' : 'after'}.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ label, model: { windowMs: WINDOW_MS, windowLimit: WINDOW_LIMIT, latencyMs: [500, 2000], slots: SLOTS_NOTE }, scenarios: out }, null, 2)}\n`,
  );
});
