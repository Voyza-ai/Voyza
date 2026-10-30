import { getDuffel } from './duffel';
import { currentDuffelRetryBudget } from './duffelBudget';
import { getSupabase } from './supabase';
import { AppError } from '../middleware/error';
import { logger } from '../utils/logger';
import { getStaticIata } from '../data/cityAirports';
import {
  consistentWithAnchors,
  destinationAnchors,
  namedAsAsked,
  resolveDestinationIata,
  type DestinationContext,
  type SuggestedPlace,
} from './location/destinationAirport';
import { sameAirportArea } from './location/sameAirportArea';
import { parseIsoDuration } from '../utils/duration';
import { elapsedMinutesBetween } from '../utils/localTime';

/**
 * No real fare costs less than this, once taxes are counted.
 *
 * Exists to catch an ABSENT price: Duffel's `total_amount` missing becomes
 * parseFloat('0') === 0 at the mapping, and compareLeg picks the cheapest
 * offer, so a 0 wins its leg and is cached for two hours. $1 is orders of
 * magnitude below any bookable fare, so it binds on certainty.
 */
const FLIGHT_PRICE_FLOOR = 1;

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
    // A call can queue here for a while; if Duffel rate-limited us in the
    // meantime, don't spend a request finding that out. withRetry waits
    // the pause out (or gives up, within its budget).
    const paused = duffelPausedUntil - Date.now();
    if (paused > 0) throw rateLimitedError(paused);
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

/**
 * Most time ONE Duffel call may spend waiting to retry, across all its
 * attempts. Duffel's limit is 60 requests per 60-second window per token
 * (docs, errors page: `ratelimit-reset` is when the window resets), so 65s
 * is "wait for the next window once, never longer".
 *
 * Without a total, each of 3 retries could sleep up to MAX_RETRY_DELAY_MS
 * (2 minutes), so one search could stall for six — and the gate below meant
 * six such sleepers stalled every search behind them. A call that would
 * have to wait past its budget fails now instead: its leg comes back
 * unpriced (the optimizer already ranks and displays that honestly) and the
 * plan finishes.
 */
const MAX_TOTAL_RETRY_WAIT_MS = 65_000;

/**
 * When Duffel said "rate limited until T", every request sent before T is
 * refused too — and may count against the next window. So the first 429
 * that carries a reset time pauses ALL Duffel calls from this process until
 * then, instead of each in-flight call discovering it separately and
 * burning an attempt. Epoch ms; 0 = not paused.
 */
let duffelPausedUntil = 0;

/** Exposed for tests: forget any rate-limit pause. */
export function resetDuffelRateLimitPause(): void {
  duffelPausedUntil = 0;
}

