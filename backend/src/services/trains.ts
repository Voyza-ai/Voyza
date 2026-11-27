import { env } from '../config/env';
import { logger } from '../utils/logger';
import { searchAllAboardDetailed } from './allaboard';
import type { Co2Figure, DoorToDoor } from './legFacts';

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
  /**
   * Where `price` came from, so the UI can say "live fare" only when it is
   * one. Absent when there is no price.
   */
  priceSource?: RailPriceSource;
  /** Door-to-door time — set by compareLeg / legOptions, which know the cities. */
  doorToDoor?: DoorToDoor | null;
  /** Party CO₂ estimate — set by compareLeg / legOptions. */
  co2?: Co2Figure | null;
};

/**
 * Provenance of a rail fare.
 *
 *   live       a fare a provider's fare API returned for this search.
 *              `testApi` is set when that provider is its TEST gateway
 *              (All Aboard's key is test-scoped today), so the UI can say
 *              so rather than pass it off as bookable inventory.
 *   cached     a fare from leg_price_cache — a live fare from an earlier
 *              search (≤ 2 h old); the row does not record which provider.
 *   estimated  not from a provider at all. Nothing produces this today
 *              (there are no static fare tables — see the provider
 *              registry below); the UI handles it so one can never be
 *              shown as live by accident.
 */
export type RailPriceSource = {
  kind: 'live' | 'cached' | 'estimated';
  provider?: string;
  testApi?: boolean;
};

/**
 * What a train provider returns, named for its unit. Every rail source we
 * query quotes a single adult: All Aboard asks for `[{type: ADULT}]`. So
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

type SearchTrainsParams = {
  origin: string;
  destination: string;
  date: string;
  travelers: number;
  originCountry?: string;
  destinationCountry?: string;
};

// ─── Provider registry ──────────────────────────────────────────
// Each train data source is a "provider". Today there is one: All Aboard
// (pan-EU rail). Deutsche Bahn's community REST API (db.transport.rest) was
// the other until 2026-11: it failed every search on production ("fetch
// failed") for weeks, so it was removed rather than kept behind its circuit
// breaker. Trainline / Kiwi-rail / regional operators plug in here as they
// come online — register a provider and `searchTrains` picks it up.
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
  search(params: SearchTrainsParams): Promise<ProviderResult>;
}

/**
 * A provider's offers, and whether they are the whole answer for the route.
 * `complete: false` (a timeout, an error, pricing that didn't come back)
 * keeps the result out of the train-search cache — see cachedTrainSearch.
 */
type ProviderResult = { offers: ProviderTrainOffer[]; complete: boolean };

const trainProviders: TrainProvider[] = [
  {
    id: 'allaboard',
    // Pan-EU rail (SNCF, Trenitalia, Renfe, NS, Eurostar…). Active only
    // when a key is configured; its own location matching decides real
    // coverage per route.
    coverage: () => (env.ALLABOARD_API_KEY ? 'partial' : 'none'),
    search: (p) => searchAllAboardDetailed(p),
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
  const { pricePerPerson, priceSource, ...rest } = offer;
  const party = Math.max(1, Math.floor(travelers) || 1);
  return {
    ...rest,
    // A source only travels with a fare: an unpriced row has nothing to label.
    ...(pricePerPerson != null && priceSource ? { priceSource } : {}),
    price:
      pricePerPerson == null ? null : Math.round(pricePerPerson * party * 100) / 100,
  };
}

/**
 * Global cap on concurrent train searches — the same gate flights.ts puts
 * in front of Duffel, sized for a coarser unit of work. One slot here is a
 * whole route's provider fan-out: All Aboard spends up to 9 requests per
 * route (2 location lookups, 1 getJourneys, up to 6 getJourneyOffer),
 * where MAX_CONCURRENT_SEARCHES gates a single
 * Duffel call — so 8 slots is roughly the same order of concurrent
 * provider requests as that 6.
 *
 * Why it's needed: the optimizer fans out over every candidate ordering
 * (120 orderings × 4 legs = 480 concurrent compareLeg calls for a 5-city
 * trip). The dedupe below collapses those to ~80 distinct legs, but
 * ungated those 80 still fire up to ~480 getJourneyOffer calls at once — the
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
  run: () => Promise<{ offers: TrainOffer[]; complete: boolean }>,
): Promise<TrainOffer[]> {
  const hit = trainSearchCache.get(key);
  if (hit && Date.now() - hit.at < TRAIN_SEARCH_CACHE_TTL_MS) return hit.promise;

  const run$ = run();
  const promise = run$.then((r) => r.offers);
  trainSearchCache.set(key, { at: Date.now(), promise });
  const evict = () => {
    if (trainSearchCache.get(key)?.promise === promise) trainSearchCache.delete(key);
  };
  // Don't cache failures — the next caller should get a fresh attempt. Same
  // for an incomplete answer (a provider timed out or errored): callers
  // already waiting share it, but it is not "this route's trains" for the
  // next 10 minutes.
  run$.then((r) => { if (!r.complete) evict(); }, evict);

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

async function searchTrainsUncached(
  params: SearchTrainsParams,
): Promise<{ offers: TrainOffer[]; complete: boolean }> {
  const active = trainProviders.filter((p) => p.coverage(params) !== 'none');
  const results = await Promise.all(
    active.map((p) =>
      p.search(params).catch((err: any): ProviderResult => {
        logger.warn('Train provider failed (non-fatal)', {
          provider: p.id,
          message: err?.message,
        });
        return { offers: [], complete: false };
      }),
    ),
  );
  return {
    offers: results.flatMap((r) => r.offers).map((offer) => toPartyTotal(offer, params.travelers)),
    complete: results.every((r) => r.complete),
  };
}
