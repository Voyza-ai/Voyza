/**
 * City-name → lat/lng geocoding for the Map tab.
 *
 * Trips only carry city NAMES ("Florence"), no coordinates. We resolve them
 * via Nominatim (OpenStreetMap's free geocoder — no API key) and cache every
 * answer in localStorage, so each city is geocoded at most once per browser
 * and the map is instant afterwards. Real lookups, nothing hardcoded.
 *
 * Nominatim usage policy: max 1 request/second — uncached lookups are run
 * through a small sequential queue with a delay between requests.
 *
 * The trip's own cities skip that queue whenever the location resolver knows
 * them — see geocodeTripCities.
 */

import { resolveLocation } from './locationResolver';

export type GeoPoint = { lat: number; lon: number };

/**
 * A geocoded place plus OSM's own categorisation of it. `osmClass`/`osmType`
 * are what let callers tell a museum from a bike tour without guessing at the
 * user's wording (see lib/citySpots).
 */
export type GeoPlace = GeoPoint & { osmClass?: string; osmType?: string };

const STORAGE_KEY = 'voyza.geo.v1';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const THROTTLE_MS = 1100;

function readCache(): Record<string, GeoPlace> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, GeoPlace>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full / privacy mode — worst case we geocode again next visit.
  }
}

const normalize = (name: string) => name.trim().toLowerCase();

// Serialize uncached requests: each waits for the previous + throttle gap.
let queueTail: Promise<unknown> = Promise.resolve();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Share a lookup already in flight for the same key instead of starting a
 * second one. The Map tab asks for its pins twice at once (its effect
 * re-runs), and a name nobody could answer was never cached, so it went to
 * our resolver twice and to Nominatim twice — the second 1.1 s later in the
 * queue (integrated run, 2026-10-30: Interlaken, and London and Moscow as
 * ambiguous home pins). The entry goes when the lookup settles, so a later
 * call asks again, exactly as before.
 */
function shareInFlight<T>(inflight: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = run();
  inflight.set(key, task);
  const settle = () => {
    if (inflight.get(key) === task) inflight.delete(key);
  };
  task.then(settle, settle);
  return task;
}

const geocodesInFlight = new Map<string, Promise<GeoPlace | null>>();

async function fetchFromNominatim(name: string): Promise<GeoPlace | null> {
  const url = `${NOMINATIM}?format=json&limit=1&accept-language=en&q=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const rows: any = await res.json();
  const hit = Array.isArray(rows) ? rows[0] : null;
  if (!hit?.lat || !hit?.lon) return null;
  const lat = parseFloat(hit.lat);
  const lon = parseFloat(hit.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  // `class`/`type` are OSM's own categorisation (tourism/museum,
  // historic/monument, aeroway/aerodrome…). Far more reliable for deciding
  // what a place IS than guessing from the user's wording.
  return {
    lat,
    lon,
    osmClass: typeof hit.class === 'string' ? hit.class : undefined,
    osmType: typeof hit.type === 'string' ? hit.type : undefined,
  };
}

/**
 * Resolve one city name to coordinates. Returns null when the geocoder has
 * no answer (the map simply skips that pin — no invented locations).
 */
export async function geocodeCity(name: string): Promise<GeoPlace | null> {
  const key = normalize(name);
  if (!key) return null;

  const cache = readCache();
  if (cache[key]) return cache[key];

  return shareInFlight(geocodesInFlight, key, () => {
    // Chain onto the queue so parallel callers stay within the rate limit.
    const task = queueTail.then(async () => {
      // Another caller may have resolved + cached it while we waited.
      const fresh = readCache();
      if (fresh[key]) return fresh[key];
      const point = await fetchFromNominatim(name).catch(() => null);
      await sleep(THROTTLE_MS);
      if (point) {
        const updated = readCache();
        updated[key] = point;
        writeCache(updated);
      }
      return point;
    });
    // Keep the chain alive even when a lookup fails.
    queueTail = task.catch(() => undefined);
    return task;
  });
}

/**
 * Geocode a list of city names, preserving order. Cached names resolve
 * instantly; uncached ones stream in at ~1/second (Nominatim's limit).
 * Result array aligns with the input; failures are null.
 */
export async function geocodeCities(names: string[]): Promise<(GeoPlace | null)[]> {
  return Promise.all(names.map((n) => geocodeCity(n)));
}

// Resolver answers already fetched this page load, so re-rendering the map
// (any trip edit rebuilds its name list) doesn't ask the server again.
const resolvedThisLoad = new Map<string, GeoPoint>();
const resolvesInFlight = new Map<string, Promise<GeoPoint | null>>();

async function fromLocationResolver(name: string): Promise<GeoPoint | null> {
  const key = normalize(name);
  const known = resolvedThisLoad.get(key);
  if (known) return known;
  return shareInFlight(resolvesInFlight, key, async () => {
    // Hot set offline, else one in-memory lookup on our own server. Never
    // throws: a failed request comes back `unknown`.
    const answer = await resolveLocation(name);
    if (answer.status !== 'resolved') return null;
    const point = { lat: answer.place.lat, lon: answer.place.lon };
    resolvedThisLoad.set(key, point);
    return point;
  });
}

/**
 * Coordinates for the TRIP's own places — the home city and each stop — for
 * the Map tab's pins. The location resolver first, Nominatim only for what
 * it cannot answer.
 *
 * Why: every uncached city went through Nominatim one at a time, 1.1 s apart
 * (its usage policy), so a cold Map tab waited ~1.1 s per pin before showing
 * any (audit D-12: 7.3 s measured). The resolver's artifact already holds
 * coordinates for 36,009 places: the browser's hot set answers the common
 * ones with no request at all, and `/api/locations/resolve` the rest in one
 * in-memory lookup each, all in parallel and outside the general rate limit.
 *
 * Only a `resolved` answer is used. An ambiguous name (`Portland`, and —
 * measured — `Amsterdam, Netherlands`) or an unknown one falls through to
 * the same Nominatim lookup as before, as does any network failure. A pin
 * this browser already cached from Nominatim keeps its place.
 *
 * Measured against Nominatim for the demo cities, as the map asks for them:
 * 0.03-2.4 km apart (Paris 0.03, Vienna 0.03, Prague 0.07, Venice 0.15,
 * London 0.18, Zurich 1.1, Florence 1.3, Berlin 1.3, Barcelona 1.7,
 * Lisbon 2.2, Rome 2.4), invisible at trip zoom. The outlier is Budapest at
 * 8 km, where Nominatim pins the administrative centroid out in Kőbánya and
 * the resolver the centre on the Danube.
 *
 * Deliberately NOT used for sights, hotels and day trips (lib/citySpots):
 * those decide what a hit IS from OSM's class/type, which the resolver does
 * not carry, and a spot query like "Versailles, France" would otherwise
 * resolve to the town it is named after.
 */
export async function geocodeTripCities(names: string[]): Promise<(GeoPlace | null)[]> {
  return Promise.all(
    names.map(async (name) => {
      const cached = readCache()[normalize(name)];
      if (cached) return cached;
      return (await fromLocationResolver(name)) ?? geocodeCity(name);
    }),
  );
}
