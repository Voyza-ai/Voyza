import { searchFlights, getIataCode, FlightOffer, type IataLookupContext } from './flights';
import { searchTrains, TrainOffer } from './trains';
import { getSupabase } from './supabase';
import { logger } from '../utils/logger';
import { getStaticIata } from '../data/cityAirports';
import { resolveDestinationIata } from './location/destinationAirport';
import { sameAirportArea } from './location/sameAirportArea';

/**
 * Both options are priced as PARTY TOTALS for `travelers` — Duffel quotes
 * the whole passenger set, and `searchTrains` scales rail fares to match —
 * so `cheapest`, `priceDifference` and the optimizer's route costs compare
 * like with like. The frontend's per-person toggle divides by `travelers`.
 */
export type LegComparison = {
  flightOption: FlightOffer | null;
  trainOption: TrainOffer | null;
  cheapest: 'flight' | 'train' | 'same' | 'unavailable';
  fastest: 'flight' | 'train' | 'same' | 'unavailable';
  recommendation: 'flight' | 'train' | 'unavailable';
  /** Party-total difference in USD. */
  priceDifference: number;
  timeDifference: number;
};

const AIRPORT_OVERHEAD_MINUTES = 180;

/**
 * A duration we're willing to reason about, or null for "unknown".
 *
 * Anything non-positive is a data gap, never a real journey: flights used to
 * arrive here at -720 minutes (local-time timestamps subtracted across a
 * timezone boundary), which made the flight beat every train on time, win
 * the within-10% price tiebreak, and get written into leg_price_cache for
 * two hours. Cached rows are run through this too, since bad values may
 * already be sitting in the table from before the fix.
 */
function knownDuration(minutes: unknown): number | null {
  return typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0
    ? minutes
    : null;
}

export type CompareLegParams = {
  origin: string;
  destination: string;
  date: string;
  travelers: number;
  originCountry?: string;
  destinationCountry?: string;
  /**
   * Every city on the trip, handed to getIataCode as `tripDestinationNames`
   * so a name with more than one reading resolves to the one this trip
   * means: "Lagos" on a Lisbon + Porto trip is FAO, bare it is LOS.
   */
  tripCityNames?: string[];
};

/**
 * Where compareLeg gets airport codes and flight offers. Defaults to
 * flights.ts. The optimizer passes per-run wrappers instead: a memo of
 * getIataCode (a 5-city run otherwise looks the same 5 cities up hundreds
 * of times) and a searchFlights that counts outcomes, so a run can tell a
 * Duffel outage from routes nobody flies.
 */
export type CompareLegDeps = {
  getIataCode?: (cityName: string, context?: IataLookupContext) => Promise<string>;
  searchFlights?: typeof searchFlights;
};

