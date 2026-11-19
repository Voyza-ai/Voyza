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

/** "58m", "1h 5m", "9h30m" → minutes; null when it says neither. */
export const durationMinutes = (d: string | undefined): number | null => {
  if (!d) return null;
  const h = /(\d+)\s*h/i.exec(d);
  const m = /(\d+)\s*m(?!o)/i.exec(d);
  if (!h && !m) return null;
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
};

const clockMinutes = (t: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * True when the leg arrives the day AFTER it leaves: an overnight train
 * (Prague 16:36 → Budapest 00:29) or a red-eye. Read off the clock times —
 * legs carry a depart date but no arrive date — so an arrival at an earlier
 * clock time than the departure means the next day, unless the duration says
 * it is the same day in an earlier time zone (Paris 10:50 → London 10:48, a
 * 58m flight). Without a duration, only an arrival 3h+ "earlier" counts.
 */
export function arrivesNextDay(t: Pick<Transport, 'departTime' | 'arriveTime' | 'duration'> | null | undefined): boolean {
  if (!t?.departTime || !t.arriveTime) return false;
  const dep = clockMinutes(t.departTime);
  const arr = clockMinutes(t.arriveTime);
  if (dep === null || arr === null || arr >= dep) return false;
  const dur = durationMinutes(t.duration);
  // No duration: a time-zone hop moves the clock back by a few hours at
  // most (Paris 10:50 → London 10:48), so only a bigger jump is overnight.
  if (dur === null) return dep - arr > 3 * 60;
  return dep + dur >= 24 * 60;
}

/** `iso` (YYYY-MM-DD) plus one calendar day. */
export const nextIsoDay = (iso: string): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
};

/**
 * The day an inter-city leg ARRIVES: its travel day (the arriving city's
 * first date), or the day after for a leg that arrives after midnight. The guide's ARRIVE card used the city's first date
 * for every leg, so an overnight train read "00:29 · Jan 27" for a train that
 * left Prague on the 27th and reached Budapest on the 28th.
 */
export function legArrivalDate(t: Transport | null | undefined, travelDay: string): string {
  // The travel day is the arriving city's first date, not `t.departDate`:
  // a date edit moves the city and can leave the leg's own date behind.
  if (!travelDay || !/^\d{4}-\d{2}-\d{2}$/.test(travelDay)) return travelDay;
  return arrivesNextDay(t) ? nextIsoDay(travelDay) : travelDay;
}
