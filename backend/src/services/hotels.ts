import { env } from '../config/env';
import { getSupabase } from './supabase';
import { logger } from '../utils/logger';

export type HotelResult = {
  id: string;
  name: string;
  price: number;
  pricePerNight: number;
  currency: string;
  rating: number;
  reviewCount: number;
  stars: number;
  thumbnail: string;
  bookingUrl: string;
  amenities: string[];
  /**
   * Set when this row's price is not trusted — see `flagSuspectPrices`.
   *
   * Optional because it is an annotation on an otherwise ordinary result, and
   * trips saved before it existed simply don't carry it. Absent and `false`
   * mean the same thing: the price looks fine.
   */
  priceSuspect?: boolean;
  priceSuspectReason?: PriceSuspectReason;
};

/**
 * How long `booking_locations` is allowed to hold up a hotel search.
 *
 * That table is only ever a cache: a miss costs one extra Booking.com
 * locations call, which the code below already knows how to make. So waiting
 * on the cache is worth it only while it stays cheaper than its own fallback —
 * a slow cache is strictly worse than a missing one.
 *
 * 1.5s is roughly 20x a healthy indexed single-row read, so it should never
 * fire against a working database. It is here to bound a Supabase that hangs
 * rather than one that refuses.
 */
const LOCATION_CACHE_TIMEOUT_MS = 1500;

/**
 * PostgREST's "no rows matched" code from `.single()`.
 *
 * This is an ordinary cache miss on a city we haven't looked up yet — the
 * common case on a cold table, and not worth a log line.
 */
const PGRST_NO_ROWS = 'PGRST116';

async function getDestinationId(
  cityName: string,
): Promise<{ dest_id: string; dest_type: string }> {
  const supabase = getSupabase();

  // Check cache.
  //
  // `.retry(false)` is the important part. postgrest-js retries a failed GET
  // three times with 1s, 2s and 4s of backoff sleep in between; measured
  // against an unreachable Supabase that put ~7.0s of pure sleep on every
  // hotel search before the code fell through to the API below. The DNS
  // failures themselves cost ~80ms of it — the rest was the backoff.
  //
  // Retrying is simply the wrong trade for a cache read: the fallback is one
  // HTTP call away, so three rounds of backoff buy nothing we don't already
  // have cheaper. The timeout then bounds the case retries don't cover, a
  // Supabase that accepts the connection and never answers.
  const { data: cached, error: cacheReadError } = await supabase
    .from('booking_locations')
    .select('dest_id, dest_type')
    .eq('city_name', cityName.toLowerCase())
    .retry(false)
    .abortSignal(AbortSignal.timeout(LOCATION_CACHE_TIMEOUT_MS))
    .single();

  // A failed read is not fatal — we fall through to the locations API and the
  // search still returns the right answer. But it must not be SILENT: the old
  // code destructured only `data`, so a hard Supabase outage was
  // indistinguishable from a cold cache and showed up as nothing but a search
  // that had become mysteriously slow.
  if (cacheReadError && cacheReadError.code !== PGRST_NO_ROWS) {
    logger.warn('booking_locations cache read failed — falling back to the locations API', {
      city: cityName,
      code: cacheReadError.code || undefined,
      error: cacheReadError.message,
      timeoutMs: LOCATION_CACHE_TIMEOUT_MS,
    });
  }

  if (cached?.dest_id) {
    return { dest_id: cached.dest_id, dest_type: cached.dest_type ?? 'city' };
  }

  if (!env.RAPIDAPI_KEY) {
    throw new Error('RAPIDAPI_KEY not configured');
  }

  const url = `https://booking-com.p.rapidapi.com/v1/hotels/locations?name=${encodeURIComponent(cityName)}&locale=en-gb`;
  const res = await fetch(url, {
    headers: {
      'X-RapidAPI-Key': env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'booking-com.p.rapidapi.com',
    },
  });

  if (!res.ok) {
    throw new Error(`Booking.com locations API returned ${res.status}`);
  }

  const locations = await res.json();
  const city = Array.isArray(locations)
    ? locations.find((l: any) => l.dest_type === 'city')
    : null;

  if (!city?.dest_id) {
    throw new Error(`No destination found for "${cityName}"`);
  }

  // Cache. Bounded for the same reason as the read above: this write is the
  // last thing standing between the caller and their results, and a Supabase
  // that hangs must not hold them. Losing the write only means the next search
  // for this city misses the cache too.
  //
  // No `.retry(false)` needed here — postgrest only retries idempotent methods
  // and this is a POST, so it was never on the retry ladder.
  const { error: cacheWriteError } = await supabase
    .from('booking_locations')
    .upsert({
      city_name: cityName.toLowerCase(),
      dest_id: String(city.dest_id),
      dest_type: city.dest_type,
    })
    .abortSignal(AbortSignal.timeout(LOCATION_CACHE_TIMEOUT_MS));

  if (cacheWriteError) {
    logger.warn('booking_locations cache write failed — this city will miss again', {
      city: cityName,
      code: cacheWriteError.code || undefined,
      error: cacheWriteError.message,
    });
  }

  return { dest_id: String(city.dest_id), dest_type: city.dest_type };
}

