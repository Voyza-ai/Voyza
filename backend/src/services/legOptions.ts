/**
 * searchLegOptions — fetch top N flight/train options for a single leg,
 * optionally filtered by a time window (earliest/latest depart/arrive).
 *
 * Used by the BlueMurr AI chat when a user sets a transport constraint
 * ("no flights before 5pm") — we re-search the leg with the window
 * applied and present real alternatives in the proposal card, instead
 * of just silently storing a constraint to honor "later".
 *
 * Returns sorted-by-price options with priceDelta against the user's
 * current transport so the UI can render the savings at a glance.
 */

import { searchFlights, getIataCode, FlightOffer } from './flights';
import { searchTrains, TrainOffer } from './trains';
import { logger } from '../utils/logger';
import { getCityCountry } from '../data/cityCountries';

export type TimeWindow = {
  earliestDepart?: string | null; // HH:MM
  latestDepart?: string | null;
  earliestArrive?: string | null;
  latestArrive?: string | null;
};

export type LegOption = {
  mode: 'flight' | 'train';
  operator: string;
  flightNumber?: string | null;
  price: number;
  currency: string;
  /** HH:MM local time at origin. */
  departTime: string | null;
  /** HH:MM local time at destination. */
  arriveTime: string | null;
  /** Human duration string like "2h 15m". */
  duration: string;
  durationMinutes: number;
  stops?: number;
  bookingUrl?: string | null;
  /** Delta vs the user's current transport price for this leg ($). */
  priceDelta: number;
};

type SearchParams = {
  from: string;
  to: string;
  date: string;
  travelers: number;
  fromCountry?: string;
  toCountry?: string;
  /** Optional time filter — HH:MM strings. If all fields are null/unset, no filter is applied. */
  window?: TimeWindow;
  /** The user's current transport for this leg, used to compute priceDelta in the output. */
  currentPrice?: number;
  /** How many options to return (total, split across flights + trains). Default 5. */
  limit?: number;
  /**
   * Optional: explicit origin airport IATA codes to search from in parallel.
   * When the origin is a multi-airport city (NYC → JFK/LGA/EWR), pass all 3
   * here — we'll search each in parallel and merge results. When omitted we
   * fall back to getIataCode(from) which returns a single airport.
   * Destination is always single-airport (no multi-airport logic on the
   * destination side for now).
   */
  fromAirports?: string[];
};

/**
 * Parse an ISO datetime or HH:MM string into minutes-since-midnight.
 * Used for comparing against HH:MM window bounds.
 */
