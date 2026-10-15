import { getDuffel } from './duffel';
import { getSupabase } from './supabase';
import { AppError } from '../middleware/error';
import { logger } from '../utils/logger';
import { getStaticIata } from '../data/cityAirports';
import { parseIsoDuration } from '../utils/duration';
import { elapsedMinutesBetween } from '../utils/localTime';

export type FlightOffer = {
  id: string;
  /**
   * PARTY TOTAL in USD — Duffel's `total_amount` is the fare for every
   * passenger on the offer request, and we ask for one adult per traveler.
   * This is the unit every price crosses the API boundary in; the
   * frontend's per-person toggle divides by `travelers`
   * (frontend/lib/tripTotals.ts `displayAmount`).
   */
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
 * Never sleep longer than this inside a request. A wait that retries slightly
 * early beats holding the optimize open for an hour because a proxy sent
 * `retry-after: 3600`.
 */
const MAX_RETRY_DELAY_MS = 2 * 60 * 1000;
/** ~2001-09-09 in unix seconds. A "delta" this large is really a timestamp. */
const EPOCH_SECONDS_FLOOR = 1_000_000_000;

function clampRetryDelay(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(Math.max(0, Math.round(ms)), MAX_RETRY_DELAY_MS);
}

/**
 * Interpret one rate-limit header value as a delay in ms.
 *
 * Numeric FIRST, `Date.parse` second. The reverse order silently destroyed
 * the delta-seconds form, because `Date.parse` accepts bare digit strings —
 * measured on node v24.6: '60' → 1960-01-01, '120' → year 120, '2' →
 * 2001-02-01, while '30' → NaN. Those are all in the past, so
 * `Math.max(0, at - Date.now())` returned 0 and the numeric branch below was
 * unreachable for exactly those values: a `ratelimit-reset: 60` produced a
 * 0-1000ms sleep, all 4 withRetry attempts landed inside the same exhausted
 * window within ~2s, and the home legs came back empty — the precise failure
 * the comment below says this function prevents. (Digits like '45' or '3600'
 * parsed to a FUTURE year and were wrong in the other direction.)
 */
function parseResetHeader(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    // Delta-seconds, unless it's big enough to be unix epoch seconds —
    // some proxies normalise `ratelimit-reset` to an absolute timestamp.
    const ms = num >= EPOCH_SECONDS_FLOOR ? num * 1000 - Date.now() : num * 1000;
    return clampRetryDelay(ms);
  }

  // Non-numeric means an absolute time: Duffel's ISO timestamp, or the
  // HTTP-date that RFC 9110 also allows for retry-after.
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return clampRetryDelay(at - Date.now());
}

/**
 * When Duffel rate-limits, it says when the window resets (ratelimit-reset,
 * ISO timestamp — with retry-after seconds as a fallback). Sleeping until
 * THEN beats blind exponential backoff: under a sustained per-minute limit,
 * blind 2s/4s retries all land inside the same exhausted window and the
 * call dies pointlessly.
 *
 * Exported for tests — this parsing is where the backoff used to collapse to
 * ~0ms, so it's worth covering directly rather than through timing.
 */
export function retryDelayFromHeaders(err: any): number | null {
  const headers = err?.headers;
  const get = typeof headers?.get === 'function' ? (k: string) => headers.get(k) : () => null;
  for (const name of ['ratelimit-reset', 'retry-after']) {
    const raw = get(name);
    if (raw == null || raw === '') continue;
    const delay = parseResetHeader(String(raw));
    if (delay != null) return delay;
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

/**
 * How long a Duffel slice actually takes, in minutes — or null when the
 * payload doesn't let us know.
 *
 * The order matters. `departing_at` / `arriving_at` carry NO UTC offset:
 * they are local wall-clock times at each airport. Subtracting them parses
 * both in the SERVER's zone and throws the airport-to-airport timezone
 * difference away, which is how NRT 21:00 JST → HNL 09:00 HST reported -720
 * minutes — a blank duration on the card, a door-to-door time that beat
 * every train, and a negative number cached for two hours. Eastbound was
 * wrong the other way: JFK 22:00 → LHR 10:00+1 reported 12h for a 7h flight.
 *
 * So we ask the airline first (Duffel exposes an ISO 8601 `duration` on the
 * slice, which already includes layovers) and only fall back to arithmetic —
 * anchored to each airport's real tz-database zone, which Duffel also ships
 * in the payload — when no provider duration is there.
 */
export function sliceDurationMinutes(slice: any): number | null {
  const segments: any[] = slice?.segments ?? [];
  const firstSegment = segments[0];
  const lastSegment = segments[segments.length - 1];

  // 1. The airline's own number for the whole slice, layovers included.
  const sliceDuration = parseIsoDuration(slice?.duration);
  if (sliceDuration != null && sliceDuration > 0) return sliceDuration;

  // 2. A single-segment slice IS its only segment, so that duration is the
  //    same figure by definition. (Multi-segment slices are skipped here —
  //    summing segments would silently drop the connection time.)
  if (segments.length === 1) {
    const segmentDuration = parseIsoDuration(firstSegment?.duration);
    if (segmentDuration != null && segmentDuration > 0) return segmentDuration;
  }

  // 3. Timestamp arithmetic, done properly: each endpoint is resolved in the
  //    zone of its own airport. No offset table — `time_zone` is part of
  //    Duffel's airport object on every segment.
  return elapsedMinutesBetween(
    firstSegment?.departing_at,
    lastSegment?.arriving_at,
    firstSegment?.origin?.time_zone,
    lastSegment?.destination?.time_zone,
  );
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
          // One adult per traveler, which is what makes `total_amount`
          // below a party total — the unit every price in the app uses.
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

      // 0 means "unknown" here, matching the rest of the codebase. It is
      // never a real flight length, and compareLeg refuses to cache it or
      // let it win a speed tiebreak.
      const durationMinutes = sliceDurationMinutes(slice) ?? 0;

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

    // One line per search, not per offer: if this fires, Duffel gave us
    // neither an ISO duration nor airport time zones for this route and the
    // affected cards will show no duration at all.
    const unknownDurations = mapped.filter((o) => o.durationMinutes <= 0).length;
    if (unknownDurations > 0) {
      logger.warn('Duffel offers with no usable duration', {
        unknownDurations,
        totalOffers: mapped.length,
        origin,
        destination,
        date,
      });
    }

    // Normalize all prices to USD. An offer we can't convert is dropped
    // rather than relabelled: compareLeg's cheapest/priceDifference, the
    // optimizer's totals and every `$` in the UI all read FlightOffer.price
    // as dollars, so a pass-through would let a 4,000,000 IDR fare "lose"
    // a price comparison against a $300 one and land in the trip total.
    const { convertToUsd } = await import('./currency');
    const converted = await Promise.all(
      mapped.map(async (o): Promise<FlightOffer | null> => {
        if (!o.currency || o.currency === 'USD') return o;
        const usd = await convertToUsd(o.price, o.currency);
        if (usd === null) {
          logger.warn('Flight offer dropped — no USD rate for its currency', {
            offerCurrency: o.currency,
            origin,
            destination,
            date,
          });
          return null;
        }
        return { ...o, price: usd, currency: 'USD' };
      }),
    );
    return converted.filter((o): o is FlightOffer => o !== null);
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
