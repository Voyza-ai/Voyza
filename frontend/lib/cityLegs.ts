import type { HomeLeg, Transport, Trip } from './types';

/**
 * Adapt a `HomeLeg` (the home-anchor flight on trip.origin.outboundLeg /
 * returnLeg) into a `Transport`-shaped object so city-leg readers can take it
 * uniformly. The HomeLeg has `originAirport` / `destAirport` IATA codes but no
 * full station strings — we map IATA into `fromStation` / `toStation`.
 */
export const homeLegToTransport = (leg: HomeLeg | null | undefined): Transport | null => {
  if (!leg) return null;
  return {
    mode: 'flight',
    operator: leg.operator ?? '',
    duration: '',
    price: leg.price ?? 0,
    departTime: leg.departTime ?? undefined,
    arriveTime: leg.arriveTime ?? undefined,
    departDate: leg.departDate ?? undefined,
    fromStation: leg.originAirport ?? undefined,
    toStation: leg.destAirport ?? undefined,
  };
};

/**
 * The leg that actually brings the traveller into city `i`. The first city's
 * `transportIn` is an empty placeholder in an assembled trip — the way in is
 * the flight from home on `trip.origin.outboundLeg` — so that wins when set.
 * Everyone else (and legacy trips without a home anchor) reads `transportIn`.
 */
export function effectiveTransportIn(trip: Pick<Trip, 'cities' | 'origin'>, i: number): Transport {
  const city = trip.cities[i];
  if (i === 0) return homeLegToTransport(trip.origin?.outboundLeg) ?? city.transportIn;
  return city.transportIn;
}

/**
 * The leg that takes the traveller out of city `i`. Mirror of
 * `effectiveTransportIn`: the last city's way out is the flight home on
 * `trip.origin.returnLeg` when the trip returns home.
 */
export function effectiveTransportOut(trip: Pick<Trip, 'cities' | 'origin'>, i: number): Transport {
  const city = trip.cities[i];
  if (i === trip.cities.length - 1) return homeLegToTransport(trip.origin?.returnLeg) ?? city.transportOut;
  return city.transportOut;
}
