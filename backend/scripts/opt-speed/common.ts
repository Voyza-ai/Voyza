/// <reference types="jest" />
/**
 * Shared pieces of the optimizer speed harness: trip setups, the fare model
 * wiring, request classification and small stats helpers.
 */

import { createFareModel, tripDates, type FareModel, type FareModelOptions, type TripSpec } from '../../src/tests/helpers/fareModel';

export const CITY_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
export const CITY_CODES: Record<string, string> = {
  Alpha: 'ZQA',
  Bravo: 'ZQB',
  Charlie: 'ZQC',
  Delta: 'ZQD',
  Echo: 'ZQE',
  Chicago: 'CHI',
  'New York': 'NYC',
  London: 'LON',
  Boston: 'BOS',
};

/** A home setup: what the user passes, and what Duffel's metro search covers. */
export type HomeSetup = {
  origin: string;
  /** The user's airports, as optimize() receives them. */
  airports: string[];
  /** Metro code → every airport Duffel's city search answers for (may include more than the user's). */
  metros: Record<string, string[]>;
};

export const HOMES: Record<string, HomeSetup> = {
  // 2-airport metro.
  CHI: { origin: 'Chicago', airports: ['ORD', 'MDW'], metros: { CHI: ['ORD', 'MDW'] } },
  // 3-airport metro.
  NYC: { origin: 'New York', airports: ['JFK', 'LGA', 'EWR'], metros: { NYC: ['JFK', 'LGA', 'EWR'] } },
  // 3 of London's 6: City, Southend and Luton answer the metro search too.
  LON: { origin: 'London', airports: ['LHR', 'LGW', 'STN'], metros: { LON: ['LHR', 'LGW', 'STN', 'LTN', 'LCY', 'SEN'] } },
  // No metro code: searched per airport.
  BOS: { origin: 'Boston', airports: ['BOS', 'PVD'], metros: {} },
};

export function homeModel(
  home: HomeSetup,
  opts: Omit<FareModelOptions, 'cityCodes' | 'homeAirports' | 'metros'>,
): FareModel {
  const all = new Set([...home.airports, ...Object.values(home.metros).flat()]);
  return createFareModel({ ...opts, cityCodes: CITY_CODES, homeAirports: [...all], metros: home.metros });
}

export type Phase = 'inter-city' | 'home' | 'probe';

/**
 * What a search was for, from the search alone: any day the trip does not
 * travel is the date-shift probe; one end at home is a home flight; the rest
 * are inter-city legs. Works for the dev optimizer too, which has no ledger.
 */
export function classify(
  s: { origin: string; destination: string; date: string },
  spec: TripSpec,
  home: HomeSetup,
): Phase {
  const d = tripDates(spec);
  const planDays = new Set([d.outbound, ...d.legs, d.ret]);
  if (!planDays.has(s.date)) return 'probe';
  const homeCodes = new Set([...home.airports, ...Object.keys(home.metros)]);
  if (homeCodes.has(s.origin) || homeCodes.has(s.destination)) return 'home';
  return 'inter-city';
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export const mean = (values: number[]) => (values.length ? values.reduce((s, v) => s + v, 0) / values.length : NaN);
export const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

export const baseline = !!process.env.OPT_SPEED_BASELINE;
export const label = baseline ? 'before (dev 332b564)' : 'after';
