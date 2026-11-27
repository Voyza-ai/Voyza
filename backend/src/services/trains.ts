import { env } from '../config/env';
import { getSupabase } from './supabase';
import { logger } from '../utils/logger';
import { searchAllAboardDetailed, type AllAboardSearchOptions } from './allaboard';
import { trainSearchKey } from './trainKey';
import type { Co2Figure, DoorToDoor } from './legFacts';

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

/**
 * Circuit breaker for Deutsche Bahn REST.
 *
 * The timeout above bounds ONE search, but every search still pays it. When
 * the upstream is down it is down for every leg: measured from this container
 * on 2026-10-29, db.transport.rest answered 503 after 10.47-10.73s, so the
 * 4.5s abort fired on every request. compareLeg awaits flights and trains
 * together, so each leg waited the full 4.5s for nothing, round after round
 * through the 8-slot gate below: +7.3s on a 3-city optimize, +28.3s on a
 * 5-city one, ~+2.7s per canvas leg repair (mocked-latency harness, Duffel
 * calibrated at 1.5-1.9s per search).
 *
 * So the first failure that says "the service is down" — our own timeout
 * abort, an HTTP 5xx, or a network error — opens the breaker for
 * DB_BREAKER_OPEN_MS, and every Deutsche Bahn search in that window returns
 * [] at once, before the db_stops reads. Rail from All Aboard is unaffected:
 * this is one provider's breaker, not the rail search's.
 *
 * Deliberately NOT a trip: a 4xx, "No stop found", a malformed body. Those
 * are about one query, and the next leg may well succeed.
 *
 * When the window ends, no user request is sent in to test the water. The
 * first search after it still answers [] immediately and starts ONE
 * background probe; the probe closes the breaker if DB REST answers, or
 * re-opens it for another window if not. Nothing runs while the process is
 * idle, so there is no timer to keep alive.
 */
const DB_BREAKER_OPEN_MS = 5 * 60 * 1000;
/** Epoch ms the breaker stays open until; 0 = closed. */
let dbBreakerOpenUntil = 0;
let dbBreakerProbe: Promise<void> | null = null;

/** A failure that is about the upstream, not about this one query. */
function isDbUpstreamFailure(err: any): boolean {
  // Our own timeout (AbortController → DOMException 'AbortError').
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') return true;
  // undici's shape for DNS / refused / reset: TypeError('fetch failed').
  return err instanceof TypeError && /fetch failed/i.test(err.message ?? '');
}

function openDbBreaker(reason: string): void {
  const wasClosed = dbBreakerOpenUntil === 0;
  dbBreakerOpenUntil = Date.now() + DB_BREAKER_OPEN_MS;
  // Once per outage, not once per leg — every leg in flight fails together.
  if (wasClosed) {
    logger.warn('Deutsche Bahn REST unavailable — rail searches skip it for 5 minutes', {
      reason,
    });
  }
}

/** True while searches must skip Deutsche Bahn. Starts the re-probe when due. */
function dbBreakerIsOpen(): boolean {
  if (dbBreakerOpenUntil === 0) return false;
  if (Date.now() >= dbBreakerOpenUntil && !dbBreakerProbe) {
    dbBreakerProbe = probeDbRest().finally(() => {
      dbBreakerProbe = null;
    });
  }
  return true;
}

async function probeDbRest(): Promise<void> {
  const url = `${env.DB_REST_BASE_URL}/locations?query=Berlin&results=1&poi=false&addresses=false`;
  try {
    const res = await fetchWithTimeout(url);
    if (res.ok) {
      dbBreakerOpenUntil = 0;
      logger.info('Deutsche Bahn REST answered the re-probe — rail search resumed');
      return;
    }
    dbBreakerOpenUntil = Date.now() + DB_BREAKER_OPEN_MS;
  } catch {
    dbBreakerOpenUntil = Date.now() + DB_BREAKER_OPEN_MS;
  }
}

/** Every Deutsche Bahn request goes through here so a dead upstream trips the breaker. */
async function fetchDbRest(url: string): Promise<Response> {
  try {
    const res = await fetchWithTimeout(url);
    if (res.status >= 500) openDbBreaker(`HTTP ${res.status}`);
    return res;
  } catch (err: any) {
    if (isDbUpstreamFailure(err)) openDbBreaker(err?.name ?? 'network error');
    throw err;
  }
}

