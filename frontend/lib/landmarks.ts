/**
 * A city's best-known landmarks — the Eiffel Tower, the Louvre, Big Ben — for
 * the city guide's hotel map, so a hotel's position reads against places the
 * traveller knows.
 *
 * Source: Wikidata, which every landmark worth naming is in. "Best-known" is
 * how many Wikipedia language editions have an article on it (sitelinks): the
 * Eiffel Tower has 191, a neighbourhood carousel none. Measured 2026-11-19 at
 * 8 km around the centre, this gave Paris → Eiffel Tower, Louvre, Notre-Dame,
 * Orsay, Arc de Triomphe; London → British Museum, Buckingham Palace,
 * Westminster Abbey, Big Ben, Tower of London; Kyoto → Kiyomizu-dera,
 * Kinkaku-ji, Fushimi Inari. The map's own tiles were no use for this: their
 * attraction points only exist at street zoom and are ranked within a tile,
 * so a carousel outranked the Louvre.
 *
 * The query keeps places someone can stand in front of: a protected heritage
 * site, something with a recorded height (towers, wheels, bridges), or a
 * museum. It leaves out what Wikidata also pins to a point — the city itself
 * and its districts (they have a population), events and things that no
 * longer stand (they have an end date), artworks (they belong to a
 * collection; the Venus de Milo is in the Louvre, not beside it), airports
 * (an IATA code) and stations (a line they connect to).
 *
 * Speed: filtering every place within 8 km took 5-12 s for Paris, on
 * Wikidata's side and on every repeat. The filters now run over the 80
 * best-known places only, picked first by the spatial index: 0.6-2.2 s for
 * Paris, London, Kyoto, Lisbon, Rome and New York, with the same landmarks.
 * The guide starts the lookup when a city is opened (`prefetchLandmarks`), so
 * the answer is usually in before "Open map" is clicked, and each city is
 * then kept in localStorage for 30 days.
 *
 * The public endpoint limits each address. A refusal (429/503) is retried
 * once after the wait it asks for; a failure is not kept, and the map simply
 * shows no landmarks until the next try.
 */

import type { GeoPoint } from './geocode';
import { geocodeTripCities } from './geocode';

export type Landmark = { id: string; name: string; point: GeoPoint; sitelinks: number };

const ENDPOINT = 'https://query.wikidata.org/sparql';
const STORAGE_KEY = 'voyza.landmarks.v1';
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;
/** How far from the centre a landmark may be, in km. */
export const LANDMARK_RADIUS_KM = 8;
/** Below this many Wikipedia editions a place is not a landmark a visitor would know. */
export const MIN_SITELINKS = 20;
/** Landmarks drawn per city. */
export const LANDMARK_LIMIT = 8;

/** Best-known places near the centre that the landmark filters then run over. */
const CANDIDATES = 80;

export function landmarkQuery(centre: GeoPoint): string {
  return `SELECT ?item ?itemLabel ?coord ?links WHERE {
  { SELECT ?item ?coord ?links WHERE {
      SERVICE wikibase:around { ?item wdt:P625 ?coord. bd:serviceParam wikibase:center "Point(${centre.lon} ${centre.lat})"^^geo:wktLiteral. bd:serviceParam wikibase:radius "${LANDMARK_RADIUS_KM}". }
      ?item wikibase:sitelinks ?links. FILTER(?links >= ${MIN_SITELINKS})
    } ORDER BY DESC(?links) LIMIT ${CANDIDATES} }
  FILTER(EXISTS { ?item wdt:P1435 [] } || EXISTS { ?item wdt:P2048 [] } || EXISTS { ?item wdt:P31 wd:Q33506 } || EXISTS { ?item wdt:P31 wd:Q207694 })
  FILTER NOT EXISTS { ?item wdt:P576 [] }
  FILTER NOT EXISTS { ?item wdt:P1082 [] }
  FILTER NOT EXISTS { ?item wdt:P195 [] }
  FILTER NOT EXISTS { ?item wdt:P238 [] }
  FILTER NOT EXISTS { ?item wdt:P81 [] }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?links) LIMIT 30`;
}

