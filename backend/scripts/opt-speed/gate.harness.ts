/// <reference types="jest" />
/**
 * Quality gate for the adaptive screen: thousands of random trips through the
 * REAL optimize(), flights mocked by the fare model, each compared with
 * pricing every ordering (helpers/fareModel.ts `exhaustive`).
 *
 * Required: ≥ 99.5% identical winner and worst miss ≤ 1% at ±30% per-date
 * fare swing, 4 and 5 cities, 2- and 3-airport home metros. Also reported:
 * ±50%, Duffel searches per trip by phase, exact rounds, how often a trip
 * would overflow one rate-limit window, and whether the metro home search
 * changes the home fare a trip gets.
 *
 *   npx jest -c scripts/opt-speed/jest.config.js gate
 *   GATE_TRIALS=200 GATE_ONLY=5c-CHI-30 npx jest -c scripts/opt-speed/jest.config.js gate
 *   OPT_SPEED_BASELINE=1 …  (the dev optimizer: must be 100% identical — a harness check)
 *
 * "Searches" = distinct (route, date, party) asked of searchFlights in one
 * cold run: flights.ts dedupes repeats, so each is one Duffel request.
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
import { searchFlights } from '../../src/services/flights';
import { logger } from '../../src/utils/logger';
import { exhaustive, priceExactly, type TripSpec } from '../../src/tests/helpers/fareModel';
import { CITY_CODES, CITY_NAMES, HOMES, baseline, classify, homeModel, label, mean, percentile, round, type Phase } from './common';

const { optimize } = baseline
  ? (require('./baseline/optimizer.dev') as typeof import('../../src/services/optimizer'))
  : (require('../../src/services/optimizer') as typeof import('../../src/services/optimizer'));

const mockedSearch = searchFlights as jest.Mock;
const mockedInfo = logger.info as jest.Mock;

type Variant = {
  name: string;
  cities: number;
  swing: number;
  home: keyof typeof HOMES;
  trials: number;
  /** Countries per city (production-shaped clustering); omitted → none known. */
  countries?: string[];
  /** Chance that a route has no flight on one particular day. */
  dayGaps?: number;
  /** Chance that a route has no flight on any day. */
  routeGaps?: number;
  /** Duffel returns at most this many offers per metro search (cheapest first). */
  metroCap?: number;
};

const T = Number(process.env.GATE_TRIALS ?? 1000);
const VARIANTS: Variant[] = [
  // The gate itself.
  { name: '4c-CHI-30', cities: 4, swing: 0.3, home: 'CHI', trials: T },
  { name: '4c-NYC-30', cities: 4, swing: 0.3, home: 'NYC', trials: T },
  { name: '5c-CHI-30', cities: 5, swing: 0.3, home: 'CHI', trials: T },
  { name: '5c-NYC-30', cities: 5, swing: 0.3, home: 'NYC', trials: T },
  // Fares moving more than the screen assumes.
  { name: '4c-CHI-50', cities: 4, swing: 0.5, home: 'CHI', trials: T },
  { name: '5c-CHI-50', cities: 5, swing: 0.5, home: 'CHI', trials: T },
  { name: '5c-NYC-50', cities: 5, swing: 0.5, home: 'NYC', trials: T },
  // Production-shaped: Porto, Seville, Valencia, Marseille, Turin (ES twice).
  { name: '5c-CHI-30-clustered', cities: 5, swing: 0.3, home: 'CHI', trials: Math.ceil(T / 2), countries: ['PT', 'ES', 'ES', 'FR', 'IT'] },
  // Other homes: extra airports in the metro, and no metro at all.
  { name: '5c-LON-30', cities: 5, swing: 0.3, home: 'LON', trials: Math.ceil(T / 2) },
  { name: '5c-BOS-30', cities: 5, swing: 0.3, home: 'BOS', trials: Math.ceil(T / 2) },
  // Missing flights: whole routes, and routes missing on single days.
  { name: '5c-CHI-30-gaps', cities: 5, swing: 0.3, home: 'CHI', trials: Math.ceil(T / 2), routeGaps: 0.05, dayGaps: 0.05 },
  // Sensitivity: Duffel capping a metro search's offers.
  { name: '5c-LON-30-metrocap3', cities: 5, swing: 0.3, home: 'LON', trials: Math.ceil(T / 2), metroCap: 3 },
];

