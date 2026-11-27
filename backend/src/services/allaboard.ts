import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { ProviderTrainOffer } from './trains';
import { isLongMinutes, longJourneyLimit } from './longJourney';

/**
 * All Aboard (allaboard.eu) — European rail search via their GraphQL API.
 *
 * Coverage: national operators across Western/Central Europe (SNCF, Trenitalia,
 * Renfe, DB, NS, SNCB, SBB, ÖBB, Eurostar, GB operators, Scandinavia…).
 * It is the only rail provider (trains.ts): Deutsche Bahn's community REST
 * API was removed in 2026-11 after it failed every production search.
 *
 * API shape (test gateway, key is test-scoped):
 *   getLocations(query)            → city/station uids (fast)
 *   getJourneys(origin, dest, date)→ timetable journeys, NO prices (~1-4s warm;
 *                                    10s+ on a route the gateway hasn't
 *                                    seen lately)
 *   getJourneyOffer(journey, …)    → live fares from the operators (SLOW —
 *                                    30s+ cold, ~3s once their cache is warm)
 *
 * Because live pricing is slow and quota-metered, we price up to
 * OFFER_CANDIDATES of the day's journeys (sensible-length daytime ones first,
 * see pickOfferCandidates) and return the rest unpriced (limitedCoverage):
 * a journey without a real fare is shown as such, never given an invented one.
 */

/** getLocations: a name lookup, fast even cold. */
const LOCATION_TIMEOUT_MS = 10_000;
/**
 * getJourneys. Was 10s, shared with getLocations, and a cold route routinely
 * ran past it: in one afternoon of trip searches (2026-11-18) 100 journey
 * calls aborted at 10s, and each of those legs was planned on a flight —
 * Vienna → Munich, Prague → Budapest, Amsterdam → Paris, Venice → Milan all
 * came back as trains on the next search. Legs search in parallel (8 slots),
 * so the wait is paid once per wave, not per leg.
 */
const JOURNEY_TIMEOUT_MS = 25_000;
const OFFER_TIMEOUT_MS = 30_000;
/**
 * How many journeys get live-priced per search. The cap is ours, not the
 * provider's: getJourneyOffer prices any journey id getJourneys returned.
 * It was 3 (first, middle and last of the day), and those are often the
 * worst three to price: live, 2027-03-19/20 (2026-11-23), Munich → Prague's
 * last was a 39h three-ticket journey, Vienna → Munich's first and last
 * were 05:38 and a 22:44 sleeper (NO_FARES), and the 18 daytime trains
 * between them got one fare. Salzburg → Prague went from 2 fares to 4.
 * Most of the newly picked journeys on that probe came back UNKNOWN (no
 * fare yet — the provider's cold path), as cold picks did under the old
 * rule, so the gain grows as their cache warms.
 *
 * Quota: pricing is getJourneyOffer only, which the timetable quota does
 * not meter. 6 doubles a NEW route-and-day's offer requests (3 → up to 6;
 * a search is 2 + 1 + up to 6 requests). The gateway sends no rate-limit
 * headers, so per-request is the honest unit. Repeats come from trains.ts's
 * 10-minute cache when the answer was complete.
 */
export const OFFER_CANDIDATES = 6;

/**
 * Most getJourneyOffer requests in flight at once, across every search: what
 * the rail gate let through before exp/optimizer-speed (8 searches ×
 * OFFER_CANDIDATES = 48). The gate now starts 24 searches at once
 * (trains.ts), which could ask 144 fares together — near the burst All Aboard
 * sheds, answering with no fare at all (trains.ts withTrainSearchSlot). The
 * timetables still all go out at once; the fares queue here, each request's
 * own timeout starting only when it is sent.
 */
export const MAX_CONCURRENT_OFFER_REQUESTS = 8 * OFFER_CANDIDATES;
let activeOfferRequests = 0;
const offerRequestWaiters: Array<() => void> = [];

async function withOfferSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (activeOfferRequests >= MAX_CONCURRENT_OFFER_REQUESTS) {
    await new Promise<void>((resolve) => offerRequestWaiters.push(resolve));
  }
  activeOfferRequests++;
  try {
    return await fn();
  } finally {
    activeOfferRequests--;
    offerRequestWaiters.shift()?.();
  }
}
/** Cap on unpriced schedule rows returned when pricing fails. */
const MAX_UNPRICED = 3;