/** Exposed for tests: close the breaker and forget any probe in flight. */
export function resetDbBreaker(): void {
  dbBreakerOpenUntil = 0;
  dbBreakerProbe = null;
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

  const res = await fetchDbRest(url);
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
  search(params: SearchTrainsParams, aaOptions?: AllAboardSearchOptions): Promise<ProviderResult>;
}

/**
 * A provider's offers, and whether they are the whole answer for the route.
 * `complete: false` (a timeout, an error, pricing that didn't come back)
 * keeps the result out of the train-search cache — see cachedTrainSearch.
 */
type ProviderResult = { offers: ProviderTrainOffer[]; complete: boolean };

/**
 * Deutsche Bahn REST provider. Always attempts (returns 'partial') and lets
 * the real API result + station-match filter decide whether there's actually
 * a journey — no hardcoded country list claiming coverage we don't have.
 */
async function searchDeutscheBahn(params: SearchTrainsParams): Promise<ProviderTrainOffer[]> {
  const { origin, destination, date } = params;

  // Upstream known down: answer now, without the db_stops reads either.
  if (dbBreakerIsOpen()) return [];

  try {
    const [fromId, toId] = await Promise.all([
      getStopId(origin),
      getStopId(destination),
    ]);

    const baseUrl = env.DB_REST_BASE_URL;
    const departureISO = new Date(date).toISOString();
    const url = `${baseUrl}/journeys?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}&departure=${encodeURIComponent(departureISO)}&results=5&stopovers=false`;

    const res = await fetchDbRest(url);
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
          ...(pricePerPerson != null
            ? { priceSource: { kind: 'live' as const, provider: 'Deutsche Bahn' } }
            : {}),
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
    const priced = await Promise.all(
      mapped.map(async (t) => {
        // No USD short-circuit: convertToUsd decides, and returns null for a
        // blank or malformed code rather than trusting the number.
        if (t.pricePerPerson == null) return t;
        const usd = await convertToUsd(t.pricePerPerson, t.currency);
        if (usd === null) {
          logger.warn('Train fare unpriced — no USD rate for its currency', {
            currency: t.currency,
            origin,
            destination,
          });
          return { ...t, pricePerPerson: null, limitedCoverage: true, priceSource: undefined };
        }

        // Conversion rounds to cents, so a small amount in a weak currency can
        // come out as exactly 0 — and a $0 fare is not a free train, it is an
        // unknown one. This path already has the right way to say that.
        if (!Number.isFinite(usd) || usd <= 0) {
          logger.warn('Train fare unpriced — converted price rounded to zero', {
            raw: t.pricePerPerson,
            currency: t.currency,
            usd,
            origin,
            destination,
          });
          return { ...t, pricePerPerson: null, limitedCoverage: true, priceSource: undefined };
        }

        return { ...t, pricePerPerson: usd, currency: 'USD' };
      }),
    );

    // Trains do not drop an unconvertible fare, they null it — so the failure
    // shows up as a route where every option is "limited coverage" rather than
    // as an empty list, which is quieter still. Say it once for the route.
    const unpriced = priced.filter((t) => t.pricePerPerson == null).length;
    if (unpriced > 0 && unpriced === priced.length) {
      logger.warn('Every train fare on this route is unpriced', {
        origin,
        destination,
        offers: priced.length,
        currencies: [...new Set(mapped.map((t) => t.currency || '(blank)'))],
      });
    }

    return priced;
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
    search: (p, aaOptions) => searchAllAboardDetailed(p, aaOptions),
  },
  {
    id: 'deutsche-bahn',
    // Always attempt — real results (+ the station-match filter) decide
    // whether there's a journey, instead of guessing from a country list.
    coverage: () => 'partial',
    // Its own circuit breaker decides when it's down; results are taken as
    // they always were.
    search: async (p) => ({ offers: await searchDeutscheBahn(p), complete: true }),
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
//
// Prototype (exp/optimizer-speed): 24, was 8. The optimizer now searches
// every city pair's trains at once, up front, and ranks on what answered
// within RAIL_RANKING_WAIT_MS (optimizer.ts). With 8 slots a 4-city trip's
// 12 pairs and a 5-city trip's 20 queued behind the first 8, each slot held
// for a whole cold search (~16-25 s), so the pairs past the eighth could not
// even start inside that wait. 24 starts a 5-city trip's 20 pairs at once —
// still a bound, but the shedding burst described above was ~240 fare
// requests; 24 searches is at most 72. OPT_TRAIN_SLOTS overrides it for the
// benchmark harness (backend/scripts/opt-bench).
const MAX_CONCURRENT_TRAIN_SEARCHES = Number(process.env.OPT_TRAIN_SLOTS) > 0 ? Number(process.env.OPT_TRAIN_SLOTS) : 24;
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

/**
 * Route-days every provider answered, completely, with no journey at all: a
 * real "no route" (All Aboard: no timetable that day, or a city it does not
 * cover), not a search that timed out or came back ERROR/UNKNOWN. Remembered
 * for NO_ROUTE_TTL_MS, past the 10-minute cache, so later plans do not ask
 * again for a route the provider has said does not exist.
 *
 * An INCOMPLETE answer is never remembered, here or in the cache: a cold All
 * Aboard search answers `[ERROR, UNKNOWN]` after 13-25 s and very often finds
 * the train the next time (2026-11-24: Paris -> Berlin, Amsterdam -> Berlin,
 * Paris -> Berlin on T2), so remembering it turned other users' plans
 * flights-only. (An earlier prototype did, for 15 minutes; replaced.)
 *
 * In memory, per process — a prototype (exp/optimizer-speed).
 */
const NO_ROUTE_TTL_MS = 24 * 60 * 60 * 1000;
const noRoute = new Map<string, number>();

function cachedTrainSearch(
  key: string,
  run: () => Promise<{ offers: TrainOffer[]; complete: boolean }>,
): Promise<TrainOffer[]> {
  const hit = trainSearchCache.get(key);
  if (hit && Date.now() - hit.at < TRAIN_SEARCH_CACHE_TTL_MS) return hit.promise;

  const knownNoRoute = noRoute.get(key);
  if (knownNoRoute !== undefined) {
    if (Date.now() - knownNoRoute < NO_ROUTE_TTL_MS) return Promise.resolve([]);
    noRoute.delete(key);
  }

  const run$ = run();
  const promise = run$.then((r) => r.offers);
  trainSearchCache.set(key, { at: Date.now(), promise });
  const evict = () => {
    if (trainSearchCache.get(key)?.promise === promise) trainSearchCache.delete(key);
  };
  // Don't cache failures — the next caller should get a fresh attempt. Same
  // for an incomplete answer (a provider timed out or errored): callers
  // already waiting share it, but it is not "this route's trains" for the
  // next 10 minutes. A complete answer with nothing in it is a real "no
  // route", remembered for a day (noRoute).
  run$.then(
    (r) => {
      if (!r.complete) {
        evict();
        return;
      }
      if (r.offers.length === 0) noRoute.set(key, Date.now());
      else noRoute.delete(key);
    },
    evict,
  );

  // Opportunistic sweep so long-running processes don't accumulate entries.
  if (trainSearchCache.size > 500) {
    const cutoff = Date.now() - TRAIN_SEARCH_CACHE_TTL_MS;
    for (const [k, v] of trainSearchCache) {
      if (v.at < cutoff) trainSearchCache.delete(k);
    }
  }
  if (noRoute.size > 5000) {
    const cutoff = Date.now() - NO_ROUTE_TTL_MS;
    for (const [k, at] of noRoute) {
      if (at < cutoff) noRoute.delete(k);
    }
  }
  return promise;
}

/** Exposed for tests. */
export function clearTrainSearchCache(): void {
  trainSearchCache.clear();
  noRoute.clear();
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
export async function searchTrains(
  params: SearchTrainsParams,
  /**
   * quick: All Aboard's lighter search, for the optimizer's ranking only
   * (AllAboardSearchOptions: direct trains only, 2 journeys priced). Its own
   * cache key: it is not the route-day's whole timetable, and "no direct
   * train" is not "no route".
   */
  opts: { quick?: boolean } = {},
): Promise<TrainOffer[]> {
  const key = trainSearchKey(params) + (opts.quick ? '|quick' : '');
  return cachedTrainSearch(key, () =>
    withTrainSearchSlot(() => searchTrainsUncached(params, opts.quick ? QUICK_RAIL : {})),
  );
}

/** The ranking's rail search (see searchTrains' `quick`). */
const QUICK_RAIL: AllAboardSearchOptions = { nonStopOnly: true, offerCandidates: 2 };

export type { SearchTrainsParams };

async function searchTrainsUncached(
  params: SearchTrainsParams,
  aaOptions: AllAboardSearchOptions = {},
): Promise<{ offers: TrainOffer[]; complete: boolean }> {
  const active = trainProviders.filter((p) => p.coverage(params) !== 'none');
  const results = await Promise.all(
    active.map((p) =>
      p.search(params, aaOptions).catch((err: any): ProviderResult => {
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
