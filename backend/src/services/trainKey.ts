/**
 * searchTrains' cache key (trains.ts): one route, day, party and country
 * pair. Both rail providers resolve city names case-insensitively, so they
 * are normalised into the key — otherwise "Rome" and "rome" each pay for
 * their own search. The optimizer's per-run rail memo (optimizer.ts RunRail)
 * keys on the same thing.
 *
 * Its own module so the optimizer can key on it while tests replace trains.ts.
 */
export function trainSearchKey(params: {
  origin: string;
  destination: string;
  date: string;
  travelers: number;
  originCountry?: string;
  destinationCountry?: string;
}): string {
  return [
    params.origin.toLowerCase(),
    params.destination.toLowerCase(),
    params.date,
    params.travelers,
    params.originCountry ?? '',
    params.destinationCountry ?? '',
  ].join('|');
}
