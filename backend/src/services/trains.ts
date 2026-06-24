import { env } from '../config/env';
import { getSupabase } from './supabase';
import { logger } from '../utils/logger';

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
  /**
   * True when we can't fully price-compare this journey — currently means
   * the provider returned no fare. Derived from REAL data, not a country
   * guess: a journey with a fare competes with flights on price; one
   * without can't, so the optimizer should lean on the priced option.
   */
  limitedCoverage: boolean;
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

  const res = await fetchWithTimeout(url);
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
  search(params: SearchTrainsParams): Promise<TrainOffer[]>;
}

/**
 * Deutsche Bahn REST provider. Always attempts (returns 'partial') and lets
 * the real API result + station-match filter decide whether there's actually
 * a journey — no hardcoded country list claiming coverage we don't have.
 */
async function searchDeutscheBahn(params: SearchTrainsParams): Promise<TrainOffer[]> {
  const { origin, destination, date } = params;

  try {
    const [fromId, toId] = await Promise.all([
      getStopId(origin),
      getStopId(destination),
    ]);

    const baseUrl = env.DB_REST_BASE_URL;
    const departureISO = new Date(date).toISOString();
    const url = `${baseUrl}/journeys?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}&departure=${encodeURIComponent(departureISO)}&results=5&stopovers=false`;

    const res = await fetchWithTimeout(url);
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
        // Honest, data-derived: a journey with no fare can't be price-compared.
        limitedCoverage: price == null,
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
    logger.warn('DB train search failed (non-fatal)', { message: err?.message, origin, destination });
    return [];
  }
}

const trainProviders: TrainProvider[] = [
  {
    id: 'deutsche-bahn',
    // Always attempt — real results (+ the station-match filter) decide
    // whether there's a journey, instead of guessing from a country list.
    coverage: () => 'partial',
    search: searchDeutscheBahn,
  },
  // Future real providers plug in here (no code changes elsewhere):
  //   { id: 'trainline', coverage: euOnly, search: searchTrainline },
  //   { id: 'kiwi-rail',  coverage: () => 'partial', search: searchKiwiRail },
];

/**
 * Query every train provider that covers the route, in parallel, and merge.
 * A provider failure is non-fatal (returns []), so one outage can't take
 * down the others. Empty result = no real train data → caller shows the
 * honest "no live train data" state.
 */
export async function searchTrains(params: SearchTrainsParams): Promise<TrainOffer[]> {
  const active = trainProviders.filter((p) => p.coverage(params) !== 'none');
  const results = await Promise.all(
    active.map((p) =>
      p.search(params).catch((err: any) => {
        logger.warn('Train provider failed (non-fatal)', {
          provider: p.id,
          message: err?.message,
        });
        return [] as TrainOffer[];
      }),
    ),
  );
  return results.flat();
}