function toMinutesOfDay(s: string | null | undefined): number | null {
  if (!s) return null;
  // Accept "13:25" or "2026-06-04T13:25:00+02:00" etc.
  const hhmm = s.length <= 5 ? s : s.split('T')[1]?.slice(0, 5);
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function formatHHMM(s: string | null | undefined): string | null {
  const mins = toMinutesOfDay(s);
  if (mins == null) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function formatDuration(mins: number): string {
  if (!mins || mins < 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

/**
 * Does a given option satisfy the window? All bounds are HH:MM in local
 * time; any unset bound passes automatically. An option with no
 * departure/arrival timestamp (shouldn't happen in practice but guard
 * for it) is considered to match so we don't silently drop valid
 * results because of a data gap.
 */
function matchesWindow(
  departTimeHHMM: string | null,
  arriveTimeHHMM: string | null,
  window?: TimeWindow,
): boolean {
  if (!window) return true;
  const depMin = toMinutesOfDay(departTimeHHMM);
  const arrMin = toMinutesOfDay(arriveTimeHHMM);

  const earliestDep = toMinutesOfDay(window.earliestDepart);
  const latestDep = toMinutesOfDay(window.latestDepart);
  const earliestArr = toMinutesOfDay(window.earliestArrive);
  const latestArr = toMinutesOfDay(window.latestArrive);

  if (depMin != null) {
    if (earliestDep != null && depMin < earliestDep) return false;
    if (latestDep != null && depMin > latestDep) return false;
  }
  if (arrMin != null) {
    if (earliestArr != null && arrMin < earliestArr) return false;
    if (latestArr != null && arrMin > latestArr) return false;
  }
  return true;
}

/** Map a FlightOffer into the unified LegOption shape. */
function flightToOption(offer: FlightOffer, currentPrice: number): LegOption {
  const departTime = formatHHMM(offer.departure);
  const arriveTime = formatHHMM(offer.arrival);
  // Duffel offer ids look like "off_..." — we don't expose them, but we
  // DO want a human "flight number" where possible. The Duffel raw
  // response nests that, but the top-level carrier + carrierCode is
  // usually enough for the card.
  const flightNumber = offer.carrierCode ? offer.carrierCode : offer.carrier;
  return {
    mode: 'flight',
    operator: offer.carrier,
    flightNumber,
    price: offer.price,
    currency: offer.currency,
    departTime,
    arriveTime,
    duration: formatDuration(offer.durationMinutes),
    durationMinutes: offer.durationMinutes,
    stops: offer.stops,
    bookingUrl: offer.bookingUrl,
    priceDelta: Math.round((offer.price - currentPrice) * 100) / 100,
  };
}

/** Map a TrainOffer into the unified LegOption shape. */
function trainToOption(offer: TrainOffer, currentPrice: number): LegOption {
  const departTime = formatHHMM(offer.departure);
  const arriveTime = formatHHMM(offer.arrival);
  return {
    mode: 'train',
    operator: offer.operator,
    flightNumber: null,
    price: offer.price ?? 0,
    currency: offer.currency,
    departTime,
    arriveTime,
    duration: formatDuration(offer.durationMinutes),
    durationMinutes: offer.durationMinutes,
    bookingUrl: offer.bookingUrl,
    priceDelta:
      typeof offer.price === 'number'
        ? Math.round((offer.price - currentPrice) * 100) / 100
        : 0,
  };
}

export async function searchLegOptions(
  params: SearchParams,
): Promise<{
  options: LegOption[];
  /** True if we filtered by a window AND found at least one match. */
  hasMatches: boolean;
  /** True if a window was applied but zero options matched. The caller
   *  should render an answer_only conflict message in that case. */
  windowFilteredAll: boolean;
}> {
  const {
    from,
    to,
    date,
    travelers,
    fromCountry,
    toCountry,
    window,
    currentPrice = 0,
    limit = 5,
    fromAirports,
  } = params;

  // Kick both API calls off in parallel; tolerate each failing
  // independently so a flight outage doesn't eat the train results.
  //
  // Flight search branches on multi-airport: when caller passes
  // fromAirports = [JFK, LGA, EWR], we fire 3 parallel searches and
  // merge. For every other case we resolve a single IATA via
  // getIataCode(). Train search is always single-city (no concept of
  // multiple origin "airports" for trains).
  const [flights, trains] = await Promise.all([
    (async () => {
      try {
        const destIata = await getIataCode(to);
        const origins =
          fromAirports && fromAirports.length > 0
            ? fromAirports
            : [await getIataCode(from)];

        // One searchFlights call per origin airport; results merged.
        // Individual origin failures (e.g. LGA has no offers but JFK does)
        // are tolerated — we keep whatever returned.
        const resultsPerOrigin = await Promise.all(
          origins.map((originIata) =>
            searchFlights({
              origin: originIata,
              destination: destIata,
              date,
              travelers,
            }).catch((err) => {
              logger.warn('searchLegOptions: one origin failed', {
                origin: originIata,
                to,
                message: err?.message,
              });
              return [] as FlightOffer[];
            }),
          ),
        );
        return resultsPerOrigin.flat();
      } catch (err) {
        logger.warn('searchLegOptions: flight search failed', {
          from,
          to,
          message: (err as any)?.message,
        });
        return [] as FlightOffer[];
      }
    })(),
    searchTrains({
      origin: from,
      destination: to,
      date,
      travelers,
      originCountry: fromCountry ?? getCityCountry(from),
      destinationCountry: toCountry ?? getCityCountry(to),
    }).catch(() => [] as TrainOffer[]),
  ]);

  // Unified list — both shapes mapped to LegOption so the frontend
  // renders them identically (only the `mode` field distinguishes).
  const allOptions: LegOption[] = [
    ...flights.map((f) => flightToOption(f, currentPrice)),
    ...trains.map((t) => trainToOption(t, currentPrice)),
  ];

  const windowActive = !!(
    window &&
    (window.earliestDepart ||
      window.latestDepart ||
      window.earliestArrive ||
      window.latestArrive)
  );

  const matched = windowActive
    ? allOptions.filter((o) => matchesWindow(o.departTime, o.arriveTime, window))
    : allOptions;

  // Sort cheapest-first so the default-selected option in the UI
  // maximizes savings. Options with price=0 (data gap) go to the end
  // rather than misleading the user into thinking the train is free.
  matched.sort((a, b) => {
    const pa = a.price || Infinity;
    const pb = b.price || Infinity;
    return pa - pb;
  });

  const options = matched.slice(0, limit);

  return {
    options,
    hasMatches: options.length > 0,
    windowFilteredAll: windowActive && allOptions.length > 0 && options.length === 0,
  };
}
