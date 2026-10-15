import { env } from '../config/env';
import { getSupabase } from './supabase';
import { logger } from '../utils/logger';
import { searchAllAboard } from './allaboard';

/**
 * fetch() with a hard timeout. The Deutsche Bahn REST API is community-run and
 * occasionally hangs or 503s; without a timeout a single slow leg blocks the
 * whole optimize (compareLeg awaits flight + train in parallel, so every leg
 * stalls). Abort after DB_TIMEOUT_MS so train search fails fast and we fall
 * back to flights instead of hanging.
 */
const DB_TIMEOUT_MS = 4500;
async function fetchWithTimeout(url: string, timeoutMs = DB_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export type TrainOffer = {
  id: string;
  /**
   * PARTY TOTAL in USD — the fare for all `travelers` on the booking, or
   * null when no provider returned a fare. This is the unit every price
   * crosses the API boundary in: Duffel's `total_amount` is already the
   * whole passenger set, and the frontend's per-person toggle just divides
   * by `travelers` (frontend/lib/tripTotals.ts `displayAmount`).
   *
   * Providers quote ONE adult — see `ProviderTrainOffer`. `searchTrains` is
   * the only place the two units meet.
   */
  price: number | null;
  currency: string;
  departure: string;
  arrival: string;
  durationMinutes: number;
  operator: string;
  trainType: string;
  /**
   * Always null today. Neither rail provider returns a booking link at the
   * search/offer stage — All Aboard confirmed it in writing: booking is an
   * API flow (createBooking → createOrder → createPayment), and only the
   * last step yields a URL. We used to fill this with the providers'
   * marketing homepages, which sent users to a page where they had to start
   * their search over. null lets the UI show its no-link state instead.
   * See ROADMAP.md → "Real rail booking (All Aboard)".
   */
  bookingUrl: string | null;
  /**
   * True when we can't fully price-compare this journey — currently means
   * the provider returned no fare. Derived from REAL data, not a country
   * guess: a journey with a fare competes with flights on price; one
   * without can't, so the optimizer should lean on the priced option.
   */
  limitedCoverage: boolean;
};

/**
 * What a train provider returns, named for its unit. Every rail source we
 * query quotes a single adult: All Aboard asks for `[{type: ADULT}]`, and
 * the Deutsche Bahn /journeys endpoint takes no passenger count at all. So
 * a provider deliberately cannot produce a `TrainOffer` — it has no `price`
 * field to fill in — and `searchTrains` is the only place per-person is
 * scaled to the party total. That makes a double-multiply a type error
 * rather than a convention someone has to remember.
 *
 * If a provider is ever asked for the real party fare (All Aboard's
 * getJourneyOffer does take a passengers array, so it can be), that
 * provider must NOT go through `toPartyTotal` — declare the unit on its
 * registry entry at that point. Today every provider is per-person.
 */
export type ProviderTrainOffer = Omit<TrainOffer, 'price'> & {
  /** ONE adult's fare in USD, or null when the provider returned no fare. */
  pricePerPerson: number | null;
};

/**
 * Strip case, diacritics, whitespace, and punctuation so we can compare
 * a station name like "Roma Termini · Platform 12" to a city like "Rome"
 * without playing whack-a-mole with formatting. (Note: this is a string
 * normaliser, not a translator — "Roma" → "Rome" still won't match. We
 * accept that imperfection in exchange for keeping the check obvious.)
 */
function normalizeForMatch(s: string | undefined | null): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Sanity-check that the station the API came back with is actually the
 * city the user asked about.
 *
 * Why: db.transport.rest doesn't say "no coverage" — for routes its rail
 * graph can't reach (Reykjavik → Faroe Islands, NYC → anywhere) it
 * sometimes returns a journey between two stations *near the requested
 * stop IDs*, which can be wildly off topographically. Without this guard
 * a "$21 train from Reykjavik to Faroe Islands" silently rendered on
 * the trip card.
 *
 * The check is intentionally loose — substring either way — so common
 * cases pass: "Frankfurt" → "Frankfurt(Main)Hbf" matches. Translation
 * gaps (Roma vs Rome) are accepted false-negatives; the tradeoff is that
 * an obvious mismatch like "Reykjavik vs Some German Station" is caught.
 */
function stationMatchesCity(stationName: string | undefined, city: string): boolean {
  const sn = normalizeForMatch(stationName);
  const c = normalizeForMatch(city);
  if (!sn || !c) return false;
  return sn.includes(c) || c.includes(sn);
}

export async function getStopId(cityName: string): Promise<string> {
  const supabase = getSupabase();

  // Check cache
  const { data: cached } = await supabase
    .from('db_stops')
    .select('stop_id')
    .eq('city_name', cityName.toLowerCase())
    .single();

  if (cached?.stop_id) return cached.stop_id;

  // Fetch from DB API
  const baseUrl = env.DB_REST_BASE_URL;
  const url = `${baseUrl}/locations?query=${encodeURIComponent(cityName)}&results=1&poi=false&addresses=false`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`DB locations API returned ${res.status}`);
  }

  const locations = await res.json();
  const stop = Array.isArray(locations) ? locations[0] : null;

  if (!stop?.id) {
    throw new Error(`No stop found for "${cityName}"`);
  }

  // Cache
  await supabase.from('db_stops').upsert({
    city_name: cityName.toLowerCase(),
    stop_id: stop.id,
    cached_at: new Date().toISOString(),
  });

  return stop.id;
}

