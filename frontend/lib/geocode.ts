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
 */

export type GeoPoint = { lat: number; lon: number };

const STORAGE_KEY = 'voyza.geo.v1';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const THROTTLE_MS = 1100;

function readCache(): Record<string, GeoPoint> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, GeoPoint>) {
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

async function fetchFromNominatim(name: string): Promise<GeoPoint | null> {
  const url = `${NOMINATIM}?format=json&limit=1&accept-language=en&q=${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  const rows: any = await res.json();
  const hit = Array.isArray(rows) ? rows[0] : null;
  if (!hit?.lat || !hit?.lon) return null;
  const lat = parseFloat(hit.lat);
  const lon = parseFloat(hit.lon);
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { lat, lon };
}

/**
 * Resolve one city name to coordinates. Returns null when the geocoder has
 * no answer (the map simply skips that pin — no invented locations).
 */
export async function geocodeCity(name: string): Promise<GeoPoint | null> {
  const key = normalize(name);
  if (!key) return null;

  const cache = readCache();
  if (cache[key]) return cache[key];

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
}

/**
 * Geocode a list of city names, preserving order. Cached names resolve
 * instantly; uncached ones stream in at ~1/second (Nominatim's limit).
 * Result array aligns with the input; failures are null.
 */
export async function geocodeCities(names: string[]): Promise<(GeoPoint | null)[]> {
  return Promise.all(names.map((n) => geocodeCity(n)));
}
