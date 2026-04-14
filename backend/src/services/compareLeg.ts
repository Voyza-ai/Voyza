import { searchFlights, getIataCode, FlightOffer } from './flights';
import { searchTrains, TrainOffer } from './trains';
import { getSupabase } from './supabase';
import { logger } from '../utils/logger';

export type LegComparison = {
  flightOption: FlightOffer | null;
  trainOption: TrainOffer | null;
  cheapest: 'flight' | 'train' | 'same' | 'unavailable';
  fastest: 'flight' | 'train' | 'same' | 'unavailable';
  recommendation: 'flight' | 'train' | 'unavailable';
  priceDifference: number;
  timeDifference: number;
};

const AIRPORT_OVERHEAD_MINUTES = 180;

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

  // Check cache first
  const supabase = getSupabase();
  const { data: cached } = await supabase
    .from('leg_price_cache')
    .select('*')
    .eq('origin', origin.toLowerCase())
    .eq('destination', destination.toLowerCase())
    .eq('travel_date', date)
    .gte('expires_at', new Date().toISOString())
    .limit(2);

  const cachedFlight = cached?.find((c: any) => c.mode === 'flight');
  const cachedTrain = cached?.find((c: any) => c.mode === 'train');

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
    bestFlight = {
      id: cachedFlight.id,
      price: cachedFlight.price,
      currency: 'USD',
      departure: '',
      arrival: '',
      durationMinutes: cachedFlight.duration_minutes ?? 0,
      stops: 0,
      carrier: cachedFlight.operator ?? '',
      carrierCode: '',
      bookingUrl: '',
      raw: {},
    };
  } else if (flightsResult && flightsResult.length > 0) {
    bestFlight = flightsResult.reduce((a, b) => (a.price < b.price ? a : b));
  }

  // Pick cheapest train
  let bestTrain: TrainOffer | null = null;
  if (cachedTrain) {
    bestTrain = {
      id: cachedTrain.id,
      price: cachedTrain.price,
      currency: 'EUR',
      departure: '',
      arrival: '',
      durationMinutes: cachedTrain.duration_minutes ?? 0,
      operator: cachedTrain.operator ?? '',
      trainType: '',
      bookingUrl: '',
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

  // Door-to-door times
  const flightDoorToDoor = bestFlight
    ? bestFlight.durationMinutes + AIRPORT_OVERHEAD_MINUTES
    : Infinity;
  const trainDoorToDoor = bestTrain ? bestTrain.durationMinutes : Infinity;

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
    if (flightDoorToDoor < trainDoorToDoor) fastest = 'flight';
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

  // Cache results (2 hour expiry)
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const cacheRows: any[] = [];
  if (bestFlight && !cachedFlight) {
    cacheRows.push({
      origin: origin.toLowerCase(),
      destination: destination.toLowerCase(),
      travel_date: date,
      mode: 'flight',
      price: bestFlight.price,
      duration_minutes: bestFlight.durationMinutes,
      operator: bestFlight.carrier,
      raw_response: bestFlight.raw,
      fetched_at: new Date().toISOString(),
      expires_at: expiresAt,
    });
  }
  if (bestTrain && !cachedTrain) {
    cacheRows.push({
      origin: origin.toLowerCase(),
      destination: destination.toLowerCase(),
      travel_date: date,
      mode: 'train',
      price: bestTrain.price,
      duration_minutes: bestTrain.durationMinutes,
      operator: bestTrain.operator,
      raw_response: {},
      fetched_at: new Date().toISOString(),
      expires_at: expiresAt,
    });
  }

  if (cacheRows.length > 0) {
    try { await supabase.from('leg_price_cache').insert(cacheRows); } catch {}
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
    timeDifference: Math.abs(flightDoorToDoor - trainDoorToDoor),
  };
}