/** "Point(2.2945 48.8584)" → { lat, lon }. */
function parsePoint(wkt: string): GeoPoint | null {
  const m = /Point\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(wkt);
  if (!m) return null;
  const lon = Number(m[1]);
  const lat = Number(m[2]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** The SPARQL answer as landmarks: one per item, named in English, best-known first. */
export function parseLandmarks(json: any, limit = LANDMARK_LIMIT): Landmark[] {
  const rows: any[] = json?.results?.bindings ?? [];
  const out: Landmark[] = [];
  const seen = new Set<string>();
  for (const b of rows) {
    const id = String(b?.item?.value ?? '').split('/').pop() ?? '';
    const name = String(b?.itemLabel?.value ?? '').trim();
    const point = parsePoint(String(b?.coord?.value ?? ''));
    const sitelinks = Number(b?.links?.value);
    // An item with no English label comes back labelled with its own id.
    if (!id || seen.has(id) || !name || /^Q\d+$/.test(name) || !point) continue;
    seen.add(id);
    out.push({ id, name, point, sitelinks: Number.isFinite(sitelinks) ? sitelinks : 0 });
  }
  return out.sort((a, b) => b.sitelinks - a.sitelinks).slice(0, limit);
}

/** Cache key: the centre to ~1 km, so the same city from two lookups shares it. */
const cacheKey = (c: GeoPoint) => `${c.lat.toFixed(2)},${c.lon.toFixed(2)}`;

function readCache(): Record<string, { at: number; items: Landmark[] }> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, { at: number; items: Landmark[] }>) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked: the next map asks again.
  }
}

const inFlight = new Map<string, Promise<Landmark[]>>();

/** Longest wait a refusal's Retry-After is honoured for before the one retry. */
const MAX_RETRY_WAIT_MS = 8000;
const RETRY_DEFAULT_MS = 2000;

/** Seconds (or an HTTP date) from Retry-After, as ms, capped. */
export function retryWaitMs(header: string | null | undefined, now = Date.now()): number {
  if (!header) return RETRY_DEFAULT_MS;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, MAX_RETRY_WAIT_MS) : RETRY_DEFAULT_MS;
}

/** The landmarks around a city centre, best-known first. Never throws: no answer is []. */
export function fetchLandmarks(
  centre: GeoPoint,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<Landmark[]> {
  const key = cacheKey(centre);
  const hit = readCache()[key];
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.items);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(landmarkQuery(centre))}`;
  const ask = async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetchImpl(url, { headers: { Accept: 'application/sparql-results+json' }, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const task = (async () => {
    try {
      let res = await ask();
      if (res.status === 429 || res.status === 503) {
        await new Promise((r) => setTimeout(r, retryWaitMs(res.headers?.get?.('Retry-After'))));
        res = await ask();
      }
      if (!res.ok) return [];
      const items = parseLandmarks(await res.json());
      // An empty answer is kept too: a city with no famous landmarks has
      // none tomorrow either. Only failures (above) are asked again.
      const cache = readCache();
      cache[key] = { at: Date.now(), items };
      writeCache(cache);
      return items;
    } catch {
      return [];
    }
  })();
  inFlight.set(key, task);
  task.finally(() => inFlight.delete(key));
  return task;
}

/** The point a city's hotel map is centred on — the same lookup the map makes, so they share a cache entry. */
export function cityCentre(city: { name: string; country?: string }): Promise<GeoPoint | null> {
  const scope = [city.name, city.country].filter(Boolean).join(', ');
  return geocodeTripCities([scope])
    .then((r) => r[0] ?? null)
    .catch(() => null);
}

/**
 * Start a city's landmark lookup ahead of its map. Called when the city guide
 * opens; by the time "Open map" is clicked the answer is usually cached.
 */
export function prefetchLandmarks(city: { name: string; country?: string }): void {
  void cityCentre(city).then((c) => (c ? fetchLandmarks(c) : undefined));
}
