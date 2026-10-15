import { searchFlights, getIataCode, FlightOffer } from './flights';
import { searchTrains, TrainOffer } from './trains';
import { getSupabase } from './supabase';
import { logger } from '../utils/logger';

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

type CompareLegParams = {
  origin: string;
  destination: string;
  date: string;
  travelers: number;
  originCountry?: string;
  destinationCountry?: string;
};

export async function compareLeg(params: CompareLegParams): Promise<LegComparison> {
  const { origin, destination, date, travelers, originCountry, destinationCountry } = params;

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

  const [cachedFlight, cachedTrain] = await Promise.all([
    readNewestCached('flight'),
    readNewestCached('train'),
  ]);

  // Fetch in parallel, catch each independently
  const [flightsResult, trainsResult] = await Promise.all([
    cachedFlight
      ? Promise.resolve(null) // skip if cached
      : (async () => {
          try {
            const [originIata, destIata] = await Promise.all([
              getIataCode(origin),
              getIataCode(destination),
            ]);
            return await searchFlights({
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

  // Determine cheapest
  let cheapest: LegComparison['cheapest'] = 'unavailable';
  if (bestFlight && bestTrain && trainPrice !== null) {
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
  if (bestFlight && bestTrain && trainPrice !== null) {
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
  } else if (bestFlight) {
    recommendation = 'flight';
  } else if (bestTrain && trainPrice !== null) {
    recommendation = 'train';
  }

  // Cache results (2 hour expiry). One timestamp for the whole write so the
  // supersede-prune below has an exact boundary.
  const fetchedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const cacheRows: any[] = [];
  if (bestFlight && !cachedFlight) {
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
    priceDifference: Math.abs(
      (bestFlight?.price ?? 0) - (bestTrain?.price ?? 0),
    ),
    // 0 when there's nothing real to subtract. Infinity/NaN here used to
    // serialize to JSON `null` against a `number` field on the client.
    timeDifference: durationsComparable
      ? Math.abs(flightDoorToDoor - trainDoorToDoor)
      : 0,
  };
}
