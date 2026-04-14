import { getDuffel } from './duffel';
import { getSupabase } from './supabase';
import { AppError } from '../middleware/error';
import { logger } from '../utils/logger';

export type FlightOffer = {
  id: string;
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

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err?.meta?.status ?? err?.statusCode ?? err?.status;
      if (status === 429 && attempt < maxAttempts) {
        const delay = Math.pow(2, attempt) * 1000;
        logger.warn('Duffel 429 — retrying', { attempt, delay });
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new AppError(500, 'Retry limit exceeded');
}

export async function searchFlights(params: SearchFlightsParams): Promise<FlightOffer[]> {
  const { origin, destination, date, travelers, cabinClass } = params;
  const duffel = getDuffel();

  try {
    const offerRequest = await withRetry(() =>
      duffel.offerRequests.create({
        slices: [
          {
            origin,
            destination,
            departure_date: date,
          } as any,
        ],
        passengers: Array.from({ length: travelers }, () => ({ type: 'adult' as const })),
        cabin_class: (cabinClass as any) || 'economy',
        return_offers: true,
      }),
    );

    const offers = offerRequest.data.offers ?? [];

    return offers.map((offer: any) => {
      const slice = offer.slices?.[0];
      const firstSegment = slice?.segments?.[0];
      const lastSegment = slice?.segments?.[slice.segments.length - 1];
      const carrier = firstSegment?.operating_carrier ?? firstSegment?.marketing_carrier ?? {};

      const depTime = new Date(firstSegment?.departing_at ?? date);
      const arrTime = new Date(lastSegment?.arriving_at ?? date);
      const durationMinutes = Math.round((arrTime.getTime() - depTime.getTime()) / 60000);

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
        bookingUrl: `https://duffel.com/redirect/offers/${offer.id}`,
        raw: offer,
      };
    });
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    logger.error('Duffel searchFlights failed', { message: err?.message, origin, destination });
    throw new AppError(502, `Flight search failed: ${err?.message ?? 'Unknown error'}`, {
      source: 'duffel',
    });
  }
}

export async function getIataCode(cityName: string): Promise<string> {
  const supabase = getSupabase();

  // Check cache first
  const { data: cached } = await supabase
    .from('airport_codes')
    .select('iata_code')
    .eq('city_name', cityName.toLowerCase())
    .single();

  if (cached?.iata_code) return cached.iata_code;

  // Fetch from Duffel
  const duffel = getDuffel();
  try {
    const response = await withRetry(() =>
      duffel.suggestions.list({ query: cityName }),
    );

    const places = (response as any)?.data ?? [];
    const airport = places.find(
      (p: any) => p.type === 'airport' || p.type === 'city',
    );

    if (!airport?.iata_code) {
      throw new AppError(404, `No IATA code found for "${cityName}"`);
    }

    // Cache it
    await supabase.from('airport_codes').upsert({
      city_name: cityName.toLowerCase(),
      iata_code: airport.iata_code,
      country: airport.iata_country_code ?? null,
    });

    return airport.iata_code;
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, `IATA lookup failed for "${cityName}": ${err?.message}`);
  }
}