type SearchTrainsParams = {
  origin: string;
  destination: string;
  date: string;
  travelers: number;
  originCountry?: string;
  destinationCountry?: string;
};

// ─── Provider registry ──────────────────────────────────────────
// Each train data source is a "provider". Today there's exactly one real,
// live source: Deutsche Bahn's free REST API (strong in DACH, patchy
// elsewhere). Trainline / Kiwi-rail / regional operators plug in here as
// they come online — register a provider and `searchTrains` picks it up.
//
// Principle: NO static/hardcoded fare tables. A route has a train only if a
// real provider returns a real, station-validated journey. When none do, we
// return [] and the caller surfaces an honest "no live train data" state
// rather than inventing a fare.

type Coverage = 'authoritative' | 'partial' | 'none';

interface TrainProvider {
  id: string;
  /** 'none' skips this provider for the route; anything else queries it. */
  coverage(params: SearchTrainsParams): Coverage;
  search(params: SearchTrainsParams): Promise<ProviderTrainOffer[]>;
}

/**
 * Deutsche Bahn REST provider. Always attempts (returns 'partial') and lets
 * the real API result + station-match filter decide whether there's actually
 * a journey — no hardcoded country list claiming coverage we don't have.
 */
async function searchDeutscheBahn(params: SearchTrainsParams): Promise<ProviderTrainOffer[]> {
  const { origin, destination, date } = params;

  try {
    const [fromId, toId] = await Promise.all([
      getStopId(origin),
      getStopId(destination),
    ]);

    const baseUrl = env.DB_REST_BASE_URL;
    const departureISO = new Date(date).toISOString();
    const url = `${baseUrl}/journeys?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}&departure=${encodeURIComponent(departureISO)}&results=5&stopovers=false`;

    const res = await fetchWithTimeout(url);
    if (!res.ok) {
      logger.warn('DB journeys API error', { status: res.status, origin, destination });
      return [];
    }

    const data: any = await res.json();
    const allJourneys = data.journeys ?? [];

    // Drop journeys whose actual start/end stations don't line up with the
    // requested cities. Catches the case where DB REST has no real coverage
    // for a route (e.g. Reykjavik → Faroe Islands) and silently returns a
    // journey between two stations near the resolved stop IDs that aren't
    // anywhere near the requested cities.
    const journeys = allJourneys.filter((journey: any) => {
      const legs = journey.legs ?? [];
      if (legs.length === 0) return false;
      const startStation = legs[0]?.origin?.name ?? legs[0]?.origin?.station?.name;
      const endStation =
        legs[legs.length - 1]?.destination?.name ??
        legs[legs.length - 1]?.destination?.station?.name;
      const ok =
        stationMatchesCity(startStation, origin) &&
        stationMatchesCity(endStation, destination);
      if (!ok) {
        logger.warn('DB journey dropped — station/city mismatch', {
          requested: `${origin} → ${destination}`,
          got: `${startStation} → ${endStation}`,
        });
      }
      return ok;
    });

    const mapped: ProviderTrainOffer[] = journeys.map(
      (journey: any, idx: number): ProviderTrainOffer => {
        const legs = journey.legs ?? [];
        const firstLeg = legs[0];
        const lastLeg = legs[legs.length - 1];

        const depTime = firstLeg?.departure ? new Date(firstLeg.departure) : new Date(date);
        const arrTime = lastLeg?.arrival ? new Date(lastLeg.arrival) : depTime;
        const durationMinutes = Math.round((arrTime.getTime() - depTime.getTime()) / 60000);

        // Per-person by construction: the /journeys URL above carries no
        // passenger count, so DB REST always quotes one adult. There is no
        // way to ask it for a party fare — `searchTrains` scales it.
        const pricePerPerson = journey.price?.amount ? parseFloat(journey.price.amount) : null;
        const operator = firstLeg?.line?.operator?.name ?? firstLeg?.line?.name ?? 'Unknown';
        const trainType = firstLeg?.line?.productName ?? firstLeg?.line?.product ?? 'train';

        return {
          id: `db-${fromId}-${toId}-${idx}`,
          pricePerPerson,
          currency: journey.price?.currency ?? 'EUR',
          departure: firstLeg?.departure ?? '',
          arrival: lastLeg?.arrival ?? '',
          durationMinutes,
          operator,
          trainType,
          bookingUrl: null,
          // Honest, data-derived: a journey with no fare can't be price-compared.
          limitedCoverage: pricePerPerson == null,
        };
      },
    );

    // Convert all prices to USD (DB REST returns EUR). If we have no rate for
    // the fare's currency we keep the journey but drop the FARE:
    // `pricePerPerson: null` + `limitedCoverage: true` is exactly the
    // existing, documented "can't be price-compared" state, so compareLeg
    // already leans on the priced option and the card stops short of
    // inventing a dollar figure. Relabelling the raw amount 'USD' would
    // instead let it win the cheapest comparison.
    const { convertToUsd } = await import('./currency');
    return await Promise.all(
      mapped.map(async (t) => {
        if (t.pricePerPerson == null || !t.currency || t.currency === 'USD') return t;
        const usd = await convertToUsd(t.pricePerPerson, t.currency);
        if (usd === null) {
          logger.warn('Train fare unpriced — no USD rate for its currency', {
            currency: t.currency,
            origin,
            destination,
          });
          return { ...t, pricePerPerson: null, limitedCoverage: true };
        }
        return { ...t, pricePerPerson: usd, currency: 'USD' };
      }),
    );
  } catch (err: any) {
    logger.warn('DB train search failed (non-fatal)', { message: err?.message, origin, destination });
    return [];
  }
}

