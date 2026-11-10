import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { TtlCache } from './cache';
import type { TravelLeg } from './types';

/**
 * Measured walking / transit times between a city's places — Google Distance
 * Matrix, ONLY when GOOGLE_PLACES_API_KEY is set (the same key, with the
 * Distance Matrix API enabled on it).
 *
 * With no key this returns null and the client uses its own estimate from
 * straight-line distance (frontend/lib/geoSchedule.ts), so the feature works
 * keyless; the matrix just makes the minutes real.
 */

export type TravelPoint = { placeId: string; lat: number; lng: number };

/** Walk when Google's walking time is at most this; else the faster of walk / transit. */
export const WALK_PREFERRED_MAX_MIN = 20;

/** Distance Matrix allows at most 100 elements (origins × destinations) per request. */
const MAX_ELEMENTS = 100;
const TIMEOUT_MS = 6000;

const legCache = new TtlCache<TravelLeg | null>(20_000);
export function __clearTravelCacheForTests() {
  legCache.clear();
}

const pairKey = (a: string, b: string) => `${a}>${b}`;

type Element = { status?: string; duration?: { value?: number }; distance?: { value?: number } };

async function fetchMatrix(
  key: string,
  origins: TravelPoint[],
  destinations: TravelPoint[],
  mode: 'walking' | 'transit',
  fetchImpl: typeof fetch,
): Promise<Element[][] | null> {
  const fmt = (ps: TravelPoint[]) => ps.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');
  const params = new URLSearchParams({
    origins: fmt(origins),
    destinations: fmt(destinations),
    mode,
    key,
  });
  const res = await fetchImpl(`https://maps.googleapis.com/maps/api/distancematrix/json?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  if (data?.status !== 'OK' || !Array.isArray(data.rows)) return null;
  return data.rows.map((r: any) => (Array.isArray(r?.elements) ? r.elements : []));
}

/**
 * Legs between every ordered pair of `points`, keyed "fromPlaceId>toPlaceId".
 * Null when no Google key is configured. Pairs Google could not answer are
 * simply absent (the client estimates those).
 */
export async function travelLegs(
  points: TravelPoint[],
  opts: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<Record<string, TravelLeg> | null> {
  const apiKey = opts.apiKey ?? env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const unique = points.filter((p, i) => points.findIndex((q) => q.placeId === p.placeId) === i);
  const out: Record<string, TravelLeg> = {};
  if (unique.length < 2) return out;

  // Only ask about pairs not already cached.
  const needed = unique.filter((a) => unique.some((b) => b !== a && legCache.get(pairKey(a.placeId, b.placeId)) === undefined));
  if (needed.length > 0) {
    const perChunk = Math.max(1, Math.floor(MAX_ELEMENTS / unique.length));
    try {
      for (let i = 0; i < needed.length; i += perChunk) {
        const origins = needed.slice(i, i + perChunk);
        const [walk, transit] = await Promise.all([
          fetchMatrix(apiKey, origins, unique, 'walking', fetchImpl),
          fetchMatrix(apiKey, origins, unique, 'transit', fetchImpl),
        ]);
        origins.forEach((o, oi) => {
          unique.forEach((d, di) => {
            if (o.placeId === d.placeId) return;
            const w = walk?.[oi]?.[di];
            const t = transit?.[oi]?.[di];
            const wMin = w?.status === 'OK' && w.duration?.value != null ? Math.ceil(w.duration.value / 60) : null;
            const tMin = t?.status === 'OK' && t.duration?.value != null ? Math.ceil(t.duration.value / 60) : null;
            const km = ((w?.distance?.value ?? t?.distance?.value ?? 0) as number) / 1000;
            let leg: TravelLeg | null = null;
            if (wMin !== null && (wMin <= WALK_PREFERRED_MAX_MIN || tMin === null || wMin <= tMin)) {
              leg = { minutes: wMin, distanceKm: Math.round(km * 10) / 10, mode: 'walk' };
            } else if (tMin !== null) {
              leg = { minutes: tMin, distanceKm: Math.round(km * 10) / 10, mode: 'transit' };
            }
            legCache.set(pairKey(o.placeId, d.placeId), leg, 7 * 24 * 60 * 60 * 1000);
          });
        });
      }
    } catch (err) {
      logger.warn('places: distance matrix failed', { error: String(err) });
    }
  }

  for (const a of unique) {
    for (const b of unique) {
      if (a === b) continue;
      const leg = legCache.get(pairKey(a.placeId, b.placeId));
      if (leg) out[pairKey(a.placeId, b.placeId)] = leg;
    }
  }
  return out;
}
