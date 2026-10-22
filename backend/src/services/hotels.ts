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
};

async function getDestinationId(
  cityName: string,
): Promise<{ dest_id: string; dest_type: string }> {
  const supabase = getSupabase();

  // Check cache
  const { data: cached } = await supabase
    .from('booking_locations')
    .select('dest_id, dest_type')
    .eq('city_name', cityName.toLowerCase())
    .single();

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

  // Cache
  await supabase.from('booking_locations').upsert({
    city_name: cityName.toLowerCase(),
    dest_id: String(city.dest_id),
    dest_type: city.dest_type,
  });

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

/** A hotel priced above this multiple of the set's median is treated as junk. */
const OUTLIER_MEDIAN_MULTIPLE = 5;

/**
 * Absolute per-night ceiling for a hotel the provider itself calls 1-3 stars.
 *
 * Deliberately generous — roughly 4x the top end of a 3-star in an expensive
 * city in peak season — because a false drop costs a real option, while the
 * case this catches sits 5x above it. "Hotel Aldobrandini", stars: 3, came
 * back at $5383.47/night.
 */
const BUDGET_STARS_PRICE_CEILING = 1000;

/** Below this many results the median isn't meaningful, so don't filter on it. */
const MIN_RESULTS_TO_FILTER = 4;

/**
 * Drop provider rows whose per-night price is wildly out of line with the rest
 * of the same search.
 *
 * Measured in production: a Florence search (2027-04-10 → 04-13, 2 adults)
 * returned "Hotel Aldobrandini" at $5383.47/night against a $267 median — and
 * the provider returned it FIRST, so it became the trip's hotel and 95% of a
 * $17,039 total displayed as "Best price for these dates".
 *
 * `pricePerNight` is already `totalPrice / nights` by this point, so this is
 * not our arithmetic: the provider is quoting for a different occupancy or
 * room count than we asked for. We can't fix their data, only refuse it.
 *
 * Deliberately a median rather than a mean — a mean is dragged upward by the
 * very outlier we're trying to catch. An expensive city just has an expensive
 * median, so the multiple travels without needing per-city thresholds.
 */
/**
 * Reject prices that are implausible on their own terms, without comparing
 * them to anything.
 *
 * `dropPriceOutliers` below is *relative* — it asks whether a hotel is out of
 * line with its own search. That is blind to two cases: a small result set
 * where the median means nothing, and a feed that is uniformly wrong, where
 * the median moves with the error and every row looks reasonable next to its
 * neighbours.
 *
 * The provider hands us a star rating it assigned itself, and a 1-3 star
 * property cannot credibly cost four figures a night. That judgement needs no
 * comparison set, so it still holds when the relative check cannot help.
 *
 * Only applied to 1-3 stars. 4-5 stars genuinely reach those prices, and 0
 * means unrated — which covers B&Bs, apartments and whole villas, where there
 * is no defensible ceiling.
 */
export function dropImplausiblePrices(hotels: HotelResult[], city: string): HotelResult[] {
  const kept = hotels.filter((h) => {
    const budgetTier = h.stars >= 1 && h.stars <= 3;
    const absurd =
      budgetTier && Number.isFinite(h.pricePerNight) && h.pricePerNight > BUDGET_STARS_PRICE_CEILING;
    if (absurd) {
      logger.warn('Hotel dropped — price implausible for its star rating', {
        city,
        hotel: h.name,
        stars: h.stars,
        pricePerNight: h.pricePerNight,
        ceiling: BUDGET_STARS_PRICE_CEILING,
      });
    }
    return !absurd;
  });

  // Same reasoning as the median guard: an empty city is worse than a
  // suspicious one. If this would clear the board, the data is wrong in some
  // way this rule doesn't model.
  return kept.length > 0 ? kept : hotels;
}

export function dropPriceOutliers(hotels: HotelResult[], city: string): HotelResult[] {
  if (hotels.length < MIN_RESULTS_TO_FILTER) return hotels;

  const prices = hotels
    .map((h) => h.pricePerNight)
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);
  if (prices.length < MIN_RESULTS_TO_FILTER) return hotels;

  const mid = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 1 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  if (!Number.isFinite(median) || median <= 0) return hotels;

  const ceiling = median * OUTLIER_MEDIAN_MULTIPLE;
  const kept = hotels.filter((h) => !(Number.isFinite(h.pricePerNight) && h.pricePerNight > ceiling));

  // If everything looks like an outlier, the median is the thing that's wrong.
  // Returning nothing would silently empty the city, which is worse than
  // showing suspicious prices.
  if (kept.length === 0) return hotels;

  for (const h of hotels) {
    if (!kept.includes(h)) {
      logger.warn('Hotel dropped — price far above the median for this search', {
        city,
        hotel: h.name,
        pricePerNight: h.pricePerNight,
        median,
        ceiling,
      });
    }
  }

  return kept;
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

    // Absolute check first: it works on any size of result set, so it can
    // catch a row the median guard would be powerless against.
    hotels = dropImplausiblePrices(hotels, city);
    hotels = dropPriceOutliers(hotels, city);

    if (maxPrice !== undefined) {
      hotels = hotels.filter((h) => h.price <= maxPrice);
    }

    return hotels;
  } catch (err: any) {
    logger.warn('Hotel search failed (non-fatal)', { message: err?.message, city });
    return [];
  }
}