const trainProviders: TrainProvider[] = [
  {
    id: 'allaboard',
    // Pan-EU rail (SNCF, Trenitalia, Renfe, NS, Eurostar…). Active only
    // when a key is configured; its own location matching decides real
    // coverage per route.
    coverage: () => (env.ALLABOARD_API_KEY ? 'partial' : 'none'),
    search: (p) => searchAllAboard(p),
  },
  {
    id: 'deutsche-bahn',
    // Always attempt — real results (+ the station-match filter) decide
    // whether there's a journey, instead of guessing from a country list.
    coverage: () => 'partial',
    search: searchDeutscheBahn,
  },
  // Future real providers plug in here (no code changes elsewhere):
  //   { id: 'trainline', coverage: euOnly, search: searchTrainline },
  //   { id: 'kiwi-rail',  coverage: () => 'partial', search: searchKiwiRail },
];

/**
 * Scale a provider's per-person fare into the party total that leaves the
 * backend. THE ONLY PLACE rail prices get multiplied — providers hand over
 * `pricePerPerson`, this hands back `price`, and the compiler won't let a
 * provider skip the step.
 *
 * Why multiply here rather than ask each provider for N passengers: DB REST
 * can't be asked at all, and a mix of asked-for and multiplied providers is
 * exactly how a double-multiply ships. European rail is priced per seat
 * below group-booking sizes, so N × the adult fare is the real party price.
 *
 * `travelers` is floored at 1 on purpose: a zero/NaN count would otherwise
 * multiply every fare to $0, and a $0 leg reads as a free train instead of
 * a data gap (the same trap the price-0 sort in legOptions.ts avoids).
 */
function toPartyTotal(offer: ProviderTrainOffer, travelers: number): TrainOffer {
  const { pricePerPerson, ...rest } = offer;
  const party = Math.max(1, Math.floor(travelers) || 1);
  return {
    ...rest,
    price:
      pricePerPerson == null ? null : Math.round(pricePerPerson * party * 100) / 100,
  };
}

