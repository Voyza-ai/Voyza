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
 * How long any one Booking.com request may take before we give up on it.
 *
 * These fetches had no bound at all, so a provider that accepted the
 * connection and never answered held the search for undici's defaults (five
 * minutes for headers, five more for the body) while the planner sat on
 * "Finding hotels..." — and the canvas save route awaits this service inline.
 *
 * Sized from production, not from a guess: the whole `/api/hotels/search`
 * round trip measured 0.86-1.70s across nine calls on 2026-10-29 (median
 * ~1.1s), and that includes the locations lookup, the search AND currency
 * conversion. 10s per request is ~6x the slowest whole call, so it should only
 * ever fire on a request that has stopped. A timed-out search is caught like
 * any other failure and returns no hotels, which the planner already handles.
 */
const BOOKING_FETCH_TIMEOUT_MS = 10_000;

/**
 * PostgREST's "no rows matched" code from `.single()`.
 *
 * This is an ordinary cache miss on a city we haven't looked up yet — the
 * common case on a cold table, and not worth a log line.
 */
const PGRST_NO_ROWS = 'PGRST116';

/**
 * Alternate spellings to try when a destination name finds nothing at all.
 *
 * Only the ampersand swap, because that is the one measured against
 * production: "Turks and Caicos" returns no hotels and "Turks & Caicos"
 * returns 17. Deliberately not a general fuzzy-matcher — a wrong destination
 * that returns hotels is worse than a name that returns none, because the
 * traveller gets prices for somewhere they did not ask about.
 */
export function nameVariants(cityName: string): string[] {
  const variants = new Set<string>();
  if (/\sand\s/i.test(cityName)) variants.add(cityName.replace(/\sand\s/gi, ' & '));
  if (/\s&\s/.test(cityName)) variants.add(cityName.replace(/\s&\s/g, ' and '));
  variants.delete(cityName);
  return [...variants];
}

/** Destination kinds a hotel search must never be pointed at. */
const UNSEARCHABLE_DEST_TYPES = new Set(['hotel', 'airport']);

/**
 * Preference order when the provider offers more than one kind of match.
 * Narrowest first, so a real city always wins over the region containing it.
 */
const DEST_TYPE_PREFERENCE = ['city', 'region', 'district', 'island', 'country'];

/**
 * Choose which of Booking's location matches to search.
 *
 * This used to be `locations.find((l) => l.dest_type === 'city')`, which threw
 * for anything that is not a city in Booking's taxonomy — and the caller
 * swallows that into an empty result list with a single non-fatal warn. So a
 * whole class of destination silently returned NO HOTELS AT ALL.
 *
 * Measured against production on 2026-10-23, two adults, with the same dates
 * the rest of this file's cases use. Zero rows returned for: Tahiti, Maldives,
 * Mauritius, Seychelles, Aruba, Bahamas, Fiji, Turks and Caicos, Santorini,
 * Tuscany. Rows returned normally for Bora Bora (20), Florence (18) and
 * Phuket (17) — all of which have a city entry. That asymmetry is the bug;
 * currency is not involved, since Bora Bora prices in XPF and worked while
 * Turks and Caicos prices in USD and did not.
 *
 * Santorini is a destination in a shipped preset itinerary, so this reached
 * the product's own suggested trips.
 *
 * Deliberately monotonic: 'city' is still preferred first, so every search
 * that works today resolves to exactly the same destination it does now. The
 * only behaviour that changes is a lookup that would have thrown. Hotels and
 * airports are excluded rather than ranked — a single property would return a
 * one-row search dressed up as a city, which is worse than a clear failure.
 * An unrecognised kind falls through to the provider's own top match, because
 * its ranking is better than our list of names being exhaustive.
 */