function unit(seed: number, key: string): number {
  let h = 0x811c9dc5 ^ seed;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

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
  const rows: Array<{
    same: boolean;
    miss: number;
    searches: number;
    byPhase: Record<string, number>;
    classified: Record<Phase, number>;
    rounds: number | null;
    sweeps: number;
    homeFareDiff: boolean;
    unpricedWinner: boolean;
  }> = [];

  for (let t = 0; t < v.trials; t++) {
    const seed = 10_000 * v.cities + Math.round(v.swing * 100) * 1000 + t;
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
    const model = homeModel(home, {
      seed,
      swing: v.swing,
      travelers,
      legRange: [50, 225],
      homeRange: [600, 1100],
      noFlights,
      noFlightsOn,
    });

    const asked = new Map<string, { origin: string; destination: string; date: string }>();
    mockedSearch.mockImplementation(async (p: any) => {
      const key = `${p.origin}|${p.destination}|${p.date}|${p.travelers}`;
      if (!asked.has(key)) asked.set(key, p);
      let offers = model.offers(p);
      if (v.metroCap && (home.metros[p.origin] || home.metros[p.destination])) {
        offers = [...offers].sort((a, b) => a.price - b.price).slice(0, v.metroCap);
      }
      return offers;
    });
    mockedInfo.mockClear();

    const result = await optimize({
      cities: cities.map((name, i) => ({ name, ...(v.countries ? { country: v.countries[i] } : {}) })),
      startDate: spec.startDate,
      travelers,
      origin: home.origin,
      originAirports: home.airports,
      returnToHome: true,
      totalNights: spec.totalNights,
    });

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

    rows.push({
      same: result.bestRoute.ordering.join('|') === best.ordering.join('|'),
      miss: (chosen.rankCost - best.rankCost) / best.rankCost,
      searches: asked.size,
      byPhase: ledger?.byPhase ?? {},
      classified,
      rounds: ledger?.exactRounds ?? null,
      sweeps: ledger?.sweeps ?? 0,
      homeFareDiff,
      unpricedWinner: chosen.unpricedLegs > 0 && best.unpricedLegs === 0,
    });
  }

  const searches = rows.map((r) => r.searches);
  const rounds = rows.map((r) => r.rounds).filter((r): r is number => r !== null);
  const phases = new Set(rows.flatMap((r) => Object.keys(r.byPhase)));
  const misses = rows.filter((r) => !r.same).map((r) => r.miss);
  return {
    variant: v.name,
    trials: v.trials,
    identicalPct: round((100 * rows.filter((r) => r.same).length) / rows.length, 2),
    worstMissPct: round(100 * Math.max(0, ...rows.map((r) => r.miss)), 2),
    meanMissWhenDifferentPct: misses.length ? round(100 * mean(misses), 2) : 0,
    winnerUnpricedWhenExhaustiveIsNot: rows.filter((r) => r.unpricedWinner).length,
    searches: {
      mean: round(mean(searches), 1),
      p50: percentile(searches, 0.5),
      p95: percentile(searches, 0.95),
      max: Math.max(...searches),
      over40Pct: round((100 * searches.filter((s) => s > 40).length) / rows.length, 1),
      over45Pct: round((100 * searches.filter((s) => s > 45).length) / rows.length, 1),
    },
    byPhaseMean: Object.fromEntries([...phases].map((p) => [p, round(mean(rows.map((r) => r.byPhase[p] ?? 0)), 2)])),
    classifiedMean: {
      'inter-city': round(mean(rows.map((r) => r.classified['inter-city'])), 2),
      home: round(mean(rows.map((r) => r.classified.home)), 2),
      probe: round(mean(rows.map((r) => r.classified.probe)), 2),
    },
    exactRounds: rounds.length
      ? { mean: round(mean(rounds), 2), p95: percentile(rounds, 0.95), max: Math.max(...rounds) }
      : null,
    trialsWithSweep: rows.filter((r) => r.sweeps > 0).length,
    homeFareDifferentFromPerAirport: rows.filter((r) => r.homeFareDiff).length,
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
  const out = path.join(__dirname, 'results', `gate-${baseline ? 'before' : 'after'}${only ? `-${only.join('+')}` : ''}.json`);
  fs.writeFileSync(out, `${JSON.stringify({ label, trialsPerVariant: T, results }, null, 2)}\n`);
});