/**
 * Global cap on concurrent train searches — the same gate flights.ts puts
 * in front of Duffel, sized for a coarser unit of work. One slot here is a
 * whole route's provider fan-out: All Aboard spends up to 6 requests per
 * route (2 location lookups, 1 getJourneys, 3 getJourneyOffer) and
 * Deutsche Bahn another 3, where MAX_CONCURRENT_SEARCHES gates a single
 * Duffel call — so 8 slots is roughly the same order of concurrent
 * provider requests as that 6.
 *
 * Why it's needed: the optimizer fans out over every candidate ordering
 * (120 orderings × 4 legs = 480 concurrent compareLeg calls for a 5-city
 * trip). The dedupe below collapses those to ~80 distinct legs, but
 * ungated those 80 still fire ~240 getJourneyOffer calls at once — the
 * request allaboard.ts documents as "30s+ cold" — and the provider sheds
 * the burst, so the legs come back with no fare at all.
 */
const MAX_CONCURRENT_TRAIN_SEARCHES = 8;
let activeTrainSearches = 0;
const trainSearchWaiters: Array<() => void> = [];

async function withTrainSearchSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (activeTrainSearches >= MAX_CONCURRENT_TRAIN_SEARCHES) {
    await new Promise<void>((resolve) => trainSearchWaiters.push(resolve));
  }
  activeTrainSearches++;
  try {
    return await fn();
  } finally {
    activeTrainSearches--;
    trainSearchWaiters.shift()?.();
  }
}

/**
 * Dedupe + short-TTL cache for train searches — the same pattern
 * flights.ts uses for Duffel, for the same reason. The optimizer scores
 * many orderings that all need the SAME leg (same origin/destination/date):
 * a 5-city trip makes 480 searchTrains calls for 80 distinct legs. No cache
 * downstream can absorb that — compareLeg's Supabase read happens before
 * any of its writes, and All Aboard's location cache is keyed per city, not
 * per leg. Concurrent duplicates share one in-flight promise; failures are
 * evicted immediately so retries stay possible.
 */
const TRAIN_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const trainSearchCache = new Map<string, { at: number; promise: Promise<TrainOffer[]> }>();

function cachedTrainSearch(
  key: string,
  run: () => Promise<TrainOffer[]>,
): Promise<TrainOffer[]> {
  const hit = trainSearchCache.get(key);
  if (hit && Date.now() - hit.at < TRAIN_SEARCH_CACHE_TTL_MS) return hit.promise;

  const promise = run();
  trainSearchCache.set(key, { at: Date.now(), promise });
  promise.catch(() => {
    // Don't cache failures — the next caller should get a fresh attempt.
    if (trainSearchCache.get(key)?.promise === promise) trainSearchCache.delete(key);
  });

  // Opportunistic sweep so long-running processes don't accumulate entries.
  if (trainSearchCache.size > 500) {
    const cutoff = Date.now() - TRAIN_SEARCH_CACHE_TTL_MS;
    for (const [k, v] of trainSearchCache) {
      if (v.at < cutoff) trainSearchCache.delete(k);
    }
  }
  return promise;
}

/** Exposed for tests. */
export function clearTrainSearchCache(): void {
  trainSearchCache.clear();
}

/**
 * Query every train provider that covers the route, in parallel, and merge.
 * A provider failure is non-fatal (returns []), so one outage can't take
 * down the others. Empty result = no real train data → caller shows the
 * honest "no live train data" state.
 *
 * Deduped and concurrency-gated (see above): the optimizer asks for the same
 * leg once per candidate ordering, and the raw fan-out swamps both providers.
 *
 * Fares arrive per-person from the providers and leave as party totals —
 * see `toPartyTotal`. The cache key carries `travelers`, so a normalised
 * result is only ever reused for the same party size.
 */
export async function searchTrains(params: SearchTrainsParams): Promise<TrainOffer[]> {
  const { origin, destination, date, travelers, originCountry, destinationCountry } = params;
  // Both providers resolve city names case-insensitively, so normalise them
  // into the key — otherwise "Rome" and "rome" each pay for their own search.
  const key = [
    origin.toLowerCase(),
    destination.toLowerCase(),
    date,
    travelers,
    originCountry ?? '',
    destinationCountry ?? '',
  ].join('|');
  return cachedTrainSearch(key, () =>
    withTrainSearchSlot(() => searchTrainsUncached(params)),
  );
}

async function searchTrainsUncached(params: SearchTrainsParams): Promise<TrainOffer[]> {
  const active = trainProviders.filter((p) => p.coverage(params) !== 'none');
  const results = await Promise.all(
    active.map((p) =>
      p.search(params).catch((err: any) => {
        logger.warn('Train provider failed (non-fatal)', {
          provider: p.id,
          message: err?.message,
        });
        return [] as ProviderTrainOffer[];
      }),
    ),
  );
  return results.flat().map((offer) => toPartyTotal(offer, params.travelers));
}