export function pickDestination(
  locations: unknown,
  cityName: string,
): { dest_id: string; dest_type: string; certain: boolean } | null {
  if (!Array.isArray(locations)) return null;

  const usable = locations.filter(
    (l: any) => l?.dest_id && !UNSEARCHABLE_DEST_TYPES.has(String(l.dest_type)),
  );
  if (usable.length === 0) return null;

  const preferred = DEST_TYPE_PREFERENCE.map((want) =>
    usable.find((l: any) => String(l.dest_type) === want),
  ).find(Boolean);

  const picked = (preferred ?? usable[0]) as any;
  const rawType = picked.dest_type;
  const known = typeof rawType === 'string' && rawType.length > 0;

  // Do NOT relabel an unknown kind as 'city'. This used to end with
  // `String(picked.dest_type ?? 'city')`, which meant a match with no
  // dest_type was sent to the search as a city and then UPSERT into
  // booking_locations under that claim — one uncertain resolution cached
  // permanently for that city name. The warn condition was
  // `!== 'city'`, so it was false for exactly the most uncertain case and the
  // only silent branch was the one that most needed a line in the log.
  //
  // `certain` is false whenever we are guessing, and the caller skips the cache
  // write in that case, so a guess is re-made next time rather than frozen.
  if (!known) {
    logger.warn('Hotel destination has no dest_type — guessing city, not caching', {
      city: cityName,
      destId: String(picked.dest_id),
      offered: usable.map((l: any) => l?.dest_type ?? null),
    });
  } else if (rawType !== 'city') {
    logger.warn('Hotel destination resolved to a non-city match', {
      city: cityName,
      destType: rawType,
      destId: String(picked.dest_id),
      viaPreference: Boolean(preferred),
    });
  }

  return {
    dest_id: String(picked.dest_id),
    dest_type: known ? rawType : 'city',
    certain: known,
  };
}

// Words too generic to identify a hotel on their own.
const GENERIC_HOTEL_WORDS = new Set(['hotel', 'hotels', 'the', 'and', 'by', 'resort', 'spa', 'a', 'of', 'de', 'la', 'le']);

const hotelWords = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !GENERIC_HOTEL_WORDS.has(w));

/** Same hotel? Every distinctive word of the preset's hotel name must
 *  appear in the search result's name ("Gracery Shinjuku" matches "Hotel
 *  Gracery Shinjuku Tokyo"). Substring matching wrongly paired short names
 *  with unrelated hotels that happened to contain their letters. */
export function isSameHotel(presetName: string, resultName: string): boolean {
  const want = hotelWords(presetName);
  if (want.length === 0) return false;
  const got = new Set(hotelWords(resultName));
  return want.every((w) => got.has(w));
}

/** Booking destination for one specific hotel ("hotel" type), or null when
 *  the name doesn't resolve to that exact hotel in that city. Not cached:
 *  only the weekly preset refresh uses it. */
async function getHotelDestination(
  hotelName: string,
  cityName: string,
): Promise<{ dest_id: string; dest_type: string } | null> {
  if (!env.RAPIDAPI_KEY) return null;
  const url = `https://booking-com.p.rapidapi.com/v1/hotels/locations?name=${encodeURIComponent(
    `${hotelName} ${cityName}`,
  )}&locale=en-gb`;
  const res = await fetch(url, {
    headers: { 'X-RapidAPI-Key': env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'booking-com.p.rapidapi.com' },
    signal: AbortSignal.timeout(BOOKING_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const list = (await res.json()) as any[];
  const hit = (Array.isArray(list) ? list : []).find(
    (x) => x?.dest_type === 'hotel' && x?.dest_id && isSameHotel(hotelName, String(x.name ?? '')),
  );
  return hit ? { dest_id: String(hit.dest_id), dest_type: 'hotel' } : null;
}

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

  // Captured after the guard above: narrowing from `if (!env.RAPIDAPI_KEY)`
  // does not survive into a closure, since the closure could run later.
  const apiKey = env.RAPIDAPI_KEY;

  const lookup = async (name: string) => {
    const url = `https://booking-com.p.rapidapi.com/v1/hotels/locations?name=${encodeURIComponent(name)}&locale=en-gb`;
    const res = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': apiKey,
        'X-RapidAPI-Host': 'booking-com.p.rapidapi.com',
      },
      signal: AbortSignal.timeout(BOOKING_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`Booking.com locations API returned ${res.status}`);
    }
    return pickDestination(await res.json(), name);
  };

  let city = await lookup(cityName);

  // Booking's location search is literal about "and" versus "&", and the
  // difference is the whole destination. Measured against production:
  //
  //   "Turks and Caicos"          ->  0 hotels
  //   "Turks & Caicos"            -> 17 hotels
  //   "Turks and Caicos Islands"  -> 19 hotels
  //
  // That is a name-matching failure, not a dest_type one, so it survived the
  // fix for the other ten dead destinations. The retry only runs when the
  // first lookup found nothing at all — which previously meant the search was
  // over anyway — so it costs a call only where the alternative is no hotels.
  if (!city?.dest_id) {
    for (const variant of nameVariants(cityName)) {
      city = await lookup(variant);
      if (city?.dest_id) {
        logger.warn('Destination resolved only under an alternate spelling', {
          city: cityName,
          resolvedAs: variant,
          destType: city.dest_type,
        });
        break;
      }
    }
  }

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
  //
  // An UNCERTAIN resolution is deliberately not cached. `pickDestination`
  // reports `certain: false` when the provider gave it no `dest_type` to go
  // on, and writing a guess here would freeze it for that city name for good —
  // every later search inheriting one bad response. Re-guessing costs a
  // locations call; a cached wrong answer costs the destination.
  if (!city.certain) {
    logger.warn('Destination resolution uncertain — skipping the cache write', {
      city: cityName,
      destId: String(city.dest_id),
    });
  } else {
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
  }

  return { dest_id: String(city.dest_id), dest_type: city.dest_type };
}

