import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { haversineKm } from '../location/geo';
import { originIndex } from '../location/originAirports';
import { resolve } from '../location/resolve';
import { TtlCache } from './cache';
import { foursquareProvider, googlePlacesProvider, nominatimProvider } from './providers';
import { normalizeKey, queriesFor } from './query';
import type { LatLng, PlaceRequestItem, PoiHit, PoiProvider, ResolvedPlace } from './types';

export * from './types';
export { createThrottle } from './throttle';

/**
 * POI resolution for the day planner.
 *
 * `resolvePlaces` answers within a caller-chosen deadline. Whatever is still
 * in flight when it passes keeps running and lands in the cache, so the next
 * call (the client's follow-up, or the next traveller to plan the same city)
 * gets it instantly. That is how a keyless Nominatim run — one lookup a
 * second, shared by the whole process — still never holds a request open
 * longer than the deadline.
 */

/** A hit further than this from the city centre is treated as a wrong match. */
export const MAX_PLACE_KM = 40;

const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;

/** Parallel lookups for the keyed providers (Nominatim is serial regardless). */
const KEYED_CONCURRENCY = 6;

type Cached = { lat: number; lng: number; placeId: string } | null;

let providerOverride: PoiProvider | null = null;
let memoProvider: PoiProvider | null = null;

/**
 * Google when its key is set, else Foursquare when its key is set, else
 * keyless Nominatim. Read once per process.
 */
export function selectProvider(keys: {
  GOOGLE_PLACES_API_KEY?: string;
  FOURSQUARE_API_KEY?: string;
} = env): PoiProvider {
  if (keys.GOOGLE_PLACES_API_KEY) return googlePlacesProvider(keys.GOOGLE_PLACES_API_KEY);
  if (keys.FOURSQUARE_API_KEY) return foursquareProvider(keys.FOURSQUARE_API_KEY);
  return nominatimProvider();
}

export function activeProvider(): PoiProvider {
  if (providerOverride) return providerOverride;
  if (!memoProvider) memoProvider = selectProvider();
  return memoProvider;
}

/** Item results, keyed by provider + city + the item's wording. */
const itemCache = new TtlCache<Cached>(5000);
/** City centres, same keying. */
const centreCache = new TtlCache<LatLng | null>(500);
/** Lookups in flight, so two callers asking for the same item share one. */
const inFlight = new Map<string, Promise<Cached>>();
const centresInFlight = new Map<string, Promise<LatLng | null>>();

/** Test seam: swap the provider and drop every cache. */
export function __setProviderForTests(p: PoiProvider | null): void {
  providerOverride = p;
  memoProvider = null;
  itemCache.clear();
  centreCache.clear();
  inFlight.clear();
  centresInFlight.clear();
  keyedActive = 0;
  keyedWaiters.length = 0;
}

const cityKey = (city: string, country?: string) =>
  `${normalizeKey(city)}|${normalizeKey(country ?? '')}`;

const itemKey = (provider: PoiProvider, city: string, country: string | undefined, item: PlaceRequestItem) =>
  `${provider.name}|${cityKey(city, country)}|${normalizeKey(item.name)}|${normalizeKey(item.placeQuery ?? '')}`;

// ─── Concurrency gate for keyed providers ───
let keyedActive = 0;
const keyedWaiters: Array<() => void> = [];
async function gate<T>(provider: PoiProvider, task: () => Promise<T>): Promise<T> {
  // Nominatim serialises inside its own throttle.
  if (provider.name === 'osm') return task();
  if (keyedActive >= KEYED_CONCURRENCY) await new Promise<void>((r) => keyedWaiters.push(r));
  keyedActive++;
  try {
    return await task();
  } finally {
    keyedActive--;
    keyedWaiters.shift()?.();
  }
}

/**
 * The city centre: the location resolver's artifact first (in-memory, no
 * request), the provider only for a city it does not know.
 */
