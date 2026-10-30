import type { Trip } from './types';
import { daysBetween, parseLocal, toIso } from './dateHelpers';

/**
 * The trip's overall span — the day the traveller leaves home to the day the
 * trip ends — as opposed to the first CITY's stay.
 *
 * The two used to be the same date. The optimizer now starts the first stay
 * on the day the outbound flight LANDS (an overnight JFK 19:25 Jan 10 → Paris
 * 12:10 Jan 11 gives Paris Jan 11, one fewer hotel night), which is right for
 * the hotel and the city, and wrong for everything that reads the first
 * city's arrival as "when the trip starts": the results header said
 * "Jan 11 – Jan 17 · 6 nights" for a Jan 10 – 17 trip, right above a home card
 * reading "DEPART Sun, Jan 10", and the schedule lost Jan 10 altogether.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The home-side departure day, when the outbound leaves on an EARLIER day
 * than the first stay begins — the overnight case. On that day the traveller
 * is at home and then in the air: it belongs to the trip, not to the first
 * city.
 *
 * Null when there is no outbound leg, when it leaves the day the first stay
 * starts (a same-day arrival, which every view already handled), or when
 * either date is missing or malformed — so a trip without that day behaves
 * exactly as it did before.
 */
export function homeDepartureDay(trip: Pick<Trip, 'cities' | 'origin'>): string | null {
  const departDate = trip.origin?.outboundLeg?.departDate;
  const firstArrival = trip.cities[0]?.dates?.arrival;
  if (!departDate || !firstArrival) return null;
  if (!ISO_DATE.test(departDate) || !ISO_DATE.test(firstArrival)) return null;
  return departDate < firstArrival ? departDate : null;
}

/** First day of the trip: the home departure day, else the first stay's arrival. */
export function tripStartDate(trip: Pick<Trip, 'cities' | 'origin'>): string | undefined {
  return homeDepartureDay(trip) ?? trip.cities[0]?.dates?.arrival;
}

/** `iso` moved by `days` calendar days (YYYY-MM-DD in, YYYY-MM-DD out). */
export function addDaysIso(iso: string, days: number): string {
  const d = parseLocal(iso);
  d.setDate(d.getDate() + days);
  return toIso(d);
}

/** Calendar days from `a` to `b` (both YYYY-MM-DD); negative when b < a. */
export function daysFrom(a: string, b: string): number {
  return daysBetween(parseLocal(a), parseLocal(b));
}

/**
 * What an outbound search needs to keep the landing rule: the day the trip
 * LEAVES home, and the first stay's departure so the answer can say when the
 * stay starts (`firstCityArrival` from /api/flights/home-legs).
 *
 * The search date is the trip's start, not the first stay's arrival: on an
 * overnight trip those differ by a day, and searching from the arrival — what
 * every re-search did — priced a flight leaving the day the traveller should
 * already be landing (JFK Jan 11 for a trip that leaves Jan 10).
 */
export function outboundSearchDates(
  trip: Pick<Trip, 'cities' | 'origin'>,
): { startDate: string; firstCityDeparture: string | undefined } | null {
  const startDate = tripStartDate(trip);
  if (!startDate) return null;
  return { startDate, firstCityDeparture: trip.cities[0]?.dates?.departure || undefined };
}

/**
 * The day the first stay starts when the outbound lands on `landed`.
 *
 * This is the backend's rule (services/optimizer.ts `firstStayArrival`, also
 * behind /api/flights/home-legs' `firstCityArrival`) for the one case the
 * client decides without a search: the traveller picks another of the
 * outbound's listed alternatives, and the leg's own `arriveDate` is all
 * there is to go on. Everything that searches a flight takes the server's
 * answer instead. Same cases, same results — see landingRule.test.ts:
 *   - the stay starts the day the flight lands;
 *   - never before the trip leaves (`startDate`): a westbound landing that
 *     reads earlier keeps the start date;
 *   - never on or after the stay's own departure: the stay keeps at least
 *     one night;
 *   - no landing date known → the start date.
 */
export function firstStayArrival(params: {
  startDate: string;
  firstDeparture: string;
  landed: string | null | undefined;
}): string {
  const { startDate, firstDeparture, landed } = params;
  if (!landed || !ISO_DATE.test(landed)) return startDate;
  const latestArrival = addDaysIso(firstDeparture, -1);
  const arrival = landed < startDate ? startDate : landed > latestArrival ? latestArrival : landed;
  return arrival < startDate ? startDate : arrival;
}

/**
 * Start, end and night count of the whole trip. The end is the last stay's
 * departure, as it always was; only the start moves, and only for an
 * overnight outbound. `nights` is 0 when either end is unknown.
 */
export function tripSpan(trip: Pick<Trip, 'cities' | 'origin'>): {
  start: string | undefined;
  end: string | undefined;
  nights: number;
} {
  const start = tripStartDate(trip);
  const end = trip.cities[trip.cities.length - 1]?.dates?.departure;
  const nights = start && end ? daysBetween(parseLocal(start), parseLocal(end)) : 0;
  return { start, end, nights };
}