type SearchHotelsParams = {
  city: string;
  /** Price ONE specific hotel: resolved by name via Booking's location
   *  search (dest_type 'hotel') instead of searching the whole city. */
  hotelName?: string;
  checkin: string;
  checkout: string;
  adults: number;
  /** Rooms to price. Omitted → `roomsFor(adults)`. See there for why. */
  rooms?: number;
  maxPrice?: number;
};

/**
 * Rooms for a party when the caller doesn't say: two adults to a room.
 *
 * The default used to be one room, set in the route, and every caller in the
 * app sends `adults: travelers` and no `rooms` — so a group of six asked
 * Booking for ONE unit sleeping all six. Booking answered with what fits that:
 * hostels, apartments, a campsite as Rome's top pick, shown as
 * "6 travelers · 1 room". It lives here rather than in the route so that every
 * caller of the service gets it, not only HTTP ones.
 *
 * THE PRICE THAT COMES BACK IS ALREADY FOR EVERY ROOM. Measured against
 * production on 2026-10-29, same city and dates with only the occupancy
 * changed: `adults:6 rooms:3` against `adults:2 rooms:1` came back at exactly
 * 3.00x for 13 of 19 Paris hotels and 10 of 15 London hotels (median 3.00x in
 * both; the rest are different room types, 2.25x-3.65x). So `price` and
 * `pricePerNight` stay party totals and nothing downstream may multiply them
 * by a room count again. What DOES change meaning is every absolute price
 * threshold in this file, which were calibrated on single rooms — see
 * `perRoom`.
 */
export function roomsFor(adults: number): number {
  return Number.isFinite(adults) && adults > 2 ? Math.ceil(adults / 2) : 1;
}

/**
 * A party-total price expressed per room, for comparing against thresholds
 * that were calibrated on one room.
 *
 * The relative rules (tier medians, the search median) don't need this — every
 * row in one search is priced for the same rooms, so a ratio between two of
 * them is unchanged — but going through it everywhere keeps the absolute and
 * relative rules on one scale, and the logged numbers comparable to the
 * single-room corpus the comments here quote.
 */
const perRoom = (amount: number, rooms: number): number =>
  Number.isFinite(rooms) && rooms > 1 ? amount / rooms : amount;

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
 * Absolute per-night ceiling for a hotel the provider itself calls 1-3 stars,
 * PER ROOM. Every figure below is a single-room price; a search for three rooms
 * is compared after dividing by three (`perRoom`), or three real $700 rooms
 * would read as one $2100 glitch.
 *
 * Was $1000, raised to $2000 on measurement. $1000 was not generous at all: the
 * dearest real 1-3 star row in the captured corpus is $860.58 (a Courchevel
 * chalet in February), so it had 16% headroom — and peak-season Alpine stock
 * goes well past it. A Val d'Isère February search of 3-star chalets at
 * $1200-$1800 had every row condemned by this rule, which is both wrong on its
 * own terms and compounding: a flagged row is excluded from its tier's
 * statistics, so condemning the whole tier left nothing to judge a genuine
 * glitch against.
 *
 * $2000 sits between the data and the failure: 2.3x above the dearest real row
 * and 2.7x below "Hotel Aldobrandini", stars: 3, which came back at
 * $5383.47/night. Same detection, with room for a market the corpus does not
 * cover.
 */
const BUDGET_STARS_PRICE_CEILING = 2000;

