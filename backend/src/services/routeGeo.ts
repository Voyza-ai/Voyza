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

export type CityGeo = { name: string; lat: number; lon: number; country: string };

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
      out = { name, lat: place.lat, lon: place.lon, country: String(place.country ?? '') };
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