type SearchHotelsParams = {
  city: string;
  checkin: string;
  checkout: string;
  adults: number;
  rooms: number;
  maxPrice?: number;
};

/**
 * ─── Price plausibility ──────────────────────────────────────────────────────
 *
 * WHY THIS IS SHAPED THE WAY IT IS. Read before tuning a number here.
 *
 * The provider sometimes quotes `min_total_price` for something other than what
 * we asked for — a different occupancy, a whole property, a longer stay. We
 * cannot fix their data, only decide what to do with a row we distrust, and
 * that decision has been got wrong twice in opposite directions:
 *
 *  1. Trusting it. A Florence search returned "Hotel Aldobrandini" at
 *     $5383.47/night, the provider returned it FIRST, and it became 95% of a
 *     $17,039 total shown as "Best price for these dates".
 *  2. Deleting it. The first fix compared each row to the whole search's
 *     median. Over 45 independent real production searches that scored 1 true
 *     positive against 4 legitimate hotels deleted — Bora Bora lost all three
 *     overwater resorts, the exact properties someone searching Bora Bora
 *     wants, and the customer was left the guesthouses.
 *
 * The lesson is not "find a better threshold". It is that DELETING is the wrong
 * verb. We cannot reliably tell a data glitch from a genuinely expensive hotel,
 * and when we are wrong, deleting costs the customer a room they can never know
 * existed, while the alternative costs almost nothing. So:
 *
 *   - A price that CANNOT be a real rate (missing, zero, negative, NaN, or
 *     below any plausible floor) is dropped. There is no hotel behind it to
 *     lose, and leaving it in is actively dangerous — see below.
 *   - A price that merely looks WRONG is flagged, not removed. A flagged row
 *     still appears in the list, so no real inventory is ever lost; it just
 *     sorts below every unflagged row, so it can never become the auto-selected
 *     hotel or land in the trip total.
 *
 * That asymmetry is the whole point. Mis-tuning a threshold now costs a ranking
 * position instead of a deleted hotel or a $17,039 headline, which is why this
 * should stop needing revisits.
 *
 * WHY THE FLOOR MATTERS MORE THAN THE CEILING, which is the part every previous
 * pass missed. The ranking formula in frontend/lib/hotelScore.ts has a
 * `100 / pricePerNight` term, so price works in opposite directions:
 *
 *   - An over-priced row is SELF-PUNISHING. It sinks to the bottom unaided.
 *     Measured: a $3377.84/night row scores 11.9 against ~235 for its normal
 *     neighbours, i.e. last place. Every guard written so far has been aimed
 *     at this, the direction that was already safe.
 *   - An under-priced row is SELF-REWARDING. Measured through the real shipped
 *     `rankHotels`: a $0/night row scores 40028.8 and a $3/night row 16415.7,
 *     against ~235 for a legitimate hotel. Both come FIRST, which means
 *     `hotels[0]` — the trip's hotel, the trip total, the headline price.
 *
 * So the dangerous direction was the unguarded one. A floor is not a nicety
 * here; it is the half of this that stops a $0 hotel becoming the trip.
 */

/** Median of a non-empty list of positive numbers. */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * A hotel priced above this multiple of its OWN STAR TIER's median is suspect.
 *
 * Was 5, raised to 8 on measurement. Across 777 independent captured
 * production rows the distribution of `price / tierMedian` is p50 1.00,
 * p90 1.72, p99 3.07 — and then a gap. The dearest legitimate row sits at
 * 4.76x (a Cannes festival-week apartment) and the single confirmed glitch at
 * 13.93x, with nothing in between. Every value from 5x to 13.9x catches the
 * same one row and flags no real hotel.
 *
 * 5 sat 5% above the highest real row, which is the edge of the data rather
 * than the headroom the previous comment here claimed; one Cannes re-quote
 * would have crossed it. 8 is near the geometric middle of the gap and leaves
 * 68%. Below 4.5x the cost appears fast: 4.5x flags that Cannes apartment, 4x
 * also flags a transit hotel with 3,185 reviews, and 3x flags Atlantis, The
 * Palm with 18,820.
 */