/**
 * No real room for two adults costs less than this per night. Per ROOM: a
 * multi-room price is divided by its room count before it is compared.
 *
 * The floor exists to catch an ABSENT price, not a cheap one. `min_total_price`
 * missing or unparseable becomes 0 (see the mapping in `searchHotels`), and a
 * 0 is the single most dangerous value in the system because `100 / price`
 * turns it into the highest-scoring hotel in the search.
 *
 * Was $5, lowered to $1. This function DELETES, so it has to bind on certainty
 * alone, and $5 did not: converted to USD, a genuinely cheap room in the
 * weakest markets lands near it — 70,000 IDR is $4.43, 100,000 VND is $4.00,
 * ₹350 is $4.21 — and deleting one of those is a false positive in the one
 * place that is supposed to have none. (The captured corpus does not contain
 * such a row; its cheapest is $12.02. So this is a precaution against a market
 * the corpus does not cover, not a measured failure.)
 *
 * $1 is below any of those by 4x while still catching the near-zero values the
 * floor exists for. Cheap-but-plausible rows are left to the relative floor,
 * which flags rather than deletes — and that is the correct division of labour:
 * delete only what cannot be a price, flag what merely looks wrong.
 */
const ABSOLUTE_PRICE_FLOOR = 1;

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
 * The provider's star class, normalised to 0 (unrated) unless it is a whole
 * number from 1 to 5.
 *
 * `parseInt(h.class ?? '0', 10) || 0` at the mapping passes any integer
 * through, negatives included. Normalising only non-finite values left
 * `stars: -1` escaping BOTH the 1-3 star ceiling (`>= 1 && <= 3`) and the
 * unrated fallback (`=== 0`) — so it landed in the one bucket that trusts a
 * row unconditionally, "4-5 star, independent evidence of its price class".
 * The same row with `stars` absent was correctly flagged, which made it a gap
 * rather than a policy.
 */