export async function compareLeg(
  params: CompareLegParams,
  deps: CompareLegDeps = {},
): Promise<LegComparison> {
  const { origin, destination, date, travelers, originCountry, destinationCountry } = params;
  const resolveIata = deps.getIataCode ?? getIataCode;
  const findFlights = deps.searchFlights ?? searchFlights;
  const tripNames = params.tripCityNames ?? [];
  const dependsOnTrip = (name: string): boolean =>
    tripNames.length > 0 &&
    !getStaticIata(name) &&
    resolveDestinationIata(name, { tripDestinationNames: tripNames }) !== resolveDestinationIata(name);

  // Check cache first.
  //
  // `travelers` is part of the key: every cached price is a PARTY TOTAL, so
  // a row written for a 2-person party is simply the wrong number for a
  // 4-person one. Without it the second party silently inherited the first
  // party's bill for this leg for the two hours the row stayed live (the
  // table had no travelers column — see migration 006).
  //
  // Read the NEWEST row per mode rather than "any two rows for this leg".
  // The old query was `.limit(2)` with no ordering, which broke as soon as a
  // leg was searched more than once inside the 2h window: the write below is
  // an insert, not an upsert (leg_price_cache has no unique key to conflict
  // on — see 007_leg_price_cache_unique.sql), so three searches leave three
  // flight + three train rows and an unordered limit(2) can hand back two
  // FLIGHT rows. cachedTrain was then undefined, the expensive rail search
  // ran again, inserted another row, and made the next collision likelier.
  // Unordered also meant a hit could be the OLDEST row still in the window
  // rather than the freshest price.
  //
  // One query per mode is deterministic and indexed
  // (origin, destination, travel_date, mode); both run in parallel.
  // raw_response is deliberately not selected — the cached branches below
  // set `raw: {}` and never read it, and a cached Duffel offer is tens of KB.
  const supabase = getSupabase();
  const readNewestCached = async (mode: 'flight' | 'train') => {
    const { data } = await supabase
      .from('leg_price_cache')
      .select('id, price, duration_minutes, operator')
      .eq('origin', origin.toLowerCase())
      .eq('destination', destination.toLowerCase())
      .eq('travel_date', date)
      .eq('travelers', travelers)
      .eq('mode', mode)
      .gte('expires_at', new Date().toISOString())
      .order('fetched_at', { ascending: false })
      .limit(1);
    return data?.[0];
  };

  // The flight row is keyed by city NAME, but with trip context one name can
  // mean two airports: Porto -> Lagos is OPO -> FAO on a Portugal trip and
  // OPO -> LOS bare. Whichever wrote the row first would be served to the
  // other for two hours — a Portugal trip paying Nigeria's fare, or the
  // reverse. So a leg whose airports this trip changes neither reads nor
  // writes the shared flight row; it is searched every time (the in-process
  // Duffel cache in flights.ts is keyed by airport, so it still dedupes).
  //
  // "Changes" = getIataCode would answer differently with this trip than
  // without: no curated row (those beat context) and the location artifact
  // reads the name differently. In-memory, no network. Not caught: a name
  // the artifact cannot answer either way, where the trip only changes which
  // Duffel suggestion is believed — rare, and no worse than before.
  // Trains are searched by city name, not airport, so their rows are kept.
  const flightCacheUsable = !dependsOnTrip(origin) && !dependsOnTrip(destination);

  // Both airports, looked up alongside the cache reads. A leg whose two
  // cities share an airport — Zurich → Interlaken is ZRH → ZRH, Oxford →
  // London is LON → LON — has NO flight option: it is ground travel. It is
  // not searched, a cached flight row for it is not served (a flight between
  // them cannot exist), and the leg falls to the train, or to "unavailable",
  // which the optimizer already penalises. A failed lookup is not a shared
  // airport: the leg behaves exactly as before (cache, else a logged miss).
  const tripContext = { tripDestinationNames: params.tripCityNames ?? [] };
  const airportsLookup: Promise<[string, string] | { failed: unknown }> = Promise.all([
    resolveIata(origin, tripContext),
    resolveIata(destination, tripContext),
  ]).catch((failed: unknown) => ({ failed }));

  const [cachedFlightRow, cachedTrain, airports] = await Promise.all([
    flightCacheUsable ? readNewestCached('flight') : Promise.resolve(undefined),
    readNewestCached('train'),
    airportsLookup,
  ]);
  const sharedAirport = Array.isArray(airports) && sameAirportArea(airports[0], airports[1]);
  const cachedFlight = sharedAirport ? undefined : cachedFlightRow;

  // Fetch in parallel, catch each independently
  const [flightsResult, trainsResult] = await Promise.all([
    cachedFlight || sharedAirport
      ? Promise.resolve(null) // cached, or no flight can exist
      : (async () => {
          try {
            if (!Array.isArray(airports)) throw airports.failed;
            const [originIata, destIata] = airports;
            return await findFlights({
              origin: originIata,
              destination: destIata,
              date,
              travelers,
            });
          } catch (err) {
            logger.warn('Flight search failed in compareLeg', { origin, destination });
            return null;
          }
        })(),
    cachedTrain
      ? Promise.resolve(null)
      : searchTrains({ origin, destination, date, travelers, originCountry, destinationCountry }).catch(() => []),
  ]);

  // Pick cheapest flight
  let bestFlight: FlightOffer | null = null;
  if (cachedFlight) {
    // Cache doesn't store bookingUrl, so send to Google Flights pre-filled.
    const cachedBookingUrl = `https://www.google.com/travel/flights?q=${encodeURIComponent(
      `Flights to ${destination} from ${origin} on ${date}`,
    )}`;
    bestFlight = {
      id: cachedFlight.id,
      price: cachedFlight.price,
      currency: 'USD',
      departure: '',
      arrival: '',
      durationMinutes: knownDuration(cachedFlight.duration_minutes) ?? 0,
      stops: 0,
      carrier: cachedFlight.operator ?? '',
      carrierCode: '',
      bookingUrl: cachedBookingUrl,
      raw: {},
    };
  } else if (flightsResult && flightsResult.length > 0) {
    bestFlight = flightsResult.reduce((a, b) => (a.price < b.price ? a : b));
  }

  // Pick cheapest train
  let bestTrain: TrainOffer | null = null;
  if (cachedTrain) {
    // Cached prices are already stored in USD as the party total for this
    // exact `travelers` count (converted and scaled by trains.ts before the
    // first cache write; the row is keyed on travelers, so a hit is by
    // definition the right party size). The currency label just follows suit.
    // No rail provider gives us a booking link (see TrainOffer.bookingUrl),
    // so a cached row has none to restore. A Google search labelled "Book"
    // is not a booking link either; leave it null and let the UI say so.
    bestTrain = {
      id: cachedTrain.id,
      price: cachedTrain.price,
      currency: 'USD',
      departure: '',
      arrival: '',
      durationMinutes: knownDuration(cachedTrain.duration_minutes) ?? 0,
      operator: cachedTrain.operator ?? '',
      trainType: '',
      bookingUrl: null,
      limitedCoverage: false,
    };
  } else if (trainsResult && Array.isArray(trainsResult) && trainsResult.length > 0) {
    const withPrice = trainsResult.filter((t) => t.price !== null);
    if (withPrice.length > 0) {
      bestTrain = withPrice.reduce((a, b) => (a.price! < b.price! ? a : b));
    } else {
      bestTrain = trainsResult[0]; // take first even without price
    }
  }

  // Door-to-door times. An unknown duration stays Infinity rather than
  // collapsing to the airport overhead alone — we can't claim a journey is
  // fast when we don't know how long it is, and Infinity keeps it out of
  // both the `fastest` verdict and the within-10% tiebreak below.
  const flightMinutes = bestFlight ? knownDuration(bestFlight.durationMinutes) : null;
  const trainMinutes = bestTrain ? knownDuration(bestTrain.durationMinutes) : null;

  const flightDoorToDoor =
    flightMinutes != null ? flightMinutes + AIRPORT_OVERHEAD_MINUTES : Infinity;
  const trainDoorToDoor = trainMinutes != null ? trainMinutes : Infinity;
  const durationsComparable = flightMinutes != null && trainMinutes != null;

  const flightPrice = bestFlight?.price ?? Infinity;
  const trainPrice = bestTrain?.price ?? Infinity;

  // A train fare of null (no coverage for that operator) becomes Infinity
  // through the `??` above, so the `trainPrice !== null` tests these guards
  // used to carry could never be false — they read as a null check and did
  // nothing. An unpriced option must not be compared on price at all.
  const flightPriced = Number.isFinite(flightPrice);
  const trainPriced = Number.isFinite(trainPrice);

  // Determine cheapest
  let cheapest: LegComparison['cheapest'] = 'unavailable';
  if (bestFlight && bestTrain && trainPriced && flightPriced) {
    if (flightPrice < trainPrice) cheapest = 'flight';
    else if (trainPrice < flightPrice) cheapest = 'train';
    else cheapest = 'same';
  } else if (bestFlight) {
    cheapest = 'flight';
  } else if (bestTrain && trainPrice !== null) {
    cheapest = 'train';
  }

  // Determine fastest
  let fastest: LegComparison['fastest'] = 'unavailable';
  if (bestFlight && bestTrain) {
    // Only rank two real journeys against each other. With a duration
    // missing on either side this stays 'unavailable' — the honest answer,
    // and the UI simply renders no "fastest" badge.
    if (!durationsComparable) fastest = 'unavailable';
    else if (flightDoorToDoor < trainDoorToDoor) fastest = 'flight';
    else if (trainDoorToDoor < flightDoorToDoor) fastest = 'train';
    else fastest = 'same';
  } else if (bestFlight) {
    fastest = 'flight';
  } else if (bestTrain) {
    fastest = 'train';
  }

  // Recommendation logic
  let recommendation: LegComparison['recommendation'] = 'unavailable';
  if (bestFlight && bestTrain && trainPriced && flightPriced) {
    // If train has limited coverage, prefer flight
    if (bestTrain.limitedCoverage) {
      recommendation = 'flight';
    } else {
      // Cheapest wins
      if (cheapest === 'flight') {
        recommendation = 'flight';
      } else if (cheapest === 'train') {
        recommendation = 'train';
      } else {
        // Same price — fastest wins
        recommendation = fastest === 'train' ? 'train' : 'flight';
      }
      // Within 10% price difference — fastest wins
      const priceDiffPct = Math.abs(flightPrice - trainPrice) / Math.min(flightPrice, trainPrice);
      if (priceDiffPct <= 0.1) {
        if (fastest === 'flight') recommendation = 'flight';
        else if (fastest === 'train') recommendation = 'train';
      }
    }
  } else if (bestFlight && flightPriced) {
    recommendation = 'flight';
  } else if (bestTrain) {
    // The only option, priced or not. `limitedCoverage` already tells callers
    // the fare is unknown; what they must not do is turn that into a $0 leg.
    recommendation = 'train';
  } else if (bestFlight) {
    recommendation = 'flight';
  }

  // Cache results (2 hour expiry). One timestamp for the whole write so the
  // supersede-prune below has an exact boundary.
  const fetchedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const cacheRows: any[] = [];
  if (bestFlight && !cachedFlight && flightCacheUsable) {
    cacheRows.push({
      origin: origin.toLowerCase(),
      destination: destination.toLowerCase(),
      travel_date: date,
      travelers,
      mode: 'flight',
      // Party total for exactly `travelers` passengers — Duffel's
      // total_amount covers the whole passenger set.
      price: bestFlight.price,
      // null, not a bogus number: the column is nullable, and a wrong
      // duration served from cache for two hours is worse than none.
      duration_minutes: flightMinutes,
      operator: bestFlight.carrier,
      raw_response: bestFlight.raw,
      fetched_at: fetchedAt,
      expires_at: expiresAt,
    });
  }
  if (bestTrain && !cachedTrain) {
    cacheRows.push({
      origin: origin.toLowerCase(),
      destination: destination.toLowerCase(),
      travel_date: date,
      travelers,
      mode: 'train',
      // Party total for exactly `travelers` passengers — trains.ts scaled
      // the provider's per-person fare before it got here.
      price: bestTrain.price,
      duration_minutes: trainMinutes,
      operator: bestTrain.operator,
      raw_response: {},
      fetched_at: fetchedAt,
      expires_at: expiresAt,
    });
  }

  if (cacheRows.length > 0) {
    try {
      // UPSERT, not insert. 007_leg_price_cache_unique.sql makes
      // (origin, destination, travel_date, mode, travelers) unique, so a plain
      // insert is rejected 23505 the moment a leg is searched again — and the
      // case that bites is an EXPIRED row: the read filters on
      // `expires_at >= now()` and misses it, the providers are queried again,
      // and the fresh price can then never be written because the stale row
      // still occupies the key. The leg's cache would be dead from its first
      // expiry onward. Conflicting on the same key overwrites the stale row
      // in place, which also removes the need for the old prune-after-insert.
      const { error } = await supabase
        .from('leg_price_cache')
        .upsert(cacheRows, { onConflict: 'origin,destination,travel_date,mode,travelers' });
      if (error) {
        // supabase-js reports failures in `error`, it doesn't throw — the old
        // bare try/catch swallowed nothing and told us nothing.
        logger.warn('leg_price_cache upsert failed (non-fatal)', {
          errMessage: error.message,
          origin,
          destination,
        });
      }
    } catch (err: any) {
      logger.warn('leg_price_cache write failed (non-fatal)', {
        errMessage: err?.message,
        origin,
        destination,
      });
    }
  }

  return {
    flightOption: bestFlight,
    trainOption: bestTrain,
    cheapest,
    fastest,
    recommendation,
    // Only a real difference when BOTH sides have a real price. Coercing a
    // missing side to 0 made the "difference" equal the whole of the other
    // fare — an unpriced train made it look like the flight cost that much
    // more than the train, rather than unknown.
    priceDifference: flightPriced && trainPriced ? Math.abs(flightPrice - trainPrice) : 0,
    // 0 when there's nothing real to subtract. Infinity/NaN here used to
    // serialize to JSON `null` against a `number` field on the client.
    timeDifference: durationsComparable
      ? Math.abs(flightDoorToDoor - trainDoorToDoor)
      : 0,
  };
}