const OUTLIER_MEDIAN_MULTIPLE = 8;

/**
 * Multiple of the WHOLE SEARCH's median above which an UNRATED row whose own
 * tier is too thin to judge is suspect.
 *
 * Covers an unrated row in a thin tier WITHIN a search that has other rows to
 * compare against — two or three 0-star listings among twenty, say, where the
 * tier itself is too small for a median but the search is not.
 *
 * READ THIS BEFORE TUNING IT. It does NOT cover the case it was written for,
 * and no value of this constant can. That case was a Val d'Isère search
 * returning a single 0-star listing at $3377.84/night. Measured against the
 * captured corpus, it fails three ways over:
 *
 *  1. That search returned exactly ONE row, so `allPrices.length` is 1, below
 *     MIN_RESULTS_TO_FILTER, and the rule switches itself off.
 *  2. The median is self-inclusive. A lone row's ratio to a median computed
 *     from itself is exactly 1.00 by construction — so not 5x, not 1.1x, no
 *     multiple reaches it.
 *  3. Flagging would not help anyway. With one row `rankHotels` has nothing to
 *     demote it below, so it is `hotels[0]` and the trip total either way.
 *     The safety argument in `flagSuspectPrices` below is false at n=1.
 *
 * A single-row search defeats every relative rule here. Covering it needs a
 * reference from OUTSIDE the search — a per-city price band, or a second
 * provider — not a threshold. Note also that the row in question is most
 * likely a real hotel: Le Refuge de Solaise, a converted 2551m cable-car
 * station, 9.6 from 137 reviews, in Val d'Isère in peak ski week. Legitimate
 * 0-star rows in the same corpus reach $2713 (Cannes in May) and $1604
 * (St Moritz in February), so $3377 is not separable from real inventory by
 * price alone, and an absolute 0-star ceiling could not do it either.
 *
 * Only unrated rows fall through to this. A thin 4 or 5 star tier is left
 * alone, because the provider's own star rating is independent evidence that
 * the property really is in that price class — that is exactly what spares
 * Bora Bora's resorts. A 0-star row carries no such evidence.
 *
 * 5 rather than the per-tier rule's 8 because the whole-search median is a
 * weaker comparison than a same-tier one and this is the looser net. Measured:
 * 17 rows in the corpus qualify for this rule and the dearest sits at 2.23x,
 * so anything from 2.5x up flags nothing real. It has caught 0 true positives
 * in 777 rows — kept because the thin-tier-but-not-lone case is real, not
 * because it has earned its place.
 */
const UNRATED_SEARCH_MEDIAN_MULTIPLE = 5;

/**
 * A row priced below its tier median divided by this is suspect.
 *
 * The mirror of OUTLIER_MEDIAN_MULTIPLE, and far more conservative at 10x
 * rather than 5x, because the two errors are not symmetric: flagging an
 * over-priced row costs nothing, while flagging a genuine bargain demotes the
 * exact room a price-led planner should be putting first.
 *
 * 10x below its own star tier is not a bargain, it is a different product —
 * a "from" price for a single bed in a shared room, or a quote for one night
 * of a week. Validated against 777 independent captured production rows: it
 * flags none of them. The widest real underprice measured is 3.81x below its
 * tier median (a Zanzibar hostel at $31.75 against $120.96, 8.5 from 231
 * reviews), so 10 sits 2.6x clear of anything real. There is no measured true
 * positive on this side, so there is nothing to justify tightening it.
 */
const UNDERPRICE_MEDIAN_DIVISOR = 10;

/**
 * Absolute per-night ceiling for a hotel the provider itself calls 1-3 stars.
 *
 * Deliberately generous — roughly 4x the top end of a 3-star in an expensive
 * city in peak season — because the case this catches sits 5x above it.
 * "Hotel Aldobrandini", stars: 3, came back at $5383.47/night.
 */
const BUDGET_STARS_PRICE_CEILING = 1000;

