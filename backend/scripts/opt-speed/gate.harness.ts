/// <reference types="jest" />
/**
 * Quality and request gate for 4-5 city plans: thousands of random trips
 * through the REAL optimize(), flights answered by the fare model through a
 * virtual-time Duffel (sim.ts: 2.6 s median latency with tails, 6 slots, 45
 * requests per 60 s window), each compared with pricing every ordering at
 * every home airport (helpers/fareModel.ts `exhaustive`).
 *
 * Fare models:
 *  - 30:       per-date swing ±30% (the screen's assumption);
 *  - volatile: per-route swing drawn from ±60-80% (Duffel test mode, measured);
 *  - 50:       ±50%.
 * Duffel modes (common.ts DuffelMode): live (metro search answers for every
 * airport) and test (metro answers are test-airline placeholders, MDW / LGA
 * test airline only). The optimizer sees the matching token prefix.
 *
 * Acceptance (2026-11-02): ±30% live ≥ 99% identical and worst ≤ 3%; volatile
 * reported (mean dearer ≤ 3%); ≤ 2% of 5-city plans over 45 requests in every
 * model.
 *
 *   npx jest -c scripts/opt-speed/jest.config.js gate
 *   GATE_TRIALS=200 GATE_ONLY=5c-CHI-30-live npx jest -c scripts/opt-speed/jest.config.js gate
 *   OPT_SPEED_BASELINE=shipped …  (production's optimizer, dev 073be1d)
 *
 * "Requests" = Duffel offer requests the plan sent, 429s included; "searches"
 * = distinct (route, date, party): flights.ts dedupes repeats.
 */

