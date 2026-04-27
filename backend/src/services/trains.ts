import { env } from '../config/env';
import { getSupabase } from './supabase';
import { logger } from '../utils/logger';
import { getStaticTrain } from '../data/staticTrains';

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

// Countries where Deutsche Bahn's v6.db.transport.rest API returns
// reliable multi-operator train data. DACH (DE/AT/CH) is covered natively,
// and DB's public timetable also integrates well with the major European
// rail operators (Trenitalia, SNCF, NS, SBB, ÖBB, etc.), so we expand
// the "good coverage" set to the rest of Western/Central Europe.
const RAIL_COVERAGE_COUNTRIES = new Set([
  'DE', 'AT', 'CH',           // DACH (native)
  'IT',                        // Trenitalia
  'FR',                        // SNCF
  'BE', 'NL', 'LU',            // Benelux
  'DK', 'SE', 'NO',            // Scandinavia
  'PL', 'CZ', 'SK',            // Central EU
  'ES', 'PT',                  // Iberia
  'HU', 'SI', 'HR',            // S/E Europe
  'GB',                        // UK (Eurostar)
]);

function isOutsideDACH(country?: string): boolean {
  // Name kept for backward compatibility — now checks the broader set.
  if (!country) return true;
  return !RAIL_COVERAGE_COUNTRIES.has(country.toUpperCase());
}

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
 * cases pass: "Florence" matches "Firenze S.M.N." won't, but
 * "Frankfurt" → "Frankfurt(Main)Hbf" does. Translation gaps (Roma vs
 * Rome) are accepted false-negatives; the tradeoff is that an obvious
 * mismatch like "Reykjavik vs Some German Station" is caught.
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

  // Step 1: check the static route table first. Covers JR shinkansen,
  // Korail KTX, China HSR, Taiwan HSR, and a few Indian expresses — routes
  // DB REST either doesn't carry or returns nonsense for. Hits here skip
  // the API call entirely.
  const staticRoute = getStaticTrain(origin, destination);
  if (staticRoute) {
    // Build a plausible departure time: 10:00 on the travel date, arriving
    // departure + duration. Good enough until we wire real timetables.
    const depDate = new Date(`${date}T10:00:00`);
    const arrDate = new Date(depDate.getTime() + staticRoute.durationMinutes * 60_000);
    return [
      {
        id: `static-${staticRoute.from}-${staticRoute.to}`,
        price: staticRoute.priceUsd,
        currency: 'USD',
        departure: depDate.toISOString(),
        arrival: arrDate.toISOString(),
        durationMinutes: staticRoute.durationMinutes,
        operator: staticRoute.operator,
        trainType: staticRoute.trainType,
        bookingUrl: staticRoute.bookingUrl,
        // Static data is confidence-rated as reliable — trains should
        // compete with flights on the cheapest / fastest logic.
        limitedCoverage: false,
      },
    ];
  }

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
    const allJourneys = data.journeys ?? [];
    const limitedCoverage = isOutsideDACH(originCountry) || isOutsideDACH(destinationCountry);

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

    const mapped = journeys.map((journey: any, idx: number) => {
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

    // Convert all prices to USD (DB REST returns EUR)
    const { convertToUsd } = await import('./currency');
    return await Promise.all(
      mapped.map(async (t: any) => {
        if (t.price == null || !t.currency || t.currency === 'USD') return t;
        const usd = await convertToUsd(t.price, t.currency);
        return { ...t, price: usd, currency: 'USD' };
      }),
    );
  } catch (err: any) {
    logger.warn('Train search failed (non-fatal)', { message: err?.message, origin, destination });
    return [];
  }
}