function starClass(h: { stars: number }): number {
  const s = h.stars;
  return Number.isInteger(s) && s >= 1 && s <= 5 ? s : 0;
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
 *
 * `rooms` is how many rooms the prices cover; the floor is judged per room.
 */
export function dropUnusablePrices(
  hotels: HotelResult[],
  city: string,
  rooms = 1,
): HotelResult[] {
  const kept = hotels.filter((h) => {
    const usable =
      isUsablePrice(perRoom(h.pricePerNight, rooms)) && isUsablePrice(perRoom(h.price, rooms));
    if (!usable) {
      logger.warn('Hotel dropped — price cannot be a real rate', {
        city,
        hotel: h.name,
        pricePerNight: h.pricePerNight,
        price: h.price,
        rooms,
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
 *
 * `rooms` is how many rooms the prices cover. Every rule works on the price
 * PER ROOM (`nightly` below), because every threshold here was measured on
 * single rooms; the rows themselves are returned with their party totals
 * untouched.
 */
export function flagSuspectPrices(
  hotels: HotelResult[],
  city: string,
  rooms = 1,
): HotelResult[] {
  const starsOf = starClass;
  const nightly = (h: HotelResult) => perRoom(h.pricePerNight, rooms);

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
  const overStarCeilingRaw = (h: HotelResult) =>
    starsOf(h) >= 1 && starsOf(h) <= 3 && nightly(h) > BUDGET_STARS_PRICE_CEILING;

  // IF THE CEILING CONDEMNS A WHOLE TIER, THE CEILING IS WHAT IS WRONG.
  //
  // This is the one absolute rule here: no comparison set, and unlike the
  // relative rules it never switches itself off on a thin result set. That
  // made it the last way for a search to end up with every row flagged — and
  // then `trustedFirst` has nothing to promote and `hotels[0]` is suspect,
  // which voids the guarantee the whole design rests on. Demonstrated on nine
  // realistic New-Year ski chalets at $2180-$3260: all nine flagged, sole
  // reason `above-star-ceiling`.
  //
  // Raising the number does not fix this, it moves the cliff: an absolute
  // ceiling on a quantity with no absolute bound will always have a market
  // above it somewhere. So the rule now yields to its own evidence, the same
  // way the median rules do — a tier where every row is over the line is
  // telling us about the market, not about a glitch. A single absurd row among
  // normal ones is still caught, which is the case it was built for.
  const condemnedTiers = new Set<number>();
  for (const [stars, tier] of (() => {
    const byStars = new Map<number, HotelResult[]>();
    for (const h of hotels) {
      if (!isUsablePrice(nightly(h))) continue;
      const k = starsOf(h);
      const t = byStars.get(k);
      if (t) t.push(h);
      else byStars.set(k, [h]);
    }
    return byStars;
  })()) {
    if (tier.length >= MIN_RESULTS_TO_FILTER && tier.every(overStarCeilingRaw)) {
      condemnedTiers.add(stars);
      logger.warn('Star ceiling ignored — it would condemn the whole tier', {
        city,
        stars,
        tierSize: tier.length,
        rooms,
        ceiling: BUDGET_STARS_PRICE_CEILING,
        cheapestInTier: Math.min(...tier.map(nightly)),
      });
    }
  }

  const overStarCeiling = (h: HotelResult) =>
    overStarCeilingRaw(h) && !condemnedTiers.has(starsOf(h));

  const tiers = new Map<number, HotelResult[]>();
  const allPrices: number[] = [];
  for (const h of hotels) {
    if (!isUsablePrice(nightly(h))) continue;
    if (overStarCeiling(h)) continue;
    allPrices.push(nightly(h));
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
    const median = medianOf(tier.map(nightly));
    if (!Number.isFinite(median) || median <= 0) continue;
    ceilings.set(stars, median * OUTLIER_MEDIAN_MULTIPLE);

    // A FLOOR ONLY FOR STARRED TIERS. The 0-star "tier" is not a price class —
    // it means Booking assigned no star rating, which lumps hostel private
    // rooms in with B&Bs, apartments and whole villas. It is intrinsically
    // bimodal and routinely spans more than 10x on its own, so a relative
    // floor there flags real budget stock: a Bangkok search of
    // [8, 10, 12, 150, 180, 200, 220, 250] has a median of 165 and a floor of
    // 16.50, which condemns all three genuine $8-12 rooms and hands hotels[0]
    // to the $150 apartment — 18x the cheapest room the search actually found,
    // and the exact opposite of what a price-led planner should do.
    //
    // A star rating is what makes a tier a price class, which is the same
    // reasoning that spares thin luxury tiers from the ceiling. With 1-5 stars
    // the floor means something; without them it is noise.
    if (stars >= 1) {
      floors.set(stars, median / UNDERPRICE_MEDIAN_DIVISOR);
    }
  }

  // Only used for unrated rows with no tier of their own to be judged against.
  const searchCeiling =
    allPrices.length >= MIN_RESULTS_TO_FILTER
      ? medianOf(allPrices) * UNRATED_SEARCH_MEDIAN_MULTIPLE
      : undefined;

  const reasonFor = (h: HotelResult): PriceSuspectReason | null => {
    if (!isUsablePrice(nightly(h))) return null;
    const stars = starsOf(h);
    const price = nightly(h);

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
      // The ceilings, floors and search ceiling below are per room.
      rooms,
      pricePerRoomNight: nightly(h),
      reason,
      tierCeiling: ceilings.get(starsOf(h)),
      tierFloor: floors.get(starsOf(h)),
      tierSize: tiers.get(starsOf(h))?.length,
      searchCeiling,
    });

    return { ...h, priceSuspect: true, priceSuspectReason: reason };
  });
}

/**
 * The review score we want, and the lower bars we will settle for to get
 * enough hotels to compare prices against.
 *
 * 7.0 was a flat filter applied to every search. It is OUR filter, not the
 * provider's, and on a thin search it was working against us twice over: it
 * left the traveller fewer options, AND it removed the peers every price check
 * depends on. A Val d'Isère search came back with exactly ONE hotel at
 * $3377.84/night, and a single row cannot be an outlier — the median of a
 * one-row set is that row, so no comparison of any kind reaches it.
 *
 * So the bar is a preference now, not a rule. Below MIN_RESULTS_TO_FILTER
 * hotels there is nothing to check a price against, and at that point four
 * hotels including some mediocre ones beats one hotel nobody can vouch for.
 * Ranking still puts the good ones first — `rating^2.8` is unkind to a 5.5 —
 * so widening costs ordering, not correctness.
 *
 * Free in both latency and quota: the rows are already in the response we
 * have. Only the floor we apply to them changes.
 */
const RATING_FLOORS = [7.0, 6.0, 5.0, 0];

/**
 * Take the best-rated rows we can while still having enough to compare.
 *
 * Walks down RATING_FLOORS until the set reaches MIN_RESULTS_TO_FILTER, or
 * until the floor runs out and we take everything the provider sent.
 */
export function pickByRating(rows: HotelResult[], city: string): HotelResult[] {
  const ratingOf = (h: HotelResult) => (Number.isFinite(h.rating) ? h.rating : 0);

  for (const floor of RATING_FLOORS) {
    const kept = rows.filter((h) => ratingOf(h) >= floor);
    if (kept.length >= MIN_RESULTS_TO_FILTER || floor === 0) {
      if (floor !== RATING_FLOORS[0] && kept.length > 0) {
        logger.warn('Hotel rating bar lowered to get enough rows to price-check', {
          city,
          floor,
          kept: kept.length,
          atPreferredFloor: rows.filter((h) => ratingOf(h) >= RATING_FLOORS[0]).length,
          offered: rows.length,
        });
      }
      return kept;
    }
  }

  return rows;
}

/**
 * Move rows whose price we do not trust to the END of the list, keeping
 * provider order within each group.
 *
 * THIS IS WHY IT LIVES HERE AND NOT ONLY IN THE FRONTEND. The first version of
 * this change put the whole demotion guarantee in `rankHotels`
 * (frontend/lib/hotelScore.ts) and asserted that `rankHotels` was the single
 * boundary every consumer passes through. It is not. `backend/src/routes/
 * canvas.ts` calls `searchHotels` directly when a city is saved with no hotels,
 * maps five fields, and takes `city.hotels[0]` straight out of provider order —
 * no ranking anywhere on that path, and `tripShape.ts` reads it back from the
 * database without re-ranking either.
 *
 * The guards this replaced survived that path by accident: they DELETED the bad
 * row, so index 0 was safe however it was chosen. Flagging instead of deleting
 * silently handed that path back its worst case. Measured on the production
 * Florence set in provider order, index 0 went from Radisson Blu at $170.31 to
 * Hotel Aldobrandini at $5383.47 — the $17,039 headline this whole change
 * exists to prevent, reintroduced by the fix for it.
 *
 * So the invariant belongs where the rows are produced: after this, `hotels[0]`
 * is a row we trust for EVERY caller — this route, the canvas route, the
 * frontend, and anything added later that reaches for index 0 without reading
 * this file. `rankHotels` still refines the ordering by score on top.
 *
 * The one case it cannot fix is a list with nothing trustworthy in it. If every
 * row is flagged the order is unchanged and index 0 is flagged, because a
 * suspicious price still beats an empty city.
 */
/**
 * The provider's property link, opened on the stay we priced.
 *
 * Booking returns a bare property page (`/hotel/fr/<slug>.html`), and that is
 * what the "Book" button opened: no dates, and Booking's own default party of
 * two in one room. So the traveller landed on a different price from the one
 * in their trip, for a stay they had not asked about — for a group, a very
 * different one, since the trip's price covers every room.
 *
 * These are the parameter names Booking's own search links use. Set rather
 * than appended, so a provider URL that already carries one is corrected
 * instead of duplicated, and anything else on it (affiliate ids, labels) is
 * kept. A URL that does not parse is returned as it came: a link without the
 * stay is the old behaviour, a broken link is worse.
 */
export function bookingUrlForStay(
  raw: string,
  stay: { checkin: string; checkout: string; adults: number; rooms: number },
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.searchParams.set('checkin', stay.checkin);
  url.searchParams.set('checkout', stay.checkout);
  url.searchParams.set('group_adults', String(stay.adults));
  url.searchParams.set('no_rooms', String(stay.rooms));
  return url.toString();
}

export function trustedFirst(hotels: HotelResult[]): HotelResult[] {
  const trusted: HotelResult[] = [];
  const suspect: HotelResult[] = [];
  for (const h of hotels) (h.priceSuspect ? suspect : trusted).push(h);
  return [...trusted, ...suspect];
}

/**
 * Short-TTL cache of vetted search results, mirroring the flight search cache
 * in flights.ts.
 *
 * Re-running a trip used to pay the whole hotel phase again — ~10.7s measured
 * for a re-run with nothing changed — and spent metered RapidAPI quota on an
 * answer we had just been given. Concurrent duplicates share one in-flight
 * request.
 *
 * Keyed by EVERY request parameter, rooms included (resolved, so an omitted
 * count and the same count passed explicitly are one search). `maxPrice` is in
 * the key although Booking never sees it, so no request is ever answered from
 * a search that was asked something else; but the cap itself is applied after
 * the cache, on a copy, so a search the cap empties still keeps the provider's
 * rows and its repeat is still free.
 *
 * An empty answer is never kept. It is how every failure below reports itself
 * — 429s exhausted, a provider error, a timeout, an unresolvable destination —
 * so caching it would cache the outage for ten minutes.
 */
const HOTEL_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const hotelSearchCache = new Map<string, { at: number; promise: Promise<HotelResult[]> }>();

function cachedHotelSearch(
  key: string,
  run: () => Promise<HotelResult[]>,
): Promise<HotelResult[]> {
  const hit = hotelSearchCache.get(key);
  if (hit && Date.now() - hit.at < HOTEL_SEARCH_CACHE_TTL_MS) return hit.promise;

  const promise = run();
  hotelSearchCache.set(key, { at: Date.now(), promise });
  const evict = () => {
    if (hotelSearchCache.get(key)?.promise === promise) hotelSearchCache.delete(key);
  };
  promise.then((rows) => {
    if (rows.length === 0) evict();
  }, evict);

  // Opportunistic sweep so a long-running process doesn't accumulate entries.
  if (hotelSearchCache.size > 500) {
    const cutoff = Date.now() - HOTEL_SEARCH_CACHE_TTL_MS;
    for (const [k, v] of hotelSearchCache) {
      if (v.at < cutoff) hotelSearchCache.delete(k);
    }
  }
  return promise;
}

export async function searchHotels(params: SearchHotelsParams): Promise<HotelResult[]> {
  const { city, hotelName, checkin, checkout, adults, maxPrice } = params;
  const rooms = params.rooms ?? roomsFor(adults);

  if (!env.RAPIDAPI_KEY) {
    logger.warn('RAPIDAPI_KEY not set — returning empty hotel results');
    return [];
  }

  const key = JSON.stringify([
    city,
    hotelName ?? null,
    checkin,
    checkout,
    adults,
    rooms,
    maxPrice ?? null,
  ]);
  const vetted = await cachedHotelSearch(key, () =>
    searchVettedHotels({ city, hotelName, checkin, checkout, adults, rooms }),
  );
  // Copies, so no caller can edit the rows the next caller will be served.
  let hotels = vetted.map((h) => ({ ...h }));

  if (maxPrice !== undefined) {
    const beforeCap = hotels.length;
    hotels = hotels.filter((h) => h.price <= maxPrice);

    // The one remaining filter that could clear a city in silence. It is the
    // user's own budget so an empty result is a legitimate answer, but it
    // must be distinguishable from the city having no hotels at all —
    // otherwise "no hotels in Florence" and "no hotels under your cap" look
    // the same in the logs and to anyone debugging a blank city.
    if (hotels.length === 0 && beforeCap > 0) {
      logger.warn('Hotel search emptied — every row was over the price cap', {
        city,
        maxPrice,
        rows: beforeCap,
      });
    }
  }

  // A search this thin disables every relative rule in `flagSuspectPrices`
  // (they all require MIN_RESULTS_TO_FILTER rows), and at one row
  // `rankHotels` has nothing to demote anything below either — so hotels[0]
  // is whatever the provider said, unchecked. That is the Val d'Isère case,
  // and it is structural rather than fixable with a threshold: covering it
  // needs a reference from outside the search. Until there is one, make it
  // visible — ordinary searches return 17-20 rows, so this is rare.
  if (hotels.length > 0 && hotels.length < MIN_RESULTS_TO_FILTER) {
    logger.warn('Hotel search too thin to price-check — hotels[0] is unverified', {
      city,
      rows: hotels.length,
      needed: MIN_RESULTS_TO_FILTER,
    });
  }

  // Last, so it also covers the case a price cap leaves only flagged rows:
  // an under-priced glitch is the one row guaranteed to survive a budget
  // filter, and the legitimate rows the ones guaranteed not to.
  return trustedFirst(hotels);
}

/**
 * One provider search, mapped, converted to USD and price-checked — everything
 * that depends only on what was asked of Booking. Never throws: any failure is
 * logged and comes back as no rows.
 */
async function searchVettedHotels(params: {
  city: string;
  hotelName?: string;
  checkin: string;
  checkout: string;
  adults: number;
  rooms: number;
}): Promise<HotelResult[]> {
  const { city, hotelName, checkin, checkout, adults, rooms } = params;
  // Checked by the caller; captured again so the narrowing reaches the fetch.
  const apiKey = env.RAPIDAPI_KEY;
  if (!apiKey) return [];

  try {
    const dest = hotelName ? await getHotelDestination(hotelName, city) : await getDestinationId(city);
    if (!dest) return [];
    const { dest_id, dest_type } = dest;

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
      // A fresh signal per attempt: a 429 retry gets its own full window.
      res = await fetch(url, {
        headers: {
          'X-RapidAPI-Key': apiKey,
          'X-RapidAPI-Host': 'booking-com.p.rapidapi.com',
        },
        signal: AbortSignal.timeout(BOOKING_FETCH_TIMEOUT_MS),
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

    const mapRow = (h: any): HotelResult => {
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
        bookingUrl: bookingUrlForStay(
          h.url ?? `https://www.booking.com/hotel/${h.hotel_id ?? ''}.html`,
          { checkin, checkout, adults, rooms },
        ),
        amenities: [] as string[],
      };
    };

    let hotels = pickByRating(results.map(mapRow), city);

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
    // BEFORE conversion, so a broken price is attributed to the right cause.
    // `convertToUsd` returns null for a non-finite amount as well as for an
    // unknown currency, and the caller below cannot tell those apart — so a
    // row with an unparseable `min_total_price` was being logged as "no USD
    // rate for any row" against a currency of USD, which is exactly the
    // investigation this logging is supposed to save. A price that is not a
    // number is not a currency problem, whatever its label.
    hotels = dropUnusablePrices(hotels, city, rooms);

    const { convertToUsd } = await import('./currency');
    const converted = await Promise.all(
      hotels.map(async (h): Promise<HotelResult | null> => {
        // No "is it already USD" short-circuit here on purpose. convertToUsd
        // is the single place that decides, and it returns null for a blank
        // or malformed code instead of trusting the raw number. All three
        // services used to carry their own `!x.currency || x.currency ===
        // 'USD'` test, and the `!x.currency` half was wrong in every one:
        // `currency: ''` meant "skip conversion", so a foreign amount was
        // read as dollars. A USD row costs one extra await that returns
        // before any rate lookup.
        const usdTotal = await convertToUsd(h.price, h.currency);
        // Derive the nightly rate rather than converting a second time.
        // `pricePerNight` is `totalPrice / nights` by construction at the
        // mapping above, so a second conversion bought nothing and cost a
        // second rate lookup and a second warn line per row — twenty
        // blank-currency rows emitted sixty-one log lines between them.
        const usdPerNight =
          usdTotal === null ? null : Math.round((usdTotal / nights) * 100) / 100;
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
    const beforeCurrencyDrop = hotels.length;
    const currenciesSeen = [...new Set(hotels.map((h) => h.currency || '(blank)'))];
    hotels = converted.filter((h): h is HotelResult => h !== null);

    // Currency coverage is the one filter here that can clear a whole city,
    // and it used to do it silently — a per-row warn says nothing about the
    // city having been emptied, so "Mauritius returns no hotels" read exactly
    // like "Mauritius has no hotels". This is the line that tells them apart,
    // and it names the currencies so the fix is a table entry rather than an
    // investigation. Error level on purpose: every other drop in this file
    // still leaves the customer a choice, and this one leaves them nothing.
    if (hotels.length === 0 && beforeCurrencyDrop > 0) {
      logger.error('Hotel search emptied — no USD rate for any row', {
        city,
        rows: beforeCurrencyDrop,
        currencies: currenciesSeen,
      });
    } else if (hotels.length < beforeCurrencyDrop) {
      logger.warn('Hotel rows lost to currency coverage', {
        city,
        dropped: beforeCurrencyDrop - hotels.length,
        of: beforeCurrencyDrop,
        currencies: currenciesSeen,
      });
    }

    // Drop first, flag second: an unusable price must not be in the set the
    // medians are computed from, or a row of 0s drags every floor down with it.
    hotels = dropUnusablePrices(hotels, city, rooms);
    // The price cap, the thin-search warning and `trustedFirst` run in
    // `searchHotels`, per call, on what this returns.
    return flagSuspectPrices(hotels, city, rooms);
  } catch (err: any) {
    logger.warn('Hotel search failed (non-fatal)', { message: err?.message, city });
    return [];
  }
}