/**
 * No real room for two adults costs less than this per night.
 *
 * The floor exists to catch an ABSENT price, not a cheap one. `min_total_price`
 * missing or unparseable becomes 0 (see the mapping in `searchHotels`), and a
 * 0 is the single most dangerous value in the system because `100 / price`
 * turns it into the highest-scoring hotel in the search.
 *
 * $5 is far below anything bookable for two adults — a hostel dorm bed in the
 * cheapest market this app covers is several times it — so no real inventory
 * sits under this line, while everything that does sit under it is a data
 * error. Unlike the suspicion rules above, this one deletes, because there is
 * no hotel behind a missing price to preserve.
 */
const ABSOLUTE_PRICE_FLOOR = 5;

/**
 * Below this many hotels IN A STAR TIER the median isn't meaningful, so that
 * tier gets no relative ceiling or floor of its own.
 *
 * This is what spares the luxury end of a thin market. A Bora Bora search
 * returns three overwater resorts beside fourteen local lodges; the resorts
 * land in tiers of one and three, fall under this floor, and are left alone.
 */
const MIN_RESULTS_TO_FILTER = 4;

/** Why a row's price is not trusted. Carried through to the logs. */
export type PriceSuspectReason =
  | 'above-tier-median'
  | 'above-search-median-unrated'
  | 'above-star-ceiling'
  | 'below-tier-median';

/** A price that could be a real nightly rate. Not a judgement on how good it is. */
function isUsablePrice(price: number): boolean {
  return Number.isFinite(price) && price >= ABSOLUTE_PRICE_FLOOR;
}

/**
 * Remove rows whose price cannot be a real rate at all.
 *
 * This is the only place that deletes, and it deletes on certainty rather than
 * suspicion: a missing, zero, negative or non-finite price has no hotel behind
 * it, so nothing is lost. See ABSOLUTE_PRICE_FLOOR for why this is the
 * dangerous direction rather than the obvious one.
 *
 * `price` (the whole stay) is checked as well as `pricePerNight`. They are
 * derived from each other at the mapping, but currency conversion converts
 * them independently, so they can diverge on the way here.
 */
export function dropUnusablePrices(hotels: HotelResult[], city: string): HotelResult[] {
  const kept = hotels.filter((h) => {
    const usable = isUsablePrice(h.pricePerNight) && isUsablePrice(h.price);
    if (!usable) {
      logger.warn('Hotel dropped — price cannot be a real rate', {
        city,
        hotel: h.name,
        pricePerNight: h.pricePerNight,
        price: h.price,
        floor: ABSOLUTE_PRICE_FLOOR,
      });
    }
    return usable;
  });

  // No "empty is worse than suspicious" fallback here, unlike the old guards.
  // That reasoning applied when we were deleting rows that might have been
  // real; these cannot be. A city of $0 hotels and a $0 trip total is not a
  // better answer than no hotels, it is a confidently wrong one.
  if (kept.length === 0 && hotels.length > 0) {
    logger.warn('Hotel search emptied — every row had an unusable price', {
      city,
      rows: hotels.length,
    });
  }

  return kept;
}

/**
 * Mark rows whose price is out of line, WITHOUT removing them.
 *
 * Three rules, in order of how much evidence they need:
 *
 *  - `above-star-ceiling`: a 1-3 star property over BUDGET_STARS_PRICE_CEILING.
 *    Needs no comparison set, so it still works on a result set of one, or on a
 *    feed that is uniformly wrong and therefore looks internally consistent.
 *  - `above-tier-median` / `below-tier-median`: compared against other rows of
 *    the SAME star rating. Per tier rather than per search because a bimodal
 *    market defeats any single global multiple — the budget tail drags the
 *    median below everything at the top, which is how Bora Bora's resorts came
 *    to be deleted.
 *  - `above-search-median-unrated`: the fallback for an unrated row whose own
 *    tier is too thin to say anything. See UNRATED_SEARCH_MEDIAN_MULTIPLE.
 *
 * Medians throughout, never means — a mean is dragged by the very outlier
 * we are looking for.
 *
 * Every row is returned either way. Ordering is the frontend's job: `rankHotels`
 * sorts flagged rows below every unflagged one, so a flagged row can still be
 * browsed and booked but will not become `hotels[0]`, the auto-selected hotel
 * or part of the trip total — PROVIDED the search returned an unflagged row to
 * put above it. Where every row is flagged, or where only one came back, there
 * is nothing to demote it below and it is the trip's hotel regardless. That is
 * a deliberate fallback (a suspicious price beats an empty city) but it is not
 * protection, and a one-row search is the case it fails at. See
 * UNRATED_SEARCH_MEDIAN_MULTIPLE.
 */
