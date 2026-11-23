/**
 * Geography for the chat's city edits: where to put a city, which order to
 * travel in, and whether a leg has a sensible flight at all.
 *
 * Production: on Prague → Munich → Vienna (home New York), "add another city
 * of your choice, I'm feeling Christmas vibes" put Salzburg right after
 * Prague — Prague → Salzburg → Munich → Vienna leaves Austria and comes back —
 * and priced Prague → Salzburg as a 22h 30m flight.
 *
 * Coordinates and countries come from the checked-in location index
 * (services/location), the same one that checks a city name.
 */
import { resolve } from './location/resolve';
import { originIndex } from './location/originAirports';
import { haversineKm } from './location/geo';

export type CityGeo = { name: string; lat: number; lon: number; country: string; admin?: string | null };

const cache = new Map<string, CityGeo | null>();

/** A city's coordinates and country, or null when the index can't place it. */
export function cityGeo(name: string, otherCities: string[] = []): CityGeo | null {
  const key = `${name.trim().toLowerCase()}|${otherCities.map((c) => c.toLowerCase()).sort().join(',')}`;
  if (cache.has(key)) return cache.get(key)!;
  let out: CityGeo | null = null;
  try {
    const r: any = resolve(name.trim(), { tripDestinationNames: otherCities }, originIndex());
    const place = r.status === 'resolved' ? r.place : r.status === 'ambiguous' ? r.candidates?.[0]?.place : null;
    if (place && Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
      out = { name, lat: place.lat, lon: place.lon, country: String(place.country ?? ''), admin: place.admin ?? null };
    }
  } catch {
    out = null;
  }
  cache.set(key, out);
  return out;
}

export const km = (a: CityGeo, b: CityGeo) => haversineKm({ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon });

/**
 * How many times the route leaves a country and comes back: the number of
 * same-country runs beyond one per country. Prague → Salzburg → Munich →
 * Vienna (CZ AT DE AT) = 1; Prague → Munich → Salzburg → Vienna = 0.
 */
export function countrySplits(countries: string[]): number {
  let runs = 0;
  countries.forEach((c, i) => {
    if (i === 0 || c !== countries[i - 1]) runs++;
  });
  return runs - new Set(countries).size;
}

/** Kilometres travelled: home → each city in order → home (home optional). */
export function routeKm(stops: CityGeo[], home: CityGeo | null, returnsHome = true): number {
  let total = 0;
  if (home && stops[0]) total += km(home, stops[0]);
  for (let i = 0; i < stops.length - 1; i++) total += km(stops[i], stops[i + 1]);
  if (home && returnsHome && stops.length > 0) total += km(stops[stops.length - 1], home);
  return total;
}

export type Insertion = { index: number; splits: number; extraKm: number };

/**
 * Every slot for a new city, best first: no country left and re-entered
 * where that can be avoided, then the fewest extra kilometres (flights from
 * and to home included). index = the new city's position in the new order.
 */
export function rankInsertions(stops: CityGeo[], added: CityGeo, home: CityGeo | null, returnsHome = true): Insertion[] {
  const base = routeKm(stops, home, returnsHome);
  const out: Insertion[] = [];
  for (let i = 0; i <= stops.length; i++) {
    const order = [...stops.slice(0, i), added, ...stops.slice(i)];
    out.push({ index: i, splits: countrySplits(order.map((s) => s.country)), extraKm: routeKm(order, home, returnsHome) - base });
  }
  return out.sort((a, b) => a.splits - b.splits || a.extraKm - b.extraKm);
}

/** The order with the least backtracking, then the least distance. Up to 8 cities. */
export function bestOrder(stops: CityGeo[], home: CityGeo | null, returnsHome = true): CityGeo[] {
  if (stops.length < 2 || stops.length > 8) return stops;
  let best = stops;
  let bestKey: [number, number] = [countrySplits(stops.map((s) => s.country)), routeKm(stops, home, returnsHome)];
  const permute = (rest: CityGeo[], acc: CityGeo[]) => {
    if (rest.length === 0) {
      const key: [number, number] = [countrySplits(acc.map((s) => s.country)), routeKm(acc, home, returnsHome)];
      if (key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1] - 0.5)) {
        best = acc;
        bestKey = key;
      }
      return;
    }
    rest.forEach((s, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, s]));
  };
  permute(stops, []);
  return best;
}

// ─── Is there a sensible flight at all? ───────────────────────────

/** Roughly how long a direct flight of this distance takes, airport to airport, in minutes. */
export function expectedFlightMinutes(distanceKm: number): number {
  return Math.round((distanceKm / 750) * 60 + 60);
}

