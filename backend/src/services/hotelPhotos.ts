import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * A hotel's photos from Booking, for the city guide's photo strip.
 *
 * The hotel search gives one photo per hotel; Booking's photos endpoint gives
 * the gallery (28 for one London hotel when measured). Each lookup is a
 * metered RapidAPI call, so answers are kept in memory for a day and only the
 * first PHOTO_LIMIT photos are returned — the strip shows a handful, not 28.
 */

export const PHOTO_LIMIT = 12;
const TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;
const FETCH_TIMEOUT_MS = 10_000;

const cache = new Map<string, { at: number; photos: string[] }>();

/** Exposed for tests. */
export function clearHotelPhotoCache(): void {
  cache.clear();
}

/** Booking's photo rows → large photo URLs, best first, once each. */
export function photoUrls(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows as any[]) {
    const url = r?.url_max ?? r?.url_1440;
    if (typeof url !== 'string' || !url.startsWith('https://') || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= PHOTO_LIMIT) break;
  }
  return out;
}

/**
 * The photos for Booking hotel `hotelId`, or [] when there is no key, the
 * call fails, or Booking has none. A failure is not cached, so it is asked
 * again next time.
 */
export async function hotelPhotos(hotelId: string): Promise<string[]> {
  const hit = cache.get(hotelId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.photos;

  const apiKey = env.RAPIDAPI_KEY;
  if (!apiKey) return [];

  const url = `https://booking-com.p.rapidapi.com/v1/hotels/photos?hotel_id=${encodeURIComponent(hotelId)}&locale=en-gb`;
  try {
    const res = await fetch(url, {
      headers: { 'X-RapidAPI-Key': apiKey, 'X-RapidAPI-Host': 'booking-com.p.rapidapi.com' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn('Booking hotel photos failed', { hotelId, status: res.status });
      return [];
    }
    const photos = photoUrls(await res.json());
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(hotelId, { at: Date.now(), photos });
    return photos;
  } catch (err) {
    logger.warn('Booking hotel photos failed', { hotelId, error: (err as Error).message });
    return [];
  }
}
