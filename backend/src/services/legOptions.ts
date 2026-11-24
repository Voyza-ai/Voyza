/**
 * searchLegOptions — fetch top N flight/train options for a single leg,
 * optionally filtered by a time window (earliest/latest depart/arrive).
 *
 * Used by the BlueMurr AI chat when a user sets a transport constraint
 * ("no flights before 5pm") — we re-search the leg with the window
 * applied and present real alternatives in the proposal card, instead
 * of just silently storing a constraint to honor "later".
 *
 * Returns options cheapest first (long journeys last) with priceDelta against the user's
 * current transport so the UI can render the savings at a glance.
 */

import { searchFlights, getIataCode, FlightOffer } from './flights';
import { sameAirportArea } from './location/sameAirportArea';
import { formatDurationMinutes } from '../utils/duration';
import { searchTrains, TrainOffer, type RailPriceSource } from './trains';
import { flightDoorToDoor, trainCo2, trainDoorToDoor, type Co2Figure, type DoorToDoor } from './legFacts';
import { logger } from '../utils/logger';
import { getCityCountry } from '../data/cityCountries';
import { comparePick, longJourneyLimit, isLongMinutes } from './longJourney';

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
  /** City centre to city centre (legFacts). Absent when it can't be built. */
  doorToDoor?: DoorToDoor | null;
  /** Party CO₂ — Duffel's for a flight, our estimate for a train. */
  co2?: Co2Figure | null;
  /** Trains only: where the fare came from. */
  priceSource?: RailPriceSource;
};

/** Only the facts that could be built — no `null` keys on the wire. */
function withFacts(f: { doorToDoor?: DoorToDoor | null; co2?: Co2Figure | null }): Partial<LegOption> {
  return {
    ...(f.doorToDoor ? { doorToDoor: f.doorToDoor } : {}),
    ...(f.co2 ? { co2: f.co2 } : {}),
  };
}

type LegEnds = { from: { city: string; country?: string }; to: { city: string; country?: string }; travelers: number };

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
  /**
   * Every city on the trip, so a name with more than one reading resolves
   * to the one this trip means (getIataCode's `tripDestinationNames`):
   * "Lagos" on a Lisbon + Porto trip is FAO, not LOS. Optional — without it
   * each name gets its no-context answer, as before.
   */
  tripCityNames?: string[];
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

/**
 * Read a clock time the AI chat passed as a window bound and return it as
 * 24-hour HH:MM, or null when it isn't a time we can read.
 *
 * The tool schema asks for HH:MM, but the model also sends "5pm". That
 * used to reach toMinutesOfDay(), parse to NaN → null, and the bound was
 * dropped without a word: scripted on /api/plan/chat, "no flights before
 * 5pm" returned the 07:15 and 16:00 Rome → Venice flights under a reply
 * saying "departing after 5pm" (B10). Accepts "17:00", "7:05", "17:00:00",
 * "5pm", "5 PM", "5:30pm", "5 p.m." and "noon". A bare hour ("5" — morning
 * or evening?), an out-of-range one ("25:00", "13pm") or a word
 * ("evening") is null, so the caller can say it couldn't apply it.
 */
export function normalizeTimeOfDay(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  const hhmm = (h: number, m: number) =>
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  if (s === 'noon' || s === '12 noon' || s === 'midday') return '12:00';

  const h24 = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(s);
  if (h24) {
    const h = Number(h24[1]);
    const m = Number(h24[2]);
    return h <= 23 && m <= 59 ? hhmm(h, m) : null;
  }

  const h12 = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/.exec(s);
  if (h12) {
    const h = Number(h12[1]);
    const m = h12[2] ? Number(h12[2]) : 0;
    if (h < 1 || h > 12 || m > 59) return null;
    return hhmm((h % 12) + (h12[3] === 'p' ? 12 : 0), m);
  }

  return null;
}

const WINDOW_BOUNDS = ['earliestDepart', 'latestDepart', 'earliestArrive', 'latestArrive'] as const;

/** A TimeWindow whose every bound is HH:MM or null. */
export type NormalizedTimeWindow = Record<(typeof WINDOW_BOUNDS)[number], string | null>;

/**
 * Normalise every bound of a time window to HH:MM (unset/blank → null).
 * Returns the first bound that can't be read instead of dropping it, so a
 * caller never filters — or tells the user it filtered — on a bound that
 * was silently ignored.
 */
export function normalizeTimeWindow(
  window: TimeWindow,
):
  | { ok: true; window: NormalizedTimeWindow }
  | { ok: false; bound: (typeof WINDOW_BOUNDS)[number]; raw: unknown } {
  const out = {} as NormalizedTimeWindow;
  for (const bound of WINDOW_BOUNDS) {
    const raw = window[bound];
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
      out[bound] = null;
      continue;
    }
    const value = normalizeTimeOfDay(raw);
    if (value == null) return { ok: false, bound, raw };
    out[bound] = value;
  }
  return { ok: true, window: out };
}

function formatHHMM(s: string | null | undefined): string | null {
  const mins = toMinutesOfDay(s);
  if (mins == null) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const formatDuration = formatDurationMinutes;

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
function flightToOption(offer: FlightOffer, currentPrice: number, ends?: LegEnds): LegOption {
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
    ...(offer.co2 ? { co2: offer.co2 } : {}),
    ...withFacts({
      doorToDoor: ends
        ? flightDoorToDoor({
            from: ends.from,
            to: ends.to,
            originAirport: offer.originAirport,
            destinationAirport: offer.destinationAirport,
            flightMinutes: offer.durationMinutes,
          })
        : null,
    }),
  };
}

