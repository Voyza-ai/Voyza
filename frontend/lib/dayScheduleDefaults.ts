import { City, Trip, ScheduledEvent, Transport, HomeLeg } from './types';

/**
 * Auto-build the default schedule for a single trip day.
 *
 * Why this lives outside `DayPlanner.tsx`: the modal used to be the only
 * caller, so the function lived inline. With `ScheduleView` and the
 * trip-creation path in `PlanningChat` both needing the same logic, the
 * build was lifted into this module so all three views stay aligned.
 *
 * Travel events the function produces:
 *   - Arrival day  : "Head to {fromStation}" + "{Mode} {from→to}" + "Arrive at {toStation}"
 *   - Departure day: "Head to {fromStation}" + "{Mode} {from→to}"
 * Plus auto-spread activities and lunch/dinner restaurant slots from
 * the city's curated lists.
 *
 * Home-leg awareness: `cities[0].transportIn` and `cities[last].transportOut`
 * are intentionally `emptyTransport` in the assembled trip — the actual
 * home outbound and return flights live on `trip.origin.outboundLeg` and
 * `returnLeg` instead. Without the synthesis below, the very first day's
 * arrival blocks and the very last day's departure blocks would never
 * make it into the schedule.
 */

const BUFFER_MIN: Record<string, number> = {
  flight: 120,
  train: 30,
  bus: 15,
};

/** Cushion (minutes) after arrive time before the user can do
 *  activities — covers immigration, baggage, transit to lodging. */
const POST_ARRIVAL_CUSHION = 60;

/** Strip station/platform suffixes for cleaner one-line titles. */
const shortStation = (s?: string) =>
  s ? s.split(',')[0].split('—')[0].split('–')[0].trim() : '';

const timeToMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

const minutesToTime = (mins: number): string => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

let _idCounter = 0;
const newId = () => `evt-${Date.now()}-${++_idCounter}`;

/**
 * Adapt a `HomeLeg` (the home-anchor flight shape) into a `Transport`-
 * shaped object so the rest of `buildDefaultSchedule` can read it
 * uniformly. The HomeLeg has `originAirport` / `destAirport` IATA codes
 * but no full station strings — we map IATA into `fromStation` /
 * `toStation` so the "Head to {airport}" titles still read sensibly.
 */