/**
 * True while we talk to All Aboard's TEST gateway (the default URL — our
 * key is test-scoped). Its fares come from getJourneyOffer like production
 * ones, but they are not bookable inventory, and the UI says so.
 */
export function allAboardIsTestGateway(url: string = env.ALLABOARD_API_URL): boolean {
  try {
    return /(^|\.)test\./i.test(new URL(url).hostname);
  } catch {
    return true; // unreadable URL: don't claim production
  }
}

type GqlResponse<T> = { data?: T; errors?: Array<{ message: string }> };

async function gql<T>(
  query: string,
  variables: Record<string, unknown>,
  session: string,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(env.ALLABOARD_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/graphql-response+json',
        'api-key': env.ALLABOARD_API_KEY ?? '',
        session,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`All Aboard API returned ${res.status}`);
    const body = (await res.json()) as GqlResponse<T>;
    if (body.errors?.length) throw new Error(body.errors[0].message);
    if (!body.data) throw new Error('All Aboard API returned no data');
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeForMatch(s: string | undefined | null): string {
  return (s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

// city name (lowercased) → the lookup's PROMISE, resolving to a location uid
// or null when All Aboard doesn't know the city. Caching the promise rather
// than the settled uid is what makes this cache work under the optimizer's
// fan-out: the key used to be written only AFTER the gql await, so every
// concurrent caller for the same city missed and fired its own getLocations
// — 960 lookups for 5 distinct cities on a 5-city trip. Nulls are cached
// too so unknown cities cost one lookup; rejections are evicted so one
// transient failure doesn't poison the city for the process's lifetime.
const locationCache = new Map<string, Promise<string | null>>();

/** Exposed for tests. */
export function clearLocationCache(): void {
  locationCache.clear();
}

type AaLocation = { uid: string; name: string };

/**
 * Resolve a city name to an All Aboard location uid. Their search returns
 * fuzzy matches (querying "Paris" can surface "Palermo" too), so we only
 * accept a result whose name actually corresponds to the requested city.
 *
 * Concurrent callers for the same city share one in-flight lookup — see
 * locationCache above for why that matters.
 */
export function getAllAboardLocationUid(
  city: string,
  session: string,
): Promise<string | null> {
  const key = city.toLowerCase();
  const hit = locationCache.get(key);
  if (hit) return hit;

  const lookup = resolveLocationUid(city, session);
  locationCache.set(key, lookup);
  lookup.catch(() => {
    // Don't cache failures — the next caller should get a fresh attempt.
    if (locationCache.get(key) === lookup) locationCache.delete(key);
  });
  return lookup;
}

async function resolveLocationUid(city: string, session: string): Promise<string | null> {
  const data = await gql<{ getLocations: AaLocation[] }>(
    `query($q: String!) { getLocations(query: $q) { uid name } }`,
    { q: city },
    session,
    LOCATION_TIMEOUT_MS,
  );

  const want = normalizeForMatch(city);
  const match =
    (data.getLocations ?? []).find((l) => {
      const got = normalizeForMatch(l.name);
      return got === want || got.startsWith(want) || want.startsWith(got);
    }) ?? null;

  return match?.uid ?? null;
}

type AaSegment = {
  origin?: { name?: string };
  destination?: { name?: string };
  departureAt?: string;
  arrivalAt?: string;
  operator?: { name?: string };
};

type AaJourney = {
  id: string;
  /** LOADING | SUCCESS | ERROR. */
  status?: string;
  /** SegmentCollection.status: SUCCESS, RATE_LIMITED, NO_TIMETABLE, … */
  itinerary?: Array<{ status?: string; segments?: AaSegment[] }>;
};

/**
 * Statuses that mean "no answer yet", not "no trains". The gateway still
 * returns a journey for these, with `segments: null`, so without reading the
 * status they looked exactly like an empty timetable and were cached as one.
 * Seen 2026-11-18: the key's 500-an-hour timetable quota ran out and every
 * search came back RATE_LIMITED for the rest of the hour — on production too,
 * which shares the key. The others (NO_TIMETABLE, NO_FARES, UNABLE_TO_SELL,
 * OUTSIDE_TIMETABLE, ONE_DAY, …) are real answers about the route.
 */
const TRANSIENT_STATUSES = new Set(['LOADING', 'ERROR', 'RATE_LIMITED', 'INDETERMINATE', 'UNKNOWN']);

function transientStatuses(statuses: Array<string | undefined>): string[] {
  return [...new Set(statuses.filter((x): x is string => !!x && TRANSIENT_STATUSES.has(x)))];
}

type AaOffer = { id: string; price?: { amount?: number; currency?: string } };

type AaJourneyOffer = {
  itinerary?: Array<{ status?: string; segments?: AaSegment[]; offers?: AaOffer[] }>;
};

/** Flatten an itinerary's SegmentCollections into one segment list. */
function segmentsOf(itinerary?: Array<{ segments?: AaSegment[] }>): AaSegment[] {
  return (itinerary ?? []).flatMap((item) => item.segments ?? []);
}

type SearchParams = {
  origin: string;
  destination: string;
  date: string;
  travelers: number;
};

/** A departure's local hour, read from its ISO string ("…T06:49:00+01:00"). */
function localHour(iso: string | undefined): number | null {
  const m = /T(\d{2}):/.exec(iso ?? '');
  return m ? Number(m[1]) : null;
}

/** Departures from 06:00 up to 21:00 local count as daytime. */
const DAY_START_HOUR = 6;
const DAY_END_HOUR = 21;

/** `k` items spread evenly over `items` (in their order), always keeping the first and last. */
function spread<T>(items: T[], k: number): T[] {
  if (items.length <= k) return items;
  if (k <= 0) return [];
  if (k === 1) return [items[0]];
  const picked = new Set<number>();
  for (let i = 0; i < k; i++) picked.add(Math.round((i * (items.length - 1)) / (k - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => items[i]);
}

export type OfferCandidateInput = { departure?: string; durationMinutes: number | null };

/**
 * Pick which of the day's journeys (in timetable order) to live-price, at
 * most `cap` of them, returned as indices in timetable order.
 *
 * Journeys that are long by longJourney.ts's rule (over max(fastest × 2,
 * fastest + 3h)) are never priced: every picker downstream puts them behind
 * any sensible option, so a fare for one is quota spent on a train nobody is
 * offered. Of the rest, daytime departures (06:00–21:00) come first, then
 * night ones; when a group has more journeys than the slots left, they are
 * spread across the day rather than taking the earliest.
 */
export function pickOfferCandidates(
  journeys: OfferCandidateInput[],
  cap: number = OFFER_CANDIDATES,
): number[] {
  const limit = longJourneyLimit(journeys.map((j) => j.durationMinutes));
  const day: number[] = [];
  const night: number[] = [];
  journeys.forEach((j, i) => {
    if (isLongMinutes(j.durationMinutes, limit)) return;
    const h = localHour(j.departure);
    (h != null && h >= DAY_START_HOUR && h < DAY_END_HOUR ? day : night).push(i);
  });
  const fromDay = spread(day, cap);
  const fromNight = spread(night, cap - fromDay.length);
  return [...fromDay, ...fromNight].sort((a, b) => a - b);
}

/**
 * A lighter search, for ranking only (prototype variant B2,
 * exp/optimizer-speed): direct trains only (`filter: {types: [NON_STOP]}`,
 * which getJourneys accepts) and fewer journeys priced. Ranking needs a fare
 * per city pair, not the day's timetable.
 */
export type AllAboardSearchOptions = { nonStopOnly?: boolean; offerCandidates?: number };

/**
 * What a search found, and whether that is the whole answer. `complete` is
 * false when a call failed or timed out — the journey list, a location
 * lookup, or pricing for one of the picked journeys. An incomplete result is
 * still the best we have for THIS request, but it says nothing about the
 * route, so callers must not remember it (trains.ts drops it from its 10-min
 * cache). Before this a cold search that timed out returned [] that was
 * cached like "no trains here": every trip search for the next 10 minutes
 * priced the route on flights only, even once All Aboard was warm.
 */
export type AllAboardResult = { offers: ProviderTrainOffer[]; complete: boolean };

/** Offers only — the result of {@link searchAllAboardDetailed} without its completeness flag. */
export async function searchAllAboard(params: SearchParams): Promise<ProviderTrainOffer[]> {
  return (await searchAllAboardDetailed(params)).offers;
}

export async function searchAllAboardDetailed(
  params: SearchParams,
  opts: AllAboardSearchOptions = {},
): Promise<AllAboardResult> {
  if (!env.ALLABOARD_API_KEY) return { offers: [], complete: true };
  const { origin, destination, date } = params;
  const session = randomUUID();

  try {
    const [fromUid, toUid] = await Promise.all([
      getAllAboardLocationUid(origin, session),
      getAllAboardLocationUid(destination, session),
    ]);
    if (!fromUid || !toUid) {
      logger.info('All Aboard: city not in coverage', { origin, destination });
      return { offers: [], complete: true };
    }

    const data = await gql<{ getJourneys: AaJourney[] }>(
      `query($o: ID!, $d: ID!, $date: Date!) {
        getJourneys(origin: $o, destination: $d, date: $date${opts.nonStopOnly ? ', filter: {types: [NON_STOP]}' : ''}) {
          id
          status
          itinerary {
            ... on SegmentCollection {
              status
              segments {
                origin { name }
                destination { name }
                departureAt
                arrivalAt
                operator { name }
              }
            }
          }
        }
      }`,
      { o: fromUid, d: toUid, date },
      session,
      JOURNEY_TIMEOUT_MS,
    );

    const returned = data.getJourneys ?? [];
    const notYet = transientStatuses(
      returned.flatMap((j) => [j.status, ...(j.itinerary ?? []).map((it) => it.status)]),
    );
    if (notYet.length > 0) {
      logger.warn('All Aboard journey search incomplete', { origin, destination, date, statuses: notYet });
    }
    const journeys = returned.filter((j) => segmentsOf(j.itinerary).length > 0);
    if (journeys.length === 0) return { offers: [], complete: notYet.length === 0 };
    let pricingFailed = notYet.length > 0;

    // Live-price the picked journeys (pickOfferCandidates). USD is requested natively so
    // no FX conversion is needed. Amounts arrive in cents. Failures are
    // per-journey and non-fatal.
    //
    // The offer is requested for the WHOLE PARTY — one ADULT entry per
    // traveller — so any group pricing the operator applies is in the number
    // we get back. Verified on the sandbox 2026-09-21 (Paris→Lyon, same
    // journey: 1 adult $53.88, 2 adults $107.77, ratio 2.0002), which was the
    // precondition for doing this: if the amount had not scaled with the
    // passenger count, dividing it would have silently produced a fraction of
    // the real fare.
    //
    // The `ProviderTrainOffer` contract stays PER-PERSON (every provider
    // hands over one adult's fare and is scaled ×N downstream), so the party
    // total is divided by the party here and `toPartyTotal` in
    // searchTrains multiplies it straight back — their exact figure, and no
    // path on which it can be multiplied twice.
    const party = Math.max(1, Math.floor(params.travelers) || 1);
    const passengers = Array.from({ length: party }, () => '{type: ADULT}').join(', ');
    const candidates = pickOfferCandidates(
      journeys.map((j) => {
        const segs = segmentsOf(j.itinerary);
        const dep = segs[0]?.departureAt;
        const arr = segs[segs.length - 1]?.arrivalAt;
        const minutes = dep && arr ? (new Date(arr).getTime() - new Date(dep).getTime()) / 60000 : NaN;
        return { departure: dep, durationMinutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null };
      }),
      opts.offerCandidates ?? OFFER_CANDIDATES,
    );
    const priced = new Map<number, number>();
    await Promise.all(
      candidates.map(async (idx) => {
        try {
          const offerData = await withOfferSlot(() => gql<{ getJourneyOffer: AaJourneyOffer }>(
            `query($j: ID!) {
              getJourneyOffer(journey: $j, passengers: [${passengers}], currency: "USD") {
                itinerary {
                  ... on SegmentCollection { status offers { id price { amount currency } } }
                }
              }
            }`,
            { j: journeys[idx].id },
            session,
            OFFER_TIMEOUT_MS,
          ));
          // `price.currency` was selected in the query above and typed on
          // AaOffer, but never read: the amount was taken as-is and then
          // stamped `currency: 'USD'` below, so a non-USD fare would be read
          // as dollars by the trip total and by compareLeg's cheapest and
          // priceDifference. Same failure as the hotel and flight paths, in
          // the one provider that was missed.
          //
          // The query DOES ask for USD (`currency: "USD"` above), so an absent
          // code means "as requested" and is trusted — dropping those would
          // lose all rail pricing over a field the provider simply did not
          // echo. But asking is not receiving: Booking ignores the same kind
          // of request often enough that there is a comment about it in
          // hotels.ts, so a code that comes back DIFFERENT is converted rather
          // than believed. Rates are per unit, so convert after the cents
          // divide.
          const { convertToUsd } = await import('./currency');
          // RATE_LIMITED (the separate 500/hour offer quota) and friends:
          // no fare yet, which is not "no fare" — keep it out of the cache.
          const offerNotYet = transientStatuses(
            (offerData.getJourneyOffer.itinerary ?? []).map((item) => item.status),
          );
          if (offerNotYet.length > 0) {
            pricingFailed = true;
            logger.warn('All Aboard offer pricing incomplete', { journey: journeys[idx]?.id, statuses: offerNotYet });
          }
          // One SegmentCollection is one TICKET for part of the journey —
          // Salzburg → Prague via Vienna (2027-03-21, 19:07) came back as
          // Salzburg → Wien $257.20 and Wien → Praha $130.67 for two adults.
          // Its offers are alternative fares (classes) for that ticket. So a
          // journey costs the cheapest fare of EACH ticket, summed, and has no
          // price when any ticket has none. Taking the cheapest offer across
          // every ticket priced that journey as one of its parts ($130.67
          // for a $387.87 trip), which then won every cheapest-train pick.
          const tickets = offerData.getJourneyOffer.itinerary ?? [];
          let total = 0;
          let everyTicketPriced = tickets.length > 0;
          for (const ticket of tickets) {
            const usdAmounts: number[] = [];
            for (const o of ticket.offers ?? []) {
              const raw = o.price?.amount;
              if (typeof raw !== 'number' || !(raw > 0)) continue;
              const units = raw / 100;
              const code = o.price?.currency?.trim().toUpperCase();

              if (!code || code === 'USD') {
                usdAmounts.push(units);
                continue;
              }

              const usd = await convertToUsd(units, code);
              if (usd === null || !Number.isFinite(usd) || usd <= 0) {
                logger.warn('All Aboard offer dropped — no USD rate for its currency', {
                  journey: journeys[idx]?.id,
                  currency: code,
                });
                continue;
              }
              logger.warn('All Aboard quoted a currency other than the USD requested', {
                journey: journeys[idx]?.id,
                currency: code,
              });
              usdAmounts.push(usd);
            }
            if (usdAmounts.length === 0) {
              everyTicketPriced = false;
              break;
            }
            total += Math.min(...usdAmounts);
          }
          if (everyTicketPriced && total > 0) priced.set(idx, total / party);
        } catch (err: any) {
          pricingFailed = true;
          logger.warn('All Aboard offer pricing failed (non-fatal)', {
            message: err?.message,
            journey: journeys[idx]?.id,
          });
        }
      }),
    );

    const toOffer = (j: AaJourney, idx: number): ProviderTrainOffer | null => {
      const segs = segmentsOf(j.itinerary);
      const dep = segs[0]?.departureAt;
      const arr = segs[segs.length - 1]?.arrivalAt;
      if (!dep || !arr) return null;
      const durationMinutes = Math.round(
        (new Date(arr).getTime() - new Date(dep).getTime()) / 60000,
      );
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
      const operators = [
        ...new Set(segs.map((s) => s.operator?.name).filter(Boolean)),
      ] as string[];
      const pricePerPerson = priced.get(idx) ?? null;
      return {
        id: `aa-${j.id}`,
        pricePerPerson,
        currency: 'USD',
        departure: dep,
        arrival: arr,
        durationMinutes,
        operator: operators.join(' + ') || 'Rail operator',
        trainType: 'train',
        bookingUrl: null,
        limitedCoverage: pricePerPerson == null,
        ...(pricePerPerson != null
          ? { priceSource: { kind: 'live' as const, provider: 'All Aboard', ...(allAboardIsTestGateway() ? { testApi: true } : {}) } }
          : {}),
      };
    };

    // Priced journeys lead; unpriced timetable rows follow (capped) so the
    // UI still shows real schedules when live pricing was slow or down.
    const all = journeys
      .map(toOffer)
      .map((offer, idx) => ({ offer, idx }))
      .filter((x): x is { offer: ProviderTrainOffer; idx: number } => x.offer != null);
    const pricedOffers = all.filter((x) => priced.has(x.idx)).map((x) => x.offer);
    const unpricedOffers = all
      .filter((x) => !priced.has(x.idx))
      .map((x) => x.offer)
      .slice(0, pricedOffers.length > 0 ? 1 : MAX_UNPRICED);
    return { offers: [...pricedOffers, ...unpricedOffers], complete: !pricingFailed };
  } catch (err: any) {
    logger.warn('All Aboard search failed (non-fatal)', {
      message: err?.message,
      origin,
      destination,
    });
    return { offers: [], complete: false };
  }
}
