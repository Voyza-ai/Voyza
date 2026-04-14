import { env } from '../config/env';
import { getSupabase } from './supabase';
import { logger } from '../utils/logger';

export type TrainOffer = {
  id: string;
  price: number | null;
  currency: string;
  departure: string;
  arrival: string;
  durationMinutes: number;
  operator: string;
  trainType: string;
  bookingUrl: string;
  limitedCoverage: boolean;
};

const DACH_COUNTRIES = new Set(['DE', 'AT', 'CH']);

function isOutsideDACH(country?: string): boolean {
  if (!country) return true;
  return !DACH_COUNTRIES.has(country.toUpperCase());
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

  const res = await fetch(url);
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

export async function searchTrains(params: SearchTrainsParams): Promise<TrainOffer[]> {
  const { origin, destination, date, originCountry, destinationCountry } = params;

  try {
    const [fromId, toId] = await Promise.all([
      getStopId(origin),
      getStopId(destination),
    ]);

    const baseUrl = env.DB_REST_BASE_URL;
    const departureISO = new Date(date).toISOString();
    const url = `${baseUrl}/journeys?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}&departure=${encodeURIComponent(departureISO)}&results=5&stopovers=false`;

    const res = await fetch(url);
    if (!res.ok) {
      logger.warn('DB journeys API error', { status: res.status, origin, destination });
      return [];
    }

    const data: any = await res.json();
    const journeys = data.journeys ?? [];
    const limitedCoverage = isOutsideDACH(originCountry) || isOutsideDACH(destinationCountry);

    return journeys.map((journey: any, idx: number) => {
      const legs = journey.legs ?? [];
      const firstLeg = legs[0];
      const lastLeg = legs[legs.length - 1];

      const depTime = firstLeg?.departure ? new Date(firstLeg.departure) : new Date(date);
      const arrTime = lastLeg?.arrival ? new Date(lastLeg.arrival) : depTime;
      const durationMinutes = Math.round((arrTime.getTime() - depTime.getTime()) / 60000);

      const price = journey.price?.amount ? parseFloat(journey.price.amount) : null;
      const operator = firstLeg?.line?.operator?.name ?? firstLeg?.line?.name ?? 'Unknown';
      const trainType = firstLeg?.line?.productName ?? firstLeg?.line?.product ?? 'train';

      return {
        id: `db-${fromId}-${toId}-${idx}`,
        price,
        currency: journey.price?.currency ?? 'EUR',
        departure: firstLeg?.departure ?? '',
        arrival: lastLeg?.arrival ?? '',
        durationMinutes,
        operator,
        trainType,
        bookingUrl: 'https://www.bahn.de/buchung/start',
        limitedCoverage,
      };
    });
  } catch (err: any) {
    logger.warn('Train search failed (non-fatal)', { message: err?.message, origin, destination });
    return [];
  }
}