export function flagSuspectPrices(hotels: HotelResult[], city: string): HotelResult[] {
  const starsOf = (h: HotelResult) => (Number.isFinite(h.stars) ? h.stars : 0);

  // The absolute rule first, because it needs no comparison set — and because
  // its verdicts must be kept OUT of the medians below.
  //
  // The guards this replaced ran as two passes, deleting star-ceiling
  // violators before the relative pass computed any median. Flagging instead
  // of deleting quietly lost that, and a row the absolute rule has already
  // condemned should not get a vote on where its own tier's ceiling sits.
  //
  // The reachable consequence is padding rather than masking. A median is
  // robust enough that one huge value barely moves a ceiling — I could not
  // construct a case where it hides a second glitch — but it does inflate the
  // tier's COUNT, which can lift a tier over MIN_RESULTS_TO_FILTER and
  // manufacture a floor that then flags a legitimately cheap room. There is a
  // test for exactly that.
  const overStarCeiling = (h: HotelResult) =>
    starsOf(h) >= 1 && starsOf(h) <= 3 && h.pricePerNight > BUDGET_STARS_PRICE_CEILING;

  const tiers = new Map<number, HotelResult[]>();
  const allPrices: number[] = [];
  for (const h of hotels) {
    if (!isUsablePrice(h.pricePerNight)) continue;
    if (overStarCeiling(h)) continue;
    allPrices.push(h.pricePerNight);
    const tier = tiers.get(starsOf(h));
    if (tier) tier.push(h);
    else tiers.set(starsOf(h), [h]);
  }

  const ceilings = new Map<number, number>();
  const floors = new Map<number, number>();
  for (const [stars, tier] of tiers) {
    // Too thin to say anything about: the one or two luxury rooms in an
    // otherwise budget market land here, and are exempt by construction.
    if (tier.length < MIN_RESULTS_TO_FILTER) continue;
    const median = medianOf(tier.map((h) => h.pricePerNight));
    if (!Number.isFinite(median) || median <= 0) continue;
    ceilings.set(stars, median * OUTLIER_MEDIAN_MULTIPLE);
    floors.set(stars, median / UNDERPRICE_MEDIAN_DIVISOR);
  }

  // Only used for unrated rows with no tier of their own to be judged against.
  const searchCeiling =
    allPrices.length >= MIN_RESULTS_TO_FILTER
      ? medianOf(allPrices) * UNRATED_SEARCH_MEDIAN_MULTIPLE
      : undefined;

  const reasonFor = (h: HotelResult): PriceSuspectReason | null => {
    if (!isUsablePrice(h.pricePerNight)) return null;
    const stars = starsOf(h);
    const price = h.pricePerNight;

    if (overStarCeiling(h)) {
      return 'above-star-ceiling';
    }

    const ceiling = ceilings.get(stars);
    if (ceiling !== undefined) {
      if (price > ceiling) return 'above-tier-median';
      const floor = floors.get(stars);
      if (floor !== undefined && price < floor) return 'below-tier-median';
      return null;
    }

    // No tier ceiling: the tier is too thin. Unrated rows have no star rating
    // vouching for them either, so they fall back to the whole search.
    if (stars === 0 && searchCeiling !== undefined && price > searchCeiling) {
      return 'above-search-median-unrated';
    }

    return null;
  };

  return hotels.map((h) => {
    const reason = reasonFor(h);
    if (!reason) return h;

    logger.warn('Hotel price flagged as suspect — demoted, not removed', {
      city,
      hotel: h.name,
      stars: starsOf(h),
      pricePerNight: h.pricePerNight,
      reason,
      tierCeiling: ceilings.get(starsOf(h)),
      tierFloor: floors.get(starsOf(h)),
      tierSize: tiers.get(starsOf(h))?.length,
      searchCeiling,
    });

    return { ...h, priceSuspect: true, priceSuspectReason: reason };
  });
}