/**
 * The relative long-journey rule (tripLegs.ts LONG_RATIO) compares options
 * with the leg's fastest — useless when EVERY flight is a 22h detour, which
 * is common on short hops with no direct service (Prague → Salzburg, 260 km:
 * the fastest Duffel flight took 22h 30m with 2 stops). Here the fastest is
 * compared with the distance: more than 3× a direct flight's time AND more
 * than 6 hours over it is no sensible flight. Transatlantic (≈ 6,800 km,
 * direct ≈ 10h) would need 30h+ to trip it; Prague → Salzburg trips at 7h.
 */
export function noSensibleFlight(fastestMinutes: number, distanceKm: number): boolean {
  if (!(fastestMinutes > 0) || !(distanceKm > 0)) return false;
  const direct = expectedFlightMinutes(distanceKm);
  return fastestMinutes > Math.max(direct * 3, direct + 360);
}

/**
 * Ground travel time as an ESTIMATE from distance, for a leg where the rail
 * search found no train (production has rail: All Aboard answered Prague →
 * Vienna with live ÖBB / České dráhy fares on 2026-11-23): road/rail
 * distance ≈ 1.3 × straight line, at 60–90 km/h.
 * Returned as whole hours, low–high. Never a price.
 */
export function groundEstimateHours(distanceKm: number): [number, number] {
  const ground = distanceKm * 1.3;
  const low = Math.max(1, Math.round(ground / 90));
  const high = Math.max(low + 1, Math.round(ground / 60));
  return [low, high];
}

// ─── Nothing bookable: is the hop close and on one landmass? ───────────

/**
 * Countries that share a land border (and a road or rail crossing), for the
 * ground estimate on a leg where no train AND no flight was found. A pair not
 * listed — Tallinn → Helsinki, across the Gulf of Finland — gets no estimate.
 * Europe and North America; anywhere else, cross-border hops get none.
 */
const LAND_NEIGHBOURS: Record<string, string[]> = {
  PT: ['ES'], ES: ['PT', 'FR', 'AD', 'GI'], AD: ['ES', 'FR'], GI: ['ES'],
  FR: ['ES', 'AD', 'BE', 'LU', 'DE', 'CH', 'IT', 'MC'], MC: ['FR'],
  BE: ['FR', 'LU', 'DE', 'NL'], NL: ['BE', 'DE'], LU: ['BE', 'FR', 'DE'],
  DE: ['DK', 'NL', 'BE', 'LU', 'FR', 'CH', 'AT', 'CZ', 'PL'], DK: ['DE', 'SE'],
  CH: ['FR', 'DE', 'AT', 'LI', 'IT'], LI: ['CH', 'AT'], AT: ['DE', 'CZ', 'SK', 'HU', 'SI', 'IT', 'CH', 'LI'],
  IT: ['FR', 'CH', 'AT', 'SI', 'SM', 'VA'], SM: ['IT'], VA: ['IT'],
  CZ: ['DE', 'PL', 'SK', 'AT'], PL: ['DE', 'CZ', 'SK', 'UA', 'BY', 'LT'], SK: ['CZ', 'PL', 'UA', 'HU', 'AT'],
  HU: ['AT', 'SK', 'UA', 'RO', 'RS', 'HR', 'SI'], SI: ['IT', 'AT', 'HU', 'HR'],
  HR: ['SI', 'HU', 'RS', 'BA', 'ME'], BA: ['HR', 'RS', 'ME'], RS: ['HU', 'RO', 'BG', 'MK', 'XK', 'ME', 'BA', 'HR'],
  ME: ['HR', 'BA', 'RS', 'XK', 'AL'], XK: ['RS', 'ME', 'AL', 'MK'], AL: ['ME', 'XK', 'MK', 'GR'],
  MK: ['RS', 'XK', 'AL', 'GR', 'BG'], GR: ['AL', 'MK', 'BG', 'TR'], BG: ['RO', 'RS', 'MK', 'GR', 'TR'],
  RO: ['HU', 'UA', 'MD', 'BG', 'RS'], MD: ['RO', 'UA'], UA: ['PL', 'SK', 'HU', 'RO', 'MD', 'BY'],
  BY: ['PL', 'LT', 'LV', 'UA'], LT: ['LV', 'BY', 'PL'], LV: ['EE', 'LT', 'BY'], EE: ['LV'],
  SE: ['NO', 'FI', 'DK'], NO: ['SE', 'FI'], FI: ['SE', 'NO'], TR: ['GR', 'BG'],
  US: ['CA', 'MX'], CA: ['US'], MX: ['US'],
};

/**
 * Countries made of many islands, where a short hop is often across water
 * (Athens → Mykonos): no estimate inside them.
 */
const ARCHIPELAGOS = new Set(['GR', 'ID', 'PH', 'JP', 'NZ', 'MT', 'BS', 'FJ', 'MV']);

/**
 * Island regions inside a mainland country, by GeoNames admin1 code: a hop
 * into or out of one, or between two places in one (Palma → Ibiza), is across
 * water. Northern Ireland is here so Belfast → London gets none, while
 * Belfast → Dublin (GB-NIR ↔ IE) still can.
 */
