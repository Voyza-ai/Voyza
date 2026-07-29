import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import type { TrainOffer } from './trains';

/**
 * All Aboard (allaboard.eu) — European rail search via their GraphQL API.
 *
 * Coverage: national operators across Western/Central Europe (SNCF, Trenitalia,
 * Renfe, DB, NS, SNCB, SBB, ÖBB, Eurostar, GB operators, Scandinavia…).
 * This is the first real pan-EU rail source; db.transport.rest remains as a
 * second provider (strong DACH schedules) and results are merged upstream.
 *
 * API shape (test gateway, key is test-scoped):
 *   getLocations(query)            → city/station uids (fast)
 *   getJourneys(origin, dest, date)→ timetable journeys, NO prices (fast, ~1-2s)
 *   getJourneyOffer(journey, …)    → live fares from the operators (SLOW —
 *                                    30s+ cold, ~3s once their cache is warm)
 *
 * Because live pricing is slow, we only price a few journeys spread across
 * the day and return the rest unpriced (limitedCoverage), matching the
 * honest-data pattern used for Deutsche Bahn fares.
 */

const JOURNEY_TIMEOUT_MS = 10_000;
const OFFER_TIMEOUT_MS = 30_000;
/** How many journeys get live-priced per search (spread across the day). */
const OFFER_CANDIDATES = 3;
/** Cap on unpriced schedule rows returned when pricing fails. */
const MAX_UNPRICED = 3;

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

// city name (lowercased) → location uid, or null when All Aboard doesn't
// know the city. Nulls are cached too so unknown cities cost one lookup.
const locationCache = new Map<string, string | null>();

/** Exposed for tests. */
export function clearLocationCache(): void {
  locationCache.clear();
}

type AaLocation = { uid: string; name: string };

/**
 * Resolve a city name to an All Aboard location uid. Their search returns
 * fuzzy matches (querying "Paris" can surface "Palermo" too), so we only
 * accept a result whose name actually corresponds to the requested city.
 */
export async function getAllAboardLocationUid(
  city: string,
  session: string,
): Promise<string | null> {
  const key = city.toLowerCase();
  if (locationCache.has(key)) return locationCache.get(key) ?? null;

  const data = await gql<{ getLocations: AaLocation[] }>(
    `query($q: String!) { getLocations(query: $q) { uid name } }`,
    { q: city },
    session,
    JOURNEY_TIMEOUT_MS,
  );

  const want = normalizeForMatch(city);
  const match =
    (data.getLocations ?? []).find((l) => {
      const got = normalizeForMatch(l.name);
      return got === want || got.startsWith(want) || want.startsWith(got);
    }) ?? null;

  locationCache.set(key, match?.uid ?? null);
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
  itinerary?: Array<{ segments?: AaSegment[] }>;
};

type AaOffer = { id: string; price?: { amount?: number; currency?: string } };

type AaJourneyOffer = {
  itinerary?: Array<{ segments?: AaSegment[]; offers?: AaOffer[] }>;
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

/**
 * Pick which journeys to live-price: first, middle, and last of the day.
 * Pricing is the slow call, so a spread gives morning/midday/evening fares
 * without paying the cost of pricing all ~20 timetable entries.
 */
function pickOfferCandidates(count: number): number[] {
  if (count <= OFFER_CANDIDATES) return Array.from({ length: count }, (_, i) => i);
  return [0, Math.floor(count / 2), count - 1];
}

export async function searchAllAboard(params: SearchParams): Promise<TrainOffer[]> {
  if (!env.ALLABOARD_API_KEY) return [];
  const { origin, destination, date } = params;
  const session = randomUUID();

  try {
    const [fromUid, toUid] = await Promise.all([
      getAllAboardLocationUid(origin, session),
      getAllAboardLocationUid(destination, session),
    ]);
    if (!fromUid || !toUid) {
      logger.info('All Aboard: city not in coverage', { origin, destination });
      return [];
    }

    const data = await gql<{ getJourneys: AaJourney[] }>(
      `query($o: ID!, $d: ID!, $date: Date!) {
        getJourneys(origin: $o, destination: $d, date: $date) {
          id
          itinerary {
            ... on SegmentCollection {
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

    const journeys = (data.getJourneys ?? []).filter(
      (j) => segmentsOf(j.itinerary).length > 0,
    );
    if (journeys.length === 0) return [];

    // Live-price a spread of the day's journeys. One ADULT passenger keeps
    // prices per-person (same semantics as the Deutsche Bahn fares); USD is
    // requested natively so no FX conversion is needed. Amounts arrive in
    // cents. Failures are per-journey and non-fatal.
    const candidates = pickOfferCandidates(journeys.length);
    const priced = new Map<number, number>();
    await Promise.all(
      candidates.map(async (idx) => {
        try {
          const offerData = await gql<{ getJourneyOffer: AaJourneyOffer }>(
            `query($j: ID!) {
              getJourneyOffer(journey: $j, passengers: [{type: ADULT}], currency: "USD") {
                itinerary {
                  ... on SegmentCollection { offers { id price { amount currency } } }
                }
              }
            }`,
            { j: journeys[idx].id },
            session,
            OFFER_TIMEOUT_MS,
          );
          const amounts = (offerData.getJourneyOffer.itinerary ?? [])
            .flatMap((item) => item.offers ?? [])
            .map((o) => o.price?.amount)
            .filter((a): a is number => typeof a === 'number' && a > 0);
          if (amounts.length > 0) priced.set(idx, Math.min(...amounts) / 100);
        } catch (err: any) {
          logger.warn('All Aboard offer pricing failed (non-fatal)', {
            message: err?.message,
            journey: journeys[idx]?.id,
          });
        }
      }),
    );

    const toOffer = (j: AaJourney, idx: number): TrainOffer | null => {
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
      const price = priced.get(idx) ?? null;
      return {
        id: `aa-${j.id}`,
        price,
        currency: 'USD',
        departure: dep,
        arrival: arr,
        durationMinutes,
        operator: operators.join(' + ') || 'Rail operator',
        trainType: 'train',
        bookingUrl: 'https://allaboard.eu',
        limitedCoverage: price == null,
      };
    };

    // Priced journeys lead; unpriced timetable rows follow (capped) so the
    // UI still shows real schedules when live pricing was slow or down.
    const all = journeys
      .map(toOffer)
      .map((offer, idx) => ({ offer, idx }))
      .filter((x): x is { offer: TrainOffer; idx: number } => x.offer != null);
    const pricedOffers = all.filter((x) => priced.has(x.idx)).map((x) => x.offer);
    const unpricedOffers = all
      .filter((x) => !priced.has(x.idx))
      .map((x) => x.offer)
      .slice(0, pricedOffers.length > 0 ? 1 : MAX_UNPRICED);
    return [...pricedOffers, ...unpricedOffers];
  } catch (err: any) {
    logger.warn('All Aboard search failed (non-fatal)', {
      message: err?.message,
      origin,
      destination,
    });
    return [];
  }
}