function rateLimitedError(waitMs: number): Error {
  // Same shape a DuffelError 429 has, so callers' handling is unchanged.
  const err: any = new Error(
    `Duffel rate limit: next window in ${Math.ceil(waitMs / 1000)}s, past this search's retry budget`,
  );
  err.meta = { status: 429 };
  return err;
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  // A caller doing optional work may cap it lower (see duffelBudget.ts).
  const budget = Math.min(MAX_TOTAL_RETRY_WAIT_MS, currentDuffelRetryBudget() ?? Infinity);
  let waited = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Honour a pause another call already learned about — before sending.
    const paused = duffelPausedUntil - Date.now();
    if (paused > 0) {
      // A little spread so every paused call doesn't fire on the same ms.
      const wait = paused + Math.round(Math.random() * 1000);
      if (waited + wait > budget) throw rateLimitedError(paused);
      await sleep(wait);
      waited += wait;
    }
    try {
      return await fn();
    } catch (err: any) {
      const status = errorStatus(err);
      const retryable = status === 429 || status === 502 || status === 503 || status === 504;
      if (retryable && attempt < maxAttempts) {
        // Prefer the server-declared reset time; otherwise jittered
        // exponential backoff (synchronized retries just re-collide).
        const headerDelay = retryDelayFromHeaders(err);
        if (status === 429 && headerDelay != null && headerDelay > 0) {
          duffelPausedUntil = Math.max(duffelPausedUntil, Date.now() + headerDelay);
        }
        const base = Math.pow(2, attempt) * 1000;
        const jittered = Math.round(base * (0.5 + Math.random()));
        const pausedFor = duffelPausedUntil - Date.now();
        const delay = headerDelay != null
          ? headerDelay + Math.round(Math.random() * 1000)
          : status === 429 && pausedFor > 0
            ? pausedFor + Math.round(Math.random() * 1000) // stopped by the shared pause
            : jittered;
        // Out of budget: fail this one call now rather than sleep past it.
        if (waited + delay > budget) throw err;
        logger.warn('Duffel retryable error — backing off', {
          status,
          attempt,
          delay,
          fromHeader: headerDelay != null,
        });
        await sleep(delay);
        waited += delay;
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
  // A place to itself (ZRH → ZRH, LHR → LON) is not a flight, and never
  // reaches Duffel. Callers that count outcomes (the optimizer) skip such a
  // leg before getting here; this is the floor for every other path.
  if (sameAirportArea(origin, destination)) return [];
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
    // Retry OUTSIDE the slot: a call sleeping on a backoff or a rate-limit
    // pause used to keep its slot for the whole sleep, so six sleepers froze
    // every other search. Each attempt now takes a slot only while it is
    // actually talking to Duffel.
    const offerRequest = await withRetry(() =>
      withSearchSlot(() =>
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
        // A price that cannot be real is dropped, not carried. `total_amount`
        // absent becomes parseFloat('0') === 0 at the mapping above, and 0 is
        // the most dangerous value on this path: compareLeg picks the CHEAPEST
        // offer, so a $0 flight wins its leg outright, lands in the trip
        // total, and is written to leg_price_cache for two hours — so one bad
        // response poisons the route for everyone until it expires.
        //
        // hotels.ts has had a floor for exactly this reason and called 0 "the
        // single most dangerous value in the system"; flights had none. $1 is
        // far below any real fare once taxes are counted, so this binds on
        // certainty rather than judgement.
        if (!Number.isFinite(o.price) || o.price < FLIGHT_PRICE_FLOOR) {
          logger.warn('Flight offer dropped — price cannot be a real fare', {
            price: o.price,
            offerCurrency: o.currency,
            floor: FLIGHT_PRICE_FLOOR,
            origin,
            destination,
            date,
          });
          return null;
        }

        // No USD short-circuit: convertToUsd decides, and returns null for a
        // blank or malformed code rather than trusting the number.
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

        // The floor again, on the CONVERTED figure. Conversion rounds to cents,
        // so it can manufacture a zero out of a small amount in a weak
        // currency — 100 VND converts to $0.00 — and a $0 fare wins every
        // price comparison it enters. Checking only the raw amount let that
        // through, because 100 is comfortably over the floor and $0.00 is not.
        if (!Number.isFinite(usd) || usd < FLIGHT_PRICE_FLOOR) {
          logger.warn('Flight offer dropped — converted price below the floor', {
            raw: o.price,
            offerCurrency: o.currency,
            usd,
            floor: FLIGHT_PRICE_FLOOR,
            origin,
            destination,
            date,
          });
          return null;
        }

        return { ...o, price: usd, currency: 'USD' };
      }),
    );
    const usable = converted.filter((o): o is FlightOffer => o !== null);

    // Losing every offer to a filter is not the same as the route having no
    // flights, and it used to look identical in the logs. The hotel path got
    // this signal; this one did not.
    if (usable.length === 0 && mapped.length > 0) {
      logger.error('Flight search emptied — no offer survived price or currency checks', {
        origin,
        destination,
        date,
        rows: mapped.length,
        currencies: [...new Set(mapped.map((o) => o.currency || '(blank)'))],
      });
    }

    return usable;
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

/**
 * What a caller may know about the trip a city is on. Optional, and names
 * only — the optimizer holds plain strings. With it, `Portland` on a trip
 * through Boston is Maine's PWM; without it, it is Oregon's PDX, as before.
 * Passing the city itself among the names is harmless: it is dropped.
 */
export type IataLookupContext = DestinationContext;

/** A Duffel place reduced to what `destinationAirport.ts` checks. */
function suggestedPlace(p: any): SuggestedPlace {
  // A `city` place may carry no coordinates of its own; its airports do.
  const hasPoint = (x: any): boolean =>
    typeof x?.latitude === 'number' && typeof x?.longitude === 'number';
  const located = hasPoint(p) ? p : (p?.airports ?? []).find(hasPoint);
  return {
    iataCode: String(p.iata_code).toUpperCase(),
    country: p.iata_country_code ?? null,
    lat: typeof located?.latitude === 'number' ? located.latitude : null,
    lon: typeof located?.longitude === 'number' ? located.longitude : null,
    names: [p.name, p.city_name, p.city?.name].filter(
      (n: unknown): n is string => typeof n === 'string' && n.length > 0,
    ),
  };
}

export async function getIataCode(
  cityName: string,
  context: IataLookupContext = {},
): Promise<string> {
  // Curated override first — deterministic, and corrects known bad
  // auto-resolutions (e.g. Kyoto, which has no airport of its own and
  // otherwise mis-resolved to ACC/Accra). Takes precedence over any stale
  // cached row, and over trip context: see `resolveDestinationIata` for the
  // measured flips that would cost.
  const override = getStaticIata(cityName);
  if (override) return override;

  // The artifact next, BEFORE the cache. The cache holds whatever Duffel's
  // fuzzy place search once returned, forever — Siena -> JHB (Malaysia),
  // Sintra -> SQG (Indonesia), Bath -> BUT (Bhutan) — while the artifact
  // answers all three from data: FLR, LIS, BRS. Asking it first means a
  // stale row can no longer win for any name the artifact can answer.
  // In-memory, no network, and no database read.
  const fromArtifact = resolveDestinationIata(cityName, context);
  if (fromArtifact) return fromArtifact;

  // Where the artifact says this name is, when it could not answer it. Empty
  // when it knows nothing about the name and there is no trip.
  const anchors = destinationAnchors(cityName, context);

  const supabase = getSupabase();

  // Check cache. Rows were written before suggestions were checked, so when
  // the artifact knows where the name is, a row is held to the same test a
  // fresh suggestion is, and skipped rather than served if it fails. Nothing
  // here deletes it; the next verified suggestion overwrites it.
  const { data: cached } = await supabase
    .from('airport_codes')
    .select('iata_code, country')
    .eq('city_name', cityName.toLowerCase())
    .single();

  if (cached?.iata_code) {
    const row: SuggestedPlace = {
      iataCode: String(cached.iata_code).toUpperCase(),
      country: typeof cached.country === 'string' ? cached.country : null,
      lat: null,
      lon: null,
      names: [],
    };
    if (anchors.length === 0 || consistentWithAnchors(row, anchors)) return cached.iata_code;
    logger.warn('Skipped a cached IATA row the artifact contradicts', {
      city: cityName,
      cached: row.iataCode,
      cachedCountry: row.country,
    });
  }

  // Fetch from Duffel
  const duffel = getDuffel();
  try {
    const response = await withRetry(() =>
      duffel.suggestions.list({ query: cityName }),
    );

    const places = ((response as any)?.data ?? []).filter(
      (p: any) => (p?.type === 'airport' || p?.type === 'city') && p?.iata_code,
    );

    // Duffel's place search is fuzzy, and its first hit was trusted and
    // cached forever. Now a suggestion is accepted only if it is where the
    // artifact says the name is (`destinationAnchors`), and only then cached.
    // With no evidence at all it must at least be NAMED what was asked, and
    // is served for this call only — never cached, so a guess cannot become
    // permanent. Every production failure measured fails both checks.
    let chosen: SuggestedPlace | null = null;
    let verified = false;
    for (const p of places) {
      const place = suggestedPlace(p);
      if (anchors.length > 0) {
        if (consistentWithAnchors(place, anchors)) {
          chosen = place;
          verified = true;
          break;
        }
      } else if (namedAsAsked(cityName, place)) {
        chosen = place;
        break;
      }
    }

    if (!chosen) {
      if (places.length > 0) {
        logger.warn('Refused unverifiable Duffel IATA suggestions', {
          city: cityName,
          suggested: places.slice(0, 3).map((p: any) => p.iata_code),
          check: anchors.length > 0 ? 'not where the artifact places the name' : 'not named as asked',
        });
      }
      throw new AppError(404, `No IATA code found for "${cityName}"`);
    }

    if (verified) {
      await supabase.from('airport_codes').upsert({
        city_name: cityName.toLowerCase(),
        iata_code: chosen.iataCode,
        country: chosen.country,
      });
    }

    return chosen.iataCode;
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, `IATA lookup failed for "${cityName}": ${err?.message}`);
  }
}