export async function cityCentre(city: string, country?: string): Promise<LatLng | null> {
  const provider = activeProvider();
  const key = `${provider.name}|${cityKey(city, country)}`;
  const cached = centreCache.get(key);
  if (cached !== undefined) return cached;
  const pending = centresInFlight.get(key);
  if (pending) return pending;

  const task = (async (): Promise<LatLng | null> => {
    try {
      for (const q of country ? [`${city}, ${country}`, city] : [city]) {
        const r = resolve(q, {}, originIndex());
        if (r.status === 'resolved') return { lat: r.place.lat, lng: r.place.lon };
      }
    } catch (err) {
      logger.warn('places: location resolver failed', { city, error: String(err) });
    }
    try {
      const hit = await gate(provider, () =>
        provider.search([city, country].filter(Boolean).join(', '), null),
      );
      return hit ? { lat: hit.lat, lng: hit.lng } : null;
    } catch {
      return null;
    }
  })();
  centresInFlight.set(key, task);
  try {
    const centre = await task;
    centreCache.set(key, centre, centre ? HIT_TTL_MS : MISS_TTL_MS);
    return centre;
  } finally {
    centresInFlight.delete(key);
  }
}

/** A provider hit is usable when it is a venue, near the city. */
function acceptable(hit: PoiHit | null, centre: LatLng | null): hit is PoiHit {
  if (!hit || hit.settlement) return false;
  if (centre && haversineKm({ lat: centre.lat, lon: centre.lng }, { lat: hit.lat, lon: hit.lng }) > MAX_PLACE_KM) {
    return false;
  }
  return true;
}

async function lookUp(
  provider: PoiProvider,
  city: string,
  country: string | undefined,
  item: PlaceRequestItem,
): Promise<Cached> {
  const centre = await cityCentre(city, country);
  let failed = false;
  for (const q of queriesFor(item, city, country)) {
    try {
      const hit = await gate(provider, () => provider.search(q, centre));
      if (acceptable(hit, centre)) return { lat: hit.lat, lng: hit.lng, placeId: hit.placeId };
    } catch (err) {
      // Timeout, HTTP error, or a full Nominatim queue: no answer this time,
      // and NOT cached as a miss — a later call may well succeed.
      failed = true;
      logger.warn('places: lookup failed', { provider: provider.name, query: q, error: String(err) });
      break;
    }
  }
  if (failed) throw new Error('lookup failed');
  return null;
}

/** Start (or join) the lookup for one item. Never rejects. */
function lookupTask(city: string, country: string | undefined, item: PlaceRequestItem): Promise<Cached | undefined> {
  const provider = activeProvider();
  const key = itemKey(provider, city, country, item);
  const cached = itemCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  let task = inFlight.get(key);
  if (!task) {
    task = lookUp(provider, city, country, item);
    inFlight.set(key, task);
    task
      .then(
        (v) => itemCache.set(key, v, v ? HIT_TTL_MS : MISS_TTL_MS),
        () => undefined,
      )
      .finally(() => inFlight.delete(key));
  }
  // undefined = transport failure (unknown), distinct from null (no such place).
  return task.catch(() => undefined);
}

const toResolved = (item: PlaceRequestItem, v: Cached | undefined, pending: boolean): ResolvedPlace =>
  v ? { name: item.name, lat: v.lat, lng: v.lng, placeId: v.placeId } : pending ? { name: item.name, pending: true } : { name: item.name };

/**
 * Coordinates for each item, in input order, answered within `deadlineMs`.
 * Items the provider has not answered by then come back `pending` and keep
 * resolving in the background into the cache.
 */
export async function resolvePlaces(
  city: string,
  country: string | undefined,
  items: PlaceRequestItem[],
  opts: { deadlineMs: number },
): Promise<ResolvedPlace[]> {
  const results: Array<{ done: boolean; value?: Cached }> = items.map(() => ({ done: false }));
  const tasks = items.map((item, i) =>
    lookupTask(city, country, item).then((v) => {
      results[i] = { done: true, value: v ?? undefined };
    }),
  );
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(tasks),
    new Promise<void>((r) => {
      timer = setTimeout(r, Math.max(0, opts.deadlineMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
  return items.map((item, i) => toResolved(item, results[i].value ?? null, !results[i].done));
}

/**
 * Instant answer from the cache only, and start looking up the rest in the
 * background. Used by /activities and /restaurants: their response must not
 * wait on a provider, but the lookups should start the moment the names
 * exist, so the client's follow-up /places call finds most of them done.
 */
export function cachedPlacesAndPrefetch(
  city: string,
  country: string | undefined,
  items: PlaceRequestItem[],
): ResolvedPlace[] {
  const provider = activeProvider();
  return items.map((item) => {
    const cached = itemCache.get(itemKey(provider, city, country, item));
    if (cached !== undefined) return toResolved(item, cached, false);
    void lookupTask(city, country, item);
    return { name: item.name, pending: true };
  });
}

export function providerName(): string {
  return activeProvider().name;
}
