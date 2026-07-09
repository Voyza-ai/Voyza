import { getDuffel } from './duffel';
import { getSupabase } from './supabase';
import { AppError } from '../middleware/error';
import { logger } from '../utils/logger';
import { getStaticIata } from '../data/cityAirports';

export type FlightOffer = {
  id: string;
  price: number;
  currency: string;
  departure: string;
  arrival: string;
  durationMinutes: number;
  stops: number;
  carrier: string;
  carrierCode: string;
  bookingUrl: string;
  raw: object;
};

type SearchFlightsParams = {
  origin: string;
  destination: string;
  date: string;
  travelers: number;
  cabinClass?: string;
};

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Global cap on concurrent Duffel searches. The optimizer fans out hard —
 * permutations × date-shift probes × home airports easily exceeds 50
 * searches for a 5-city trip — and past a point Duffel rate-limits the
 * burst. Without this gate every 429'd call also retried on the SAME
 * synchronized backoff schedule, re-collided, exhausted its attempts, and
 * whole legs (typically the home legs, searched last) came back empty.
 * Queueing excess searches keeps the burst under the limit; total wall
 * time barely moves because Duffel answers gated calls without penalty.
 */
const MAX_CONCURRENT_SEARCHES = 6;
let activeSearches = 0;
const searchWaiters: Array<() => void> = [];

async function withSearchSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (activeSearches >= MAX_CONCURRENT_SEARCHES) {
    await new Promise<void>((resolve) => searchWaiters.push(resolve));
  }
  activeSearches++;
  try {
    return await fn();
  } finally {
    activeSearches--;
    searchWaiters.shift()?.();
  }
}

/** Pull the HTTP status out of a DuffelError (or any HTTP-ish error). */
function errorStatus(err: any): number | undefined {
  return err?.meta?.status ?? err?.statusCode ?? err?.status;
}

/**
 * When Duffel rate-limits, it says when the window resets (ratelimit-reset,
 * ISO timestamp — with retry-after seconds as a fallback). Sleeping until
 * THEN beats blind exponential backoff: under a sustained per-minute limit,
 * blind 2s/4s retries all land inside the same exhausted window and the
 * call dies pointlessly.
 */
function retryDelayFromHeaders(err: any): number | null {
  const headers = err?.headers;
  const get = typeof headers?.get === 'function' ? (k: string) => headers.get(k) : () => null;
  const reset = get('ratelimit-reset');
  if (reset) {
    const at = Date.parse(reset);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
    const secs = Number(reset);
    if (!Number.isNaN(secs)) return secs * 1000;
  }
  const retryAfter = get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs)) return secs * 1000;
  }
  return null;
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = errorStatus(err);
      const retryable = status === 429 || status === 502 || status === 503 || status === 504;
      if (retryable && attempt < maxAttempts) {
        // Prefer the server-declared reset time; otherwise jittered
        // exponential backoff (synchronized retries just re-collide).
        const headerDelay = retryDelayFromHeaders(err);
        const base = Math.pow(2, attempt) * 1000;
        const jittered = Math.round(base * (0.5 + Math.random()));
        const delay = headerDelay != null
          ? headerDelay + Math.round(Math.random() * 1000)
          : jittered;
        logger.warn('Duffel retryable error — backing off', {
          status,
          attempt,
          delay,
          fromHeader: headerDelay != null,
        });
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new AppError(500, 'Retry limit exceeded');
}

/**
 * Dedupe + short-TTL cache for searches. The optimizer scores many
 * permutations and date-shift probes that all need the SAME leg (same
 * origin/destination/date) — without this, one 5-city optimize fires the
 * identical Duffel search dozens of times and burns straight through the
 * per-minute rate limit; the home legs (searched last) then find the
 * window exhausted and the trip renders with no home flight at all.
 * Concurrent duplicates share one in-flight promise; failures are evicted
 * immediately so retries stay possible.
 */
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const searchCache = new Map<string, { at: number; promise: Promise<FlightOffer[]> }>();

function cachedSearch(key: string, run: () => Promise<FlightOffer[]>): Promise<FlightOffer[]> {
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) return hit.promise;

  const promise = run();
  searchCache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    // Don't cache failures — the next caller should get a fresh attempt.
    if (searchCache.get(key)?.promise === promise) searchCache.delete(key);
  });

  // Opportunistic sweep so long-running processes don't accumulate entries.
  if (searchCache.size > 500) {
    const cutoff = Date.now() - SEARCH_CACHE_TTL_MS;
    for (const [k, v] of searchCache) {
      if (v.at < cutoff) searchCache.delete(k);
    }
  }
  return promise;
}

export async function searchFlights(params: SearchFlightsParams): Promise<FlightOffer[]> {
  const { origin, destination, date, travelers, cabinClass } = params;
  const key = `${origin}|${destination}|${date}|${travelers}|${cabinClass ?? 'economy'}`;
  return cachedSearch(key, () => searchFlightsUncached(params));
}