const SEA_REGIONS = new Set([
  'ES-07', 'ES-53', 'ES-CE', 'ES-ML', // Balearics, Canaries, Ceuta, Melilla
  'IT-14', 'IT-15', // Sardinia, Sicily
  'FR-94', // Corsica
  'PT-10', 'PT-20', 'PT-23', // Madeira, Azores
  'US-HI', 'US-AK',
  'CA-05', // Newfoundland and Labrador
  'GB-NIR', // Northern Ireland: by land only to the Republic of Ireland
]);

/** Smaller islands inside a mainland region (Capri is Campania): centre and radius. */
const ISLANDS: { lat: number; lon: number; km: number }[] = [
  { lat: 40.55, lon: 14.23, km: 8 }, // Capri
  { lat: 40.73, lon: 13.9, km: 9 }, // Ischia / Procida
  { lat: 42.78, lon: 10.28, km: 16 }, // Elba
  { lat: 38.5, lon: 14.9, km: 30 }, // Aeolian Islands
  { lat: 43.17, lon: 16.6, km: 30 }, // Hvar / Brač
  { lat: 42.95, lon: 16.9, km: 25 }, // Korčula
  { lat: 50.68, lon: -1.3, km: 22 }, // Isle of Wight
  { lat: 59.1, lon: -3.0, km: 60 }, // Orkney
  { lat: 60.3, lon: -1.2, km: 80 }, // Shetland
  { lat: 57.9, lon: -6.9, km: 110 }, // Outer Hebrides
  { lat: 55.12, lon: 14.9, km: 30 }, // Bornholm
  { lat: 57.5, lon: 18.5, km: 75 }, // Gotland
  { lat: 58.4, lon: 22.5, km: 50 }, // Saaremaa
  { lat: 49.6, lon: -125.5, km: 260 }, // Vancouver Island
];

/** Farther than this and "no train or flight found" is not a hop to estimate. */
export const GROUND_ESTIMATE_MAX_KM = 500;

function overWater(c: CityGeo): boolean {
  if (ARCHIPELAGOS.has(c.country)) return true;
  if (c.admin && SEA_REGIONS.has(`${c.country}-${c.admin}`)) return true;
  return ISLANDS.some((i) => haversineKm({ lat: c.lat, lon: c.lon }, { lat: i.lat, lon: i.lon }) <= i.km);
}

/**
 * Can this hop be made over land, so a distance-based estimate is honest?
 * Close (≤ 500 km), neither end on an island or archipelago, and the same
 * country or two countries with a land border. Lisbon → Sintra: yes.
 * Barcelona → Palma, Tallinn → Helsinki, Naples → Capri, Lisbon → Berlin: no.
 */
export function groundReachable(a: CityGeo, b: CityGeo): boolean {
  if (km(a, b) > GROUND_ESTIMATE_MAX_KM) return false;
  if (overWater(a) || overWater(b)) {
    // Belfast → Dublin crosses a land border; any other hop off an island doesn't.
    const irish = (x: CityGeo, y: CityGeo) => x.country === 'GB' && x.admin === 'NIR' && (y.country === 'IE' || (y.country === 'GB' && y.admin === 'NIR'));
    return irish(a, b) || irish(b, a);
  }
  if (a.country === b.country) return true;
  return (LAND_NEIGHBOURS[a.country] ?? []).includes(b.country);
}

/**
 * Door-to-door time by train or bus as an ESTIMATE from distance, in
 * minutes, low–high: route ≈ 1.3 × straight line at 60–90 km/h, plus 15 min
 * to get to and from stations. Lisbon → Sintra (≈ 22 km): 35–45 min.
 * Rounded to 5 min under two hours, to the hour above. Never a price.
 */
export function groundEstimateMinutes(distanceKm: number): [number, number] {
  const route = distanceKm * 1.3;
  const raw: [number, number] = [(route / 90) * 60 + 15, (route / 60) * 60 + 15];
  const round = (m: number) => (m < 120 ? Math.max(5, Math.round(m / 5) * 5) : Math.round(m / 60) * 60);
  const low = round(raw[0]);
  const high = Math.max(round(raw[1]), low + (low < 120 ? 5 : 60));
  return [low, high];
}

/** The estimate for a hop where nothing bookable was found, or null when it can't be estimated honestly. */
export function groundEstimateFor(from: string, to: string, tripCityNames: string[] = [from, to]): { minutes: [number, number]; km: number } | null {
  const a = cityGeo(from, tripCityNames);
  const b = cityGeo(to, tripCityNames);
  if (!a || !b || !groundReachable(a, b)) return null;
  const d = km(a, b);
  return { minutes: groundEstimateMinutes(d), km: Math.round(d) };
}