export async function searchHotels(params: SearchHotelsParams): Promise<HotelResult[]> {
  const { city, checkin, checkout, adults, rooms, maxPrice } = params;

  if (!env.RAPIDAPI_KEY) {
    logger.warn('RAPIDAPI_KEY not set — returning empty hotel results');
    return [];
  }

  try {
    const { dest_id, dest_type } = await getDestinationId(city);

    const searchParams = new URLSearchParams({
      dest_id,
      dest_type,
      checkin_date: checkin,
      checkout_date: checkout,
      adults_number: String(adults),
      room_number: String(rooms),
      order_by: 'popularity',
      filter_by_currency: 'USD',
      locale: 'en-gb',
      units: 'metric',
    });

    const url = `https://booking-com.p.rapidapi.com/v1/hotels/search?${searchParams}`;

    // Retry with exponential backoff on 429 (RapidAPI free-tier rate limit).
    // Without this, parallel hotel fetches for multi-city trips silently
    // return empty results for whichever city happened to land during a
    // throttled moment — surfacing as "$0/night, ★0" in the UI.
    let res: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, {
        headers: {
          'X-RapidAPI-Key': env.RAPIDAPI_KEY,
          'X-RapidAPI-Host': 'booking-com.p.rapidapi.com',
        },
      });
      if (res.status !== 429) break;
      const delay = 300 * Math.pow(2, attempt); // 300ms, 600ms, 1200ms
      logger.warn('Booking.com 429 — retrying', { attempt: attempt + 1, delay, city });
      await new Promise((r) => setTimeout(r, delay));
    }

    if (!res || !res.ok) {
      logger.warn('Booking.com search API error', { status: res?.status, city });
      return [];
    }

    const data: any = await res.json();
    const results = data.result ?? [];

    // Calculate nights for per-night pricing
    const checkinDate = new Date(checkin);
    const checkoutDate = new Date(checkout);
    const nights = Math.max(
      1,
      Math.ceil((checkoutDate.getTime() - checkinDate.getTime()) / (1000 * 60 * 60 * 24)),
    );

    let hotels: HotelResult[] = results
      .filter((h: any) => {
        const score = parseFloat(h.review_score ?? '0');
        return score >= 7.0;
      })
      .map((h: any) => {
        const totalPrice = parseFloat(h.min_total_price ?? h.price_breakdown?.gross_price ?? '0');
        return {
          id: String(h.hotel_id ?? h.id ?? ''),
          name: h.hotel_name ?? h.name ?? 'Unknown Hotel',
          price: totalPrice,
          pricePerNight: Math.round((totalPrice / nights) * 100) / 100,
          currency: h.currency_code ?? h.currencycode ?? 'USD',
          rating: parseFloat(h.review_score ?? '0'),
          reviewCount: parseInt(h.review_nr ?? h.review_score_word ?? '0', 10) || 0,
          stars: parseInt(h.class ?? '0', 10) || 0,
          thumbnail: h.main_photo_url ?? h.max_photo_url ?? '',
          bookingUrl: h.url ?? `https://www.booking.com/hotel/${h.hotel_id ?? ''}.html`,
          amenities: [] as string[],
        };
      });

    // Convert all non-USD prices to USD before returning.
    // Booking frequently ignores filter_by_currency=USD and returns
    // local currency for `min_total_price`, so we normalize here.
    //
    // A price we can't convert is DROPPED, not relabelled. Everything
    // downstream assumes HotelResult.price is dollars — the trip total, the
    // maxPrice filter right below, and the frontend, which prints a literal
    // `$` and never reads `currency` — so keeping 800,000 COP under a 'USD'
    // label poisons the total AND makes maxPrice throw away the whole city.
    // Dropping is the only honest option until the UI can render a foreign
    // currency.
    const { convertToUsd } = await import('./currency');
    const converted = await Promise.all(
      hotels.map(async (h): Promise<HotelResult | null> => {
        if (!h.currency || h.currency === 'USD') return h;
        const usdTotal = await convertToUsd(h.price, h.currency);
        const usdPerNight = await convertToUsd(h.pricePerNight, h.currency);
        if (usdTotal === null || usdPerNight === null) {
          logger.warn('Hotel dropped — no USD rate for its currency', {
            city,
            hotel: h.name,
            currency: h.currency,
          });
          return null;
        }
        return {
          ...h,
          price: usdTotal,
          pricePerNight: usdPerNight,
          currency: 'USD',
        };
      }),
    );
    hotels = converted.filter((h): h is HotelResult => h !== null);

    // Drop first, flag second: an unusable price must not be in the set the
    // medians are computed from, or a row of 0s drags every floor down with it.
    hotels = dropUnusablePrices(hotels, city);
    hotels = flagSuspectPrices(hotels, city);

    if (maxPrice !== undefined) {
      hotels = hotels.filter((h) => h.price <= maxPrice);
    }

    return hotels;
  } catch (err: any) {
    logger.warn('Hotel search failed (non-fatal)', { message: err?.message, city });
    return [];
  }
}