async function searchFlightsUncached(params: SearchFlightsParams): Promise<FlightOffer[]> {
  const { origin, destination, date, travelers, cabinClass } = params;
  const duffel = getDuffel();

  try {
    const offerRequest = await withSearchSlot(() =>
      withRetry(() =>
        duffel.offerRequests.create({
          slices: [
            {
              origin,
              destination,
              departure_date: date,
            } as any,
          ],
          passengers: Array.from({ length: travelers }, () => ({ type: 'adult' as const })),
          cabin_class: (cabinClass as any) || 'economy',
          return_offers: true,
        }),
      ),
    );

    const offers = offerRequest.data.offers ?? [];

    const mapped = offers.map((offer: any) => {
      const slice = offer.slices?.[0];
      const firstSegment = slice?.segments?.[0];
      const lastSegment = slice?.segments?.[slice.segments.length - 1];
      const carrier = firstSegment?.operating_carrier ?? firstSegment?.marketing_carrier ?? {};

      const depTime = new Date(firstSegment?.departing_at ?? date);
      const arrTime = new Date(lastSegment?.arriving_at ?? date);
      const durationMinutes = Math.round((arrTime.getTime() - depTime.getTime()) / 60000);

      // Real bookable deep link. Duffel doesn't expose a public offer-redirect
      // page — the old `https://duffel.com/redirect/offers/...` URL 404s. Until
      // we build in-app booking (Duffel Orders API), send users to Google
      // Flights pre-filled with the exact route + date. From there they can
      // book directly with the airline or a trusted OTA.
      const googleFlightsUrl = `https://www.google.com/travel/flights?q=${encodeURIComponent(
        `Flights to ${destination} from ${origin} on ${date}`,
      )}`;

      return {
        id: offer.id,
        price: parseFloat(offer.total_amount ?? '0'),
        currency: offer.total_currency ?? 'USD',
        departure: firstSegment?.departing_at ?? '',
        arrival: lastSegment?.arriving_at ?? '',
        durationMinutes,
        stops: (slice?.segments?.length ?? 1) - 1,
        carrier: carrier.name ?? 'Unknown',
        carrierCode: carrier.iata_code ?? '',
        bookingUrl: googleFlightsUrl,
        raw: offer,
      };
    });

    // Normalize all prices to USD
    const { convertToUsd } = await import('./currency');
    return await Promise.all(
      mapped.map(async (o) => {
        if (!o.currency || o.currency === 'USD') return o;
        const usd = await convertToUsd(o.price, o.currency);
        return { ...o, price: usd, currency: 'USD' };
      }),
    );
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    // DuffelError extends Error but calls super() with NO message — the
    // real information lives in err.meta.status and err.errors[]. Also:
    // never put a `message` key in winston meta; it silently overwrites
    // the log line's own message (that's why these logs used to be blank).
    const status = errorStatus(err);
    const duffelErrors = Array.isArray(err?.errors)
      ? err.errors
          .slice(0, 2)
          .map((e: any) => e?.title ?? e?.code ?? e?.message)
          .filter(Boolean)
      : undefined;
    logger.error('Duffel searchFlights failed', {
      status,
      duffelErrors,
      errMessage: err?.message || undefined,
      origin,
      destination,
      date,
    });
    const reason = err?.message || duffelErrors?.[0] || (status ? `HTTP ${status}` : 'Unknown error');
    throw new AppError(502, `Flight search failed: ${reason}`, {
      source: 'duffel',
    });
  }
}

export async function getIataCode(cityName: string): Promise<string> {
  // Curated override first — deterministic, and corrects known bad
  // auto-resolutions (e.g. Kyoto, which has no airport of its own and
  // otherwise mis-resolved to ACC/Accra). Takes precedence over any stale
  // cached row.
  const override = getStaticIata(cityName);
  if (override) return override;

  const supabase = getSupabase();

  // Check cache first
  const { data: cached } = await supabase
    .from('airport_codes')
    .select('iata_code')
    .eq('city_name', cityName.toLowerCase())
    .single();

  if (cached?.iata_code) return cached.iata_code;

  // Fetch from Duffel
  const duffel = getDuffel();
  try {
    const response = await withRetry(() =>
      duffel.suggestions.list({ query: cityName }),
    );

    const places = (response as any)?.data ?? [];
    const airport = places.find(
      (p: any) => p.type === 'airport' || p.type === 'city',
    );

    if (!airport?.iata_code) {
      throw new AppError(404, `No IATA code found for "${cityName}"`);
    }

    // Cache it
    await supabase.from('airport_codes').upsert({
      city_name: cityName.toLowerCase(),
      iata_code: airport.iata_code,
      country: airport.iata_country_code ?? null,
    });

    return airport.iata_code;
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, `IATA lookup failed for "${cityName}": ${err?.message}`);
  }
}