/** Map a TrainOffer into the unified LegOption shape. */
function trainToOption(offer: TrainOffer, currentPrice: number, ends?: LegEnds): LegOption {
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
    ...(offer.priceSource ? { priceSource: offer.priceSource } : {}),
    ...withFacts({
      doorToDoor: ends ? trainDoorToDoor(offer.durationMinutes) : null,
      co2: ends ? trainCo2(ends.from, ends.to, ends.travelers) : null,
    }),
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
    currentPrice = 0,
    limit = 5,
    fromAirports,
    tripCityNames,
  } = params;

  // Read every bound up front. One we can't read is an error, not a
  // no-op: filtering on the rest would return options that break the
  // user's bound under a reply that claims it (the "5pm" bug above).
  // /api/plan/chat normalises first and answers the user itself, so this
  // only fires for a caller that skipped that.
  let window: TimeWindow | undefined;
  if (params.window) {
    const normalized = normalizeTimeWindow(params.window);
    if (!normalized.ok) {
      throw new Error(
        `searchLegOptions: unreadable ${normalized.bound} ${JSON.stringify(normalized.raw)}`,
      );
    }
    window = normalized.window;
  }

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
        // The trip decides which reading of a shared name it means.
        const tripContext = { tripDestinationNames: tripCityNames ?? [] };
        const destIata = await getIataCode(to, tripContext);
        const origins =
          fromAirports && fromAirports.length > 0
            ? fromAirports
            : [await getIataCode(from, tripContext)];

        // One searchFlights call per origin airport; results merged.
        // Individual origin failures (e.g. LGA has no offers but JFK does)
        // are tolerated — we keep whatever returned. An origin that shares
        // the destination's airport (Zurich → Interlaken: ZRH → ZRH) has no
        // flight to search; the leg is ground travel, and the trains below
        // still answer it.
        const resultsPerOrigin = await Promise.all(
          origins.map((originIata) =>
            sameAirportArea(originIata, destIata)
              ? Promise.resolve([] as FlightOffer[])
              : searchFlights({
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
  const ends: LegEnds = {
    from: { city: from, country: fromCountry ?? getCityCountry(from) },
    to: { city: to, country: toCountry ?? getCityCountry(to) },
    travelers,
  };
  const allOptions: LegOption[] = [
    ...flights.map((f) => flightToOption(f, currentPrice, ends)),
    ...trains.map((t) => trainToOption(t, currentPrice, ends)),
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

  const options = orderLegOptions(matched, limit);

  return {
    options,
    hasMatches: options.length > 0,
    windowFilteredAll: windowActive && allOptions.length > 0 && options.length === 0,
  };
}

/**
 * The order a leg card shows its options in, cut to `limit`. options[0] is
 * what a new plan's card shows, so it has to be what compareLeg scored the
 * leg with, or the card and the trip total disagree.
 *
 * Cheapest first, long journeys (longJourney.ts) after every sensible one,
 * unpriced options (null / 0) last within their group. Two rules on top:
 *
 * 1. A FLIGHT is long against the fastest FLIGHT, a TRAIN against the fastest
 *    TRAIN — never across modes. That is compareLeg's own rule
 *    (cheapestSensible over each mode). Judging both modes together made Vienna → Munich's
 *    4h03m ÖBB train ($56) "long" next to a 1h flight (limit 4h00m): it
 *    sorted behind four $364 flights, fell off the top 4, and the card
 *    showed the flight while the optimizer had picked the route on the train.
 *    The rule exists to bury 22h 50m connecting itineraries, which are
 *    flights; a 4h train against a 1h flight is the comparison the product
 *    is for.
 * 2. Both modes stay on the card. When the cut would drop every option of a
 *    mode that has a priced one, that mode's best takes the last slot, so a
 *    leg never shows "no train" (or no flight) for a train it actually found.
 */
export function orderLegOptions(options: LegOption[], limit: number): LegOption[] {
  const flightLimit = longJourneyLimit(
    options.filter((o) => o.mode === 'flight').map((o) => o.durationMinutes),
  );
  // Trains the same way, against the fastest TRAIN — never against a flight
  // (rule 1). Buries a 39h 12m Munich → Prague connection behind the 5h 37m
  // train, as compareLeg does.
  const trainLimit = longJourneyLimit(
    options.filter((o) => o.mode === 'train').map((o) => o.durationMinutes),
  );
  const rank = (o: LegOption) =>
    isLongMinutes(o.durationMinutes, o.mode === 'flight' ? flightLimit : trainLimit) ? 1 : 0;
  const price = (o: LegOption) =>
    typeof o.price === 'number' && o.price > 0 ? o.price : Infinity;
  // Within a group: priced first, daytime before small hours (00:00–04:59),
  // cheapest first (longJourney.ts comparePick).
  const sorted = options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => rank(a.o) - rank(b.o) || comparePick(a.o, b.o) || a.i - b.i)
    .map((x) => x.o);

  const top = sorted.slice(0, Math.max(0, limit));
  if (limit < 2) return top;
  for (const mode of ['train', 'flight'] as const) {
    if (top.some((o) => o.mode === mode)) continue;
    const best = sorted.find((o) => o.mode === mode && price(o) < Infinity);
    if (!best) continue;
    if (top.length < limit) top.push(best);
    else top[top.length - 1] = best;
  }
  return top;
}
