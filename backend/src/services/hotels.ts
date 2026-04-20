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
    const res = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': env.RAPIDAPI_KEY,
        'X-RapidAPI-Host': 'booking-com.p.rapidapi.com',
      },
    });

    if (!res.ok) {
      logger.warn('Booking.com search API error', { status: res.status });
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
    const { convertToUsd } = await import('./currency');
    hotels = await Promise.all(
      hotels.map(async (h) => {
        if (!h.currency || h.currency === 'USD') return h;
        const usdTotal = await convertToUsd(h.price, h.currency);
        const usdPerNight = await convertToUsd(h.pricePerNight, h.currency);
        return {
          ...h,
          price: usdTotal,
          pricePerNight: usdPerNight,
          currency: 'USD',
        };
      }),
    );

    if (maxPrice !== undefined) {
      hotels = hotels.filter((h) => h.price <= maxPrice);
    }

    return hotels;
  } catch (err: any) {
    logger.warn('Hotel search failed (non-fatal)', { message: err?.message, city });
    return [];
  }
}