const homeLegToTransport = (leg: HomeLeg | null | undefined): Transport | null => {
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
 * Per-day result of resolving a city's transport context.
 *
 * `events`           transport blocks that should appear on this day's schedule
 *                    (head-to / flight / arrive-at, depending on whether the
 *                    day is an arrival, departure, or both).
 * `windowStart`      earliest minute (since midnight) at which an activity or
 *                    restaurant can start. After arrive time + cushion on
 *                    arrival days; 0 otherwise. Caller clamps slot start to
 *                    this so a Florence breakfast at 8 AM doesn't get
 *                    scheduled on a day the user lands in Florence at 10 PM.
 * `windowEnd`        latest minute. Before depart time minus mode buffer on
 *                    departure days; 24*60 otherwise. Caller clamps slot end
 *                    to this so a 7 PM dinner doesn't get scheduled on a
 *                    day the user heads to the airport at 4 PM.
 */
export type DayTransportContext = {
  events: ScheduledEvent[];
  windowStart: number;
  windowEnd: number;
};

/**
 * Resolve the transport-related events and the activity-placement window
 * for a single day. Pure function — caller decides whether to persist
 * `events` and how to place additional activities/restaurants within
 * `[windowStart, windowEnd]`.
 *
 * Used by both `buildDefaultSchedule` (this module) and the trip-creation
 * scheduler in `PlanningChat`. Centralising the home-leg logic here keeps
 * the two paths in sync — adding a new transport-block rule (different
 * buffer, additional block, etc.) only needs one edit.
 */
export function buildDayTransportContext(
  city: City,
  date: string,
  trip: Trip,
  cityIndex: number,
): DayTransportContext {
  const events: ScheduledEvent[] = [];
  let windowStart = 0;
  let windowEnd = 24 * 60;
  const isArrival = city.dates.arrival === date;
  const isDeparture = city.dates.departure === date;
  const lastIndex = trip.cities.length - 1;

  // Resolve the effective inbound transport. For cities[0] (the first
  // destination), the home outbound leg is the one that brought the user
  // here — try that first, fall back to city.transportIn for legacy trips
  // that pre-date the home anchor work.
  let effectiveIn: Transport | null = null;
  if (cityIndex === 0) {
    effectiveIn =
      homeLegToTransport(trip.origin?.outboundLeg) ??
      (city.transportIn?.arriveTime ? city.transportIn : null);
  } else if (city.transportIn?.arriveTime) {
    effectiveIn = city.transportIn;
  }

  // Same for outbound: cities[last] uses the home return leg.
  let effectiveOut: Transport | null = null;
  if (cityIndex === lastIndex) {
    effectiveOut =
      homeLegToTransport(trip.origin?.returnLeg) ??
      (city.transportOut?.departTime ? city.transportOut : null);
  } else if (city.transportOut?.departTime) {
    effectiveOut = city.transportOut;
  }

  // Inbound — three blocks ("Head to" + actual travel + "Arrive at").
  // For inter-city legs the head-to + travel always belong on the arrival
  // day. For an overnight home flight (departDate one day before arrival)
  // those two blocks belong on the home card day (Phase 2) — only the
  // "Arrive at" marker renders here.
  if (isArrival && effectiveIn?.arriveTime) {
    const t = effectiveIn;
    const arrMins = timeToMinutes(t.arriveTime!);
    const departMins = t.departTime ? timeToMinutes(t.departTime) : null;
    const buffer = BUFFER_MIN[t.mode] ?? 60;
    const fromShort =
      shortStation(t.fromStation) || (t.mode === 'flight' ? 'the airport' : 'the station');
    const toShort = shortStation(t.toStation) || city.name;

    // For the home outbound, only render head-to + flight when the
    // departDate is the same day as the arrival. Inter-city legs are
    // always same-day.
    const sameDayDeparture =
      cityIndex === 0
        ? trip.origin?.outboundLeg?.departDate === date
        : true;

    if (sameDayDeparture && departMins !== null) {
      const headStart = Math.max(0, departMins - buffer);
      events.push({
        id: newId(),
        title: `Head to ${fromShort}`,
        startTime: minutesToTime(headStart),
        endTime: minutesToTime(departMins),
        category: 'transport',
        notes: t.mode === 'flight' ? 'Allow 2h for check-in & security' : undefined,
      });
      events.push({
        id: newId(),
        title: `${t.mode === 'flight' ? 'Flight' : t.mode === 'train' ? 'Train' : 'Bus'} ${fromShort} → ${toShort}`,
        startTime: t.departTime!,
        endTime: t.arriveTime!,
        category: 'transport',
        notes: t.duration || undefined,
      });
    }

    events.push({
      id: newId(),
      title: `Arrive at ${toShort}`,
      startTime: t.arriveTime!,
      endTime: minutesToTime(Math.min(arrMins + 15, 24 * 60)),
      category: 'transport',
    });

    // No activities/restaurants until the user has actually landed and
    // cleared the airport.
    windowStart = Math.min(arrMins + POST_ARRIVAL_CUSHION, 24 * 60);
  }

  // Outbound — two blocks ("Head to" + actual travel). Symmetric to the
  // inbound branch above; the home return leg's departDate equals the
  // last city's departure date by construction (the optimizer schedules
  // it that way), so no overnight special-case needed here.
  if (isDeparture && effectiveOut?.departTime) {
    const t = effectiveOut;
    const depMins = timeToMinutes(t.departTime!);
    const buffer = BUFFER_MIN[t.mode] ?? 60;
    const fromShort =
      shortStation(t.fromStation) || (t.mode === 'flight' ? 'the airport' : 'the station');
    const toShort = shortStation(t.toStation) || (t.to ?? 'destination');
    const headStart = Math.max(0, depMins - buffer);

    events.push({
      id: newId(),
      title: `Head to ${fromShort}`,
      startTime: minutesToTime(headStart),
      endTime: t.departTime!,
      category: 'transport',
      notes: t.mode === 'flight' ? 'Allow 2h for check-in & security' : undefined,
    });

    const endTime = t.arriveTime ?? minutesToTime(Math.min(depMins + 60, 24 * 60));
    events.push({
      id: newId(),
      title: `${t.mode === 'flight' ? 'Flight' : t.mode === 'train' ? 'Train' : 'Bus'} ${fromShort} → ${toShort}`,
      startTime: t.departTime!,
      endTime,
      category: 'transport',
      notes: t.duration || undefined,
    });

    // No activities after the user has left for the airport.
    windowEnd = Math.max(0, headStart);
  }

  events.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  return { events, windowStart, windowEnd };
}

/**
 * Lazy-build path: produce a complete day schedule (transport + spread
 * activities + lunch/dinner restaurants) from the city's curated lists.
 * Used by the DayPlanner modal when a day has no schedule yet (legacy
 * trips loaded from DB, or modal opened before PlanningChat's eager
 * scheduler ran). The trip-creation path in `PlanningChat` does NOT use
 * this — it has its own slot-based scheduler — but both paths share
 * `buildDayTransportContext` for the transport portion.
 */
export function buildDefaultSchedule(
  city: City,
  date: string,
  trip: Trip,
  cityIndex: number,
): ScheduledEvent[] {
  const ctx = buildDayTransportContext(city, date, trip, cityIndex);
  const events = [...ctx.events];
  const isArrival = city.dates.arrival === date;
  const isDeparture = city.dates.departure === date;

  // Activity-placement bounds. Default daytime window is 9 AM–9 PM,
  // shrunk by the transport context if the user is arriving or
  // departing on this day.
  const busyRanges = events.map((e) => [
    timeToMinutes(e.startTime),
    timeToMinutes(e.endTime),
  ]);

  let startSlot = Math.max(9 * 60, ctx.windowStart);
  const endSlot = Math.min(21 * 60, ctx.windowEnd);
  const availableMinutes = endSlot - startSlot;

  if (city.activities.length > 0 && availableMinutes > 0) {
    const slotDuration = Math.min(
      90,
      Math.floor(availableMinutes / city.activities.length),
    );
    city.activities.forEach((a) => {
      if (startSlot + slotDuration > endSlot) return;
      const overlaps = busyRanges.some(
        ([bStart, bEnd]) => startSlot < bEnd && startSlot + slotDuration > bStart,
      );
      if (overlaps) {
        const overlap = busyRanges.find(
          ([bStart, bEnd]) => startSlot < bEnd && startSlot + slotDuration > bStart,
        );
        if (overlap) startSlot = overlap[1] + 15;
      }
      if (startSlot + slotDuration > endSlot) return;
      events.push({
        id: newId(),
        title: a,
        startTime: minutesToTime(startSlot),
        endTime: minutesToTime(startSlot + slotDuration),
        category: 'activity',
      });
      startSlot += slotDuration + 15;
    });
  }

  // Restaurants — first into the lunch slot, second into dinner.
  // Skipped if either falls outside the activity window (e.g. dinner at
  // 19:30 on a day with a 17:00 head-to-airport).
  const lunchTime = 12 * 60 + 30;
  const dinnerTime = 19 * 60 + 30;
  city.restaurants.slice(0, 2).forEach((r, i) => {
    const time = i === 0 ? lunchTime : dinnerTime;
    if (time < ctx.windowStart || time + 60 > ctx.windowEnd) return;
    const overlaps = [
      ...events,
      ...busyRanges.map(([s, e]) => ({
        startTime: minutesToTime(s),
        endTime: minutesToTime(e),
      })),
    ].some((ev) => {
      if ('startTime' in ev && typeof ev.startTime === 'string') {
        const eStart = timeToMinutes(ev.startTime);
        const eEnd = timeToMinutes(ev.endTime as string);
        return time < eEnd && time + 60 > eStart;
      }
      return false;
    });
    if (!overlaps) {
      events.push({
        id: newId(),
        title: r.name,
        startTime: minutesToTime(time),
        endTime: minutesToTime(time + 60),
        category: 'restaurant',
        notes: `${r.cuisine} · ${r.priceRange}`,
      });
    }
  });

  events.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  return events;
}