jest.mock('../../src/config/env', () => ({
  env: {
    DUFFEL_ACCESS_TOKEN: 'duffel_test_harness',
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
jest.mock('../../src/services/flights', () => {
  const { AppError } = jest.requireActual('../../src/middleware/error');
  const { CITY_CODES } = jest.requireActual('./common');
  return {
    getIataCode: jest.fn(async (name: string) => {
      const code = CITY_CODES[name];
      if (!code) throw new AppError(404, `No IATA code found for "${name}"`);
      return code;
    }),
    searchFlights: jest.fn(),
  };
});
jest.mock('../../src/services/trains', () => ({ searchTrains: async () => [] }));
jest.mock('../../src/services/hotels', () => ({
  ...jest.requireActual('../../src/services/hotels'),
  searchHotels: async () => [],
}));
// Made-up city names: keep the location index out of it (see the CI test).
jest.mock('../../src/services/location/sameAirportArea', () => ({
  sameAirportArea: (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase(),
}));
jest.mock('../../src/services/location/destinationAirport', () => ({ resolveDestinationIata: () => null }));
jest.mock('../../src/services/location/originAirports', () => ({
  resolveOriginAirports: () => ({ airports: [], placeId: null }),
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { env } from '../../src/config/env';
import { searchFlights } from '../../src/services/flights';
import { logger } from '../../src/utils/logger';
import { isDuffelTestAirline } from '../../src/utils/testAirline';
import { exhaustive, priceExactly, type TripSpec } from '../../src/tests/helpers/fareModel';
import {
  CITY_CODES,
  CITY_NAMES,
  HOMES,
  baseline,
  classify,
  homeModel,
  label,
  loadOptimizer,
  mean,
  percentile,
  resultTag,
  round,
  tokenFor,
  type DuffelMode,
  type Phase,
} from './common';
import { createDuffelSim } from './sim';

const { optimize } = loadOptimizer();

const mockedSearch = searchFlights as jest.Mock;
const mockedInfo = logger.info as jest.Mock;

type Fares = '30' | '50' | 'volatile';
type Variant = {
  name: string;
  cities: number;
  fares: Fares;
  home: keyof typeof HOMES;
  /** What Duffel answers. */
  duffel: DuffelMode;
  /** The token the optimizer sees, when it differs from `duffel` (sensitivity rows). */
  token?: DuffelMode;
  trials: number;
  /** Countries per city (production-shaped clustering); omitted → none known. */
  countries?: string[];
  /** Chance that a route has no flight on one particular day. */
  dayGaps?: number;
  /** Chance that a route has no flight on any day. */
  routeGaps?: number;
  /** Duffel returns at most this many offers per metro search (cheapest first). */
  metroCap?: number;
  /** Not part of the acceptance: a sensitivity row. */
  extra?: boolean;
};

const T = Number(process.env.GATE_TRIALS ?? 1000);
const half = Math.ceil(T / 2);
const VARIANTS: Variant[] = [];
// The gate: every fare model × Duffel mode × 4/5 cities × 2/3-airport home.
for (const fares of ['30', 'volatile'] as const) {
  for (const duffel of ['live', 'test'] as const) {
    for (const cities of [4, 5]) {
      for (const home of ['CHI', 'NYC'] as const) {
        VARIANTS.push({ name: `${cities}c-${home}-${fares}-${duffel}`, cities, fares, home, duffel, trials: T });
      }
    }
  }
}
VARIANTS.push(
  // Why live mode ranks on the metro code: the same live fares, ranked on the
  // primary airport only (what test mode does).
  { name: '5c-CHI-30-live-ranked-on-primary', cities: 5, fares: '30', home: 'CHI', duffel: 'live', token: 'test', trials: T, extra: true },
  { name: '5c-NYC-30-live-ranked-on-primary', cities: 5, fares: '30', home: 'NYC', duffel: 'live', token: 'test', trials: T, extra: true },
  // ±50%.
  { name: '5c-CHI-50-live', cities: 5, fares: '50', home: 'CHI', duffel: 'live', trials: half, extra: true },
  // Production-shaped: Porto, Seville, Valencia, Marseille, Turin (ES twice).
  { name: '5c-CHI-30-live-clustered', cities: 5, fares: '30', home: 'CHI', duffel: 'live', trials: half, countries: ['PT', 'ES', 'ES', 'FR', 'IT'], extra: true },
  { name: '5c-CHI-volatile-test-clustered', cities: 5, fares: 'volatile', home: 'CHI', duffel: 'test', trials: half, countries: ['PT', 'ES', 'ES', 'FR', 'IT'], extra: true },
  // Other homes: extra airports in the metro, and no metro at all.
  { name: '5c-LON-30-live', cities: 5, fares: '30', home: 'LON', duffel: 'live', trials: half, extra: true },
  { name: '5c-BOS-30-live', cities: 5, fares: '30', home: 'BOS', duffel: 'live', trials: half, extra: true },
  { name: '5c-BOS-volatile-test', cities: 5, fares: 'volatile', home: 'BOS', duffel: 'test', trials: half, extra: true },
  // Missing flights: whole routes, and routes missing on single days.
  { name: '5c-CHI-30-live-gaps', cities: 5, fares: '30', home: 'CHI', duffel: 'live', trials: half, routeGaps: 0.05, dayGaps: 0.05, extra: true },
  // Duffel capping a metro search's offers.
  { name: '5c-LON-30-live-metrocap3', cities: 5, fares: '30', home: 'LON', duffel: 'live', trials: half, metroCap: 3, extra: true },
);

function unit(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

/**
 * Per-person fare ranges and per-date swing. `volatile` is calibrated to
 * production's test token: its sandbox fares are not distance-based, so an
 * inter-city hop prices on the scale of a transatlantic flight. With the live
 * ranges ([50, 225] legs) the shipped optimizer needed 4 exact searches on
 * average for 5 cities; production's one measured plan needed 33 over 25
 * rounds. With [600, 1100] for both it needs 13 on average, p95 24 rounds
 * (100 trials, 2026-11-02): production's plan is in that tail.
 * GATE_LEG_RANGE / GATE_HOME_RANGE ("lo,hi") override the ranges.
 */
const FARES: Record<Fares, { swing: number; swingRange?: [number, number]; legRange: [number, number]; homeRange: [number, number] }> = {
  '30': { swing: 0.3, legRange: [50, 225], homeRange: [600, 1100] },
  '50': { swing: 0.5, legRange: [50, 225], homeRange: [600, 1100] },
  volatile: { swing: 0.7, swingRange: [0.6, 0.8], legRange: [600, 1100], homeRange: [600, 1100] },
};
const range = (v: string | undefined) => v?.split(',').map(Number) as [number, number] | undefined;

async function runVariant(v: Variant) {
  const home = HOMES[v.home];
  const cities = CITY_NAMES.slice(0, v.cities);
  const spec: TripSpec = {
    cities,
    startDate: '2030-05-04',
    totalNights: v.cities === 5 ? 12 : 10,
    homeAirports: home.airports,
    returnToHome: true,
    countries: v.countries,
  };
  const travelers = 4;
  (env as any).DUFFEL_ACCESS_TOKEN = tokenFor(v.token ?? v.duffel);
  const rows: Array<{
    same: boolean;
    miss: number;
    requests: number;
    rejected429: number;
    searches: number;
    byPhase: Record<string, number>;
    classified: Record<Phase, number>;
    rounds: number | null;
    budgetStop: boolean;
    ms: number;
    homeFareDiff: boolean;
    testAirlineHome: boolean;
    unpricedWinner: boolean;
  }> = [];

  for (let t = 0; t < v.trials; t++) {
    const seed = 10_000 * v.cities + (v.fares === '30' ? 30 : v.fares === '50' ? 50 : 70) * 1000 + t;
    const codes = cities.map((c) => CITY_CODES[c]);
    const noFlights = new Set<string>();
    const noFlightsOn = new Set<string>();
    if (v.routeGaps || v.dayGaps) {
      const days = [...new Set([spec.startDate, ...Array.from({ length: 20 }, (_, i) => `2030-05-${String(4 + i).padStart(2, '0')}`)])];
      for (const a of codes) for (const b of codes) {
        if (a === b) continue;
        if (unit(seed, `route|${a}>${b}`) < (v.routeGaps ?? 0)) noFlights.add(`${a}>${b}`);
        for (const d of days) if (unit(seed, `day|${a}>${b}@${d}`) < (v.dayGaps ?? 0)) noFlightsOn.add(`${a}>${b}@${d}`);
      }
    }
    const model = homeModel(
      home,
      {
        seed,
        ...FARES[v.fares],
        travelers,
        legRange: range(process.env.GATE_LEG_RANGE) ?? FARES[v.fares].legRange,
        homeRange: range(process.env.GATE_HOME_RANGE) ?? FARES[v.fares].homeRange,
        noFlights,
        noFlightsOn,
      },
      v.duffel,
    );

    const sim = createDuffelSim(seed);
    const asked = new Map<string, { origin: string; destination: string; date: string }>();
    mockedSearch.mockImplementation((p: any) => {
      const key = `${p.origin}|${p.destination}|${p.date}|${p.travelers}`;
      if (!asked.has(key)) asked.set(key, p);
      return sim.search(key, () => {
        let offers = model.offers(p);
        if (v.metroCap && (home.metros[p.origin] || home.metros[p.destination])) {
          offers = [...offers].sort((a, b) => a.price - b.price).slice(0, v.metroCap);
        }
        return offers;
      });
    });
    mockedInfo.mockClear();

    const { value: result, ms } = await sim.drive(() =>
      optimize({
        cities: cities.map((name, i) => ({ name, ...(v.countries ? { country: v.countries[i] } : {}) })),
        startDate: spec.startDate,
        travelers,
        origin: home.origin,
        originAirports: home.airports,
        returnToHome: true,
        totalNights: spec.totalNights,
      }),
    );

    const ranked = exhaustive(spec, model, CITY_CODES);
    const best = ranked[0];
    const chosen = priceExactly(spec, model, CITY_CODES, result.bestRoute.ordering);
    const ledger = mockedInfo.mock.calls.find(([m]) => m === 'Optimize flight searches')?.[1] as any;
    const classified: Record<Phase, number> = { 'inter-city': 0, home: 0, probe: 0 };
    for (const s of asked.values()) classified[classify(s, spec, home)]++;
    const homeFareDiff =
      (result.outboundLeg?.price ?? null) !== (chosen.outbound?.price ?? null) ||
      (result.outboundLeg ? result.outboundLeg.originAirport : null) !== (chosen.outbound?.airport ?? null) ||
      (result.returnLeg?.price ?? null) !== (chosen.ret?.price ?? null) ||
      (result.returnLeg ? result.returnLeg.destAirport : null) !== (chosen.ret?.airport ?? null);
    const testAirlineHome = [result.outboundLeg, result.returnLeg].some(
      (leg) => leg && isDuffelTestAirline({ carrier: leg.operator, carrierCode: leg.carrierCode }),
    );

    rows.push({
      same: result.bestRoute.ordering.join('|') === best.ordering.join('|'),
      miss: (chosen.rankCost - best.rankCost) / best.rankCost,
      requests: sim.stats.requests,
      rejected429: sim.stats.rejected429,
      searches: asked.size,
      byPhase: ledger?.byPhase ?? {},
      classified,
      rounds: ledger?.exactRounds ?? null,
      budgetStop: !!ledger?.budgetStop,
      ms,
      homeFareDiff,
      testAirlineHome,
      unpricedWinner: chosen.unpricedLegs > 0 && best.unpricedLegs === 0,
    });
  }

  const requests = rows.map((r) => r.requests);
  const rounds = rows.map((r) => r.rounds).filter((r): r is number => r !== null);
  const secs = rows.map((r) => r.ms / 1000);
  const phases = new Set(rows.flatMap((r) => Object.keys(r.byPhase)));
  const misses = rows.map((r) => r.miss);
  const differentMisses = rows.filter((r) => !r.same).map((r) => r.miss);
  return {
    variant: v.name,
    acceptance: !v.extra,
    trials: v.trials,
    identicalPct: round((100 * rows.filter((r) => r.same).length) / rows.length, 2),
    meanDearerPct: round(100 * mean(misses), 3),
    worstDearerPct: round(100 * Math.max(0, ...misses), 2),
    meanDearerWhenDifferentPct: differentMisses.length ? round(100 * mean(differentMisses), 2) : 0,
    winnerUnpricedWhenExhaustiveIsNot: rows.filter((r) => r.unpricedWinner).length,
    requests: {
      mean: round(mean(requests), 1),
      p50: percentile(requests, 0.5),
      p95: percentile(requests, 0.95),
      max: Math.max(...requests),
      over42Pct: round((100 * requests.filter((s) => s > 42).length) / rows.length, 1),
      over45Pct: round((100 * requests.filter((s) => s > 45).length) / rows.length, 1),
    },
    stalledPct: round((100 * rows.filter((r) => r.rejected429 > 0).length) / rows.length, 1),
    searchesMean: round(mean(rows.map((r) => r.searches)), 1),
    byPhaseMean: Object.fromEntries([...phases].map((p) => [p, round(mean(rows.map((r) => r.byPhase[p] ?? 0)), 2)])),
    classifiedMean: {
      'inter-city': round(mean(rows.map((r) => r.classified['inter-city'])), 2),
      home: round(mean(rows.map((r) => r.classified.home)), 2),
      probe: round(mean(rows.map((r) => r.classified.probe)), 2),
    },
    exactRounds: rounds.length ? { mean: round(mean(rounds), 2), p95: percentile(rounds, 0.95), max: Math.max(...rounds) } : null,
    budgetStopPct: round((100 * rows.filter((r) => r.budgetStop).length) / rows.length, 1),
    modelledSeconds: {
      mean: round(mean(secs), 1),
      p50: round(percentile(secs, 0.5), 1),
      p95: round(percentile(secs, 0.95), 1),
      max: round(Math.max(...secs), 1),
    },
    homeFareNotCheapestOfAllAirports: rows.filter((r) => r.homeFareDiff).length,
    testAirlineOnHomeCard: rows.filter((r) => r.testAirlineHome).length,
  };
}

const only = process.env.GATE_ONLY?.split(',');

it(`quality gate — ${label}`, async () => {
  const results = [];
  for (const v of VARIANTS) {
    if (only && !only.includes(v.name)) continue;
    const started = Date.now();
    const r = await runVariant(v);
    results.push(r);
    process.stdout.write(`${JSON.stringify({ ...r, seconds: round((Date.now() - started) / 1000, 1) })}\n`);
  }
  const out = path.join(__dirname, 'results', 'budget', `gate-${resultTag}${only ? `-${only.join('+')}` : ''}.json`);
  fs.writeFileSync(out, `${JSON.stringify({ label, baseline, trialsPerVariant: T, results }, null, 2)}\n`);
});
