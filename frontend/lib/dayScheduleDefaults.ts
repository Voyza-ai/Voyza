import { City, Trip, ScheduledEvent, Transport, HomeLeg, UnscheduledItem } from './types';
import { parseLocal, toIso } from './dateHelpers';
// `import type` only — keeps the fetch layer in lib/api out of this
// module's runtime graph while still typing the AI's suggestion shapes.
import type { ActivitySuggestion, RestaurantSuggestion } from './api';

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

/* ──────────────────────────── Day planning ──────────────────────────── */

/**
 * The day planner.
 *
 * Why this replaced the fixed-slot scheduler
 * ------------------------------------------
 * The day used to be cut into fixed boxes (morning 10:00-12:00,
 * afternoon 14:15-18:30, …) and anything longer than its box was
 * truncated to fit: a 4-hour activity rendered as a 2-hour block. The
 * boxes existed because meals were pinned to exact clock times
 * (lunch 12:30, dinner 19:30), so the morning box HAD to stop at 12:00
 * or a long activity would collide with lunch.
 *
 * That is backwards. An activity's length is a fact about the world and
 * the calendar must not quietly contradict it — a user planning against
 * the calendar would read 2 hours and book their day around it. A meal
 * time, by contrast, is a preference: nobody minds lunch at 13:15.
 *
 * So the planner inverts the two. Activities are laid down in order at
 * their real length, and meals are fitted into the gaps the activities
 * leave, anywhere inside a window (lunch 11:30-14:30, dinner 18:00-21:00).
 * Nothing is ever shortened. When the day genuinely cannot hold an item,
 * the item is dropped WHOLE and reported in `dropped`, so the caller can
 * defer it to another day or tell the user — never shrunk in silence.
 */

/** Minutes of breathing room left between two consecutive events. */
export const SLOT_BUFFER_MIN = 15;

/** Shortest block worth putting on the calendar. */
export const MIN_PLACEABLE_MIN = 30;

/** Earliest minute the planner will place a non-transport block. */
export const DAY_OPEN_MIN = 8 * 60; // 08:00

/** Latest minute the planner will place a non-transport block. */
export const DAY_CLOSE_MIN = 23 * 60 + 30; // 23:30

/**
 * Meal windows. A meal must land entirely inside its window but may sit
 * anywhere in it, which is what lets a long activity keep its real
 * length without costing the day its lunch.
 *
 * `ideal` is only a preference — the planner picks the free minute
 * nearest it, so an undisturbed day still reads 08:00 / 12:30 / 19:00.
 */
export const MEAL_WINDOWS = {
  breakfast: { open: 7 * 60, ideal: 8 * 60, close: 10 * 60 },
  lunch: { open: 11 * 60 + 30, ideal: 12 * 60 + 30, close: 14 * 60 + 30 },
  dinner: { open: 18 * 60, ideal: 19 * 60, close: 21 * 60 },
} as const;

/**
 * How long a sit-down meal takes. Unchanged from the fixed-slot
 * scheduler, which used the same 45 / 90 / 120.
 */
export const MEAL_DURATION_MIN = {
  breakfast: 45,
  lunch: 90,
  dinner: 120,
} as const;

/** Earliest a time-of-day activity may start. A floor, never a ceiling. */
export const ACTIVITY_EARLIEST_MIN = {
  morning: 9 * 60, // 09:00
  afternoon: 12 * 60, // 12:00
  evening: 17 * 60, // 17:00
} as const;

/**
 * Assumed length when a suggestion arrives without a `durationHours`.
 * Same numbers the fixed-slot scheduler defaulted to, so a suggestion
 * with no stated duration is not silently demoted to the 30-minute floor.
 */
export const ACTIVITY_FALLBACK_MIN = {
  morning: 2 * 60,
  afternoon: 3 * 60,
  evening: 2 * 60,
} as const;

/** One thing the planner is asked to place. Its duration is never reduced. */
export type PlanItem = {
  /** Caller's handle; echoed back on the placement or the drop. */
  key: string;
  /** Minutes the item really needs. */
  durationMin: number;
  /** Earliest minute it may start. */
  earliestStart: number;
  /** Latest minute it may end. */
  latestEnd: number;
  /** Preferred start for a flexible item. Ignored for a sequence item. */
  idealStart?: number;
};

export type PlanPlacement = {
  key: string;
  startMin: number;
  endMin: number;
  /** Always `endMin - startMin`. Kept so callers need no arithmetic. */
  durationMin: number;
};

/** An item the day could not hold at its real length. */
export type PlanDrop = { key: string; durationMin: number };

export type DayPlan = {
  /** Sorted by start time. */
  placements: PlanPlacement[];
  dropped: PlanDrop[];
};

type Range = [number, number];

/** Collapse overlapping ranges into disjoint ones, sorted by start. */
const mergeRanges = (ranges: Range[]): Range[] => {
  const sorted = ranges.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
};

/**
 * Free spans inside `[from, until]`.
 *
 * Every occupied block is widened by `SLOT_BUFFER_MIN` on both sides, so
 * anything that fits in a returned gap automatically keeps its travel-time
 * cushion from its neighbours — that is how the buffer survives the move
 * away from fixed slots.
 */
const freeGaps = (occupied: Range[], from: number, until: number): Range[] => {
  const blocked = mergeRanges(
    occupied.map(([s, e]): Range => [s - SLOT_BUFFER_MIN, e + SLOT_BUFFER_MIN]),
  );
  const gaps: Range[] = [];
  let cursor = from;
  for (const [bs, be] of blocked) {
    if (be <= cursor) continue;
    if (bs >= until) break;
    if (bs > cursor) gaps.push([cursor, bs]);
    cursor = be;
    if (cursor >= until) break;
  }
  if (cursor < until) gaps.push([cursor, until]);
  return gaps
    .map(([s, e]): Range => [s, Math.min(e, until)])
    .filter(([s, e]) => e > s);
};

/** Earliest minute at or after `from` where `dur` fits whole. */
const earliestFit = (
  occupied: Range[],
  from: number,
  until: number,
  dur: number,
): number | null => {
  for (const [gs, ge] of freeGaps(occupied, from, until)) {
    if (ge - gs >= dur) return gs;
  }
  return null;
};

/** Free minute closest to `ideal` where `dur` fits whole. */
const nearestFit = (
  occupied: Range[],
  from: number,
  until: number,
  dur: number,
  ideal: number,
): number | null => {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const [gs, ge] of freeGaps(occupied, from, until)) {
    if (ge - gs < dur) continue;
    const start = Math.min(Math.max(ideal, gs), ge - dur);
    const distance = Math.abs(start - ideal);
    if (distance < bestDistance) {
      best = start;
      bestDistance = distance;
    }
  }
  return best;
};

/**
 * Normalise a requested duration: round it, floor it at
 * `MIN_PLACEABLE_MIN`, and treat a missing or non-numeric value as the
 * floor rather than letting `NaN` poison the arithmetic.
 */
export const plannedDuration = (desiredMin: number | undefined): number =>
  Math.max(
    MIN_PLACEABLE_MIN,
    Number.isFinite(desiredMin) ? Math.round(desiredMin as number) : MIN_PLACEABLE_MIN,
  );

/**
 * Lay out one day.
 *
 * `sequence` items are placed first and in the given order, each as early
 * as it can honestly go — they define the day's backbone. `flexible`
 * items (the meals) are then fitted into whatever gaps are left, nearest
 * their ideal time.
 *
 * The one piece of lookahead: while placing a sequence item, the planner
 * will slide it later if an earlier start would leave a still-unplaced
 * meal with nowhere to go. It slides, it never shrinks — and it gives up
 * sliding rather than dropping the item, so the rule is:
 *
 *   a meal decides WHEN an activity happens, never WHETHER it happens.
 *
 * The slide scans minute by minute, which is cheap: a day is 1440
 * minutes and this runs once per city-day at trip-build time.
 */
export function planDay(params: {
  /** Earliest minute anything may start (already clamped to the day's window). */
  dayStart: number;
  /** Latest minute anything may end. */
  dayEnd: number;
  /** Immovable blocks — transport, mostly. */
  busyRanges: Range[];
  /** The day's backbone, in order. Never shortened. */
  sequence: PlanItem[];
  /** Window-bound items fitted around the backbone. Never shortened. */
  flexible: PlanItem[];
}): DayPlan {
  const { dayStart, dayEnd, busyRanges, sequence, flexible } = params;

  const placements: PlanPlacement[] = [];
  const dropped: PlanDrop[] = [];
  // A block that ends before it starts wraps midnight — an overnight flight
  // or train rendered as "19:25–12:00". It occupies the rest of THIS day.
  // `mergeRanges` drops any range with end <= start, so passing it through
  // as-is made the flight invisible: the planner put a 3-hour evening
  // activity at 19:40 on the day of a 19:25 departure (production trip,
  // JFK → Paris, 2026-10-29).
  const occupied: Range[] = busyRanges.map(([s, e]): Range => [s, e < s ? 24 * 60 : e]);

  const bounds = (item: PlanItem): Range => [
    Math.max(dayStart, item.earliestStart),
    Math.min(dayEnd, item.latestEnd),
  ];

  /**
   * Which flexible items would still find a home against `probe`.
   * Simulated in window order, because seating breakfast can be what
   * leaves lunch nowhere to sit.
   */
  const survivingFlexible = (probe: Range[]): string[] => {
    const sim: Range[] = probe.map(([s, e]): Range => [s, e]);
    const alive: string[] = [];
    for (const item of flexible) {
      const [from, until] = bounds(item);
      const hit = nearestFit(sim, from, until, item.durationMin, item.idealStart ?? from);
      if (hit !== null) {
        alive.push(item.key);
        sim.push([hit, hit + item.durationMin]);
      }
    }
    return alive;
  };

  let cursor: number | null = null;

  for (const item of sequence) {
    const [itemFrom, until] = bounds(item);
    const from = cursor === null ? itemFrom : Math.max(itemFrom, cursor + SLOT_BUFFER_MIN);
    const dur = item.durationMin;

    const plainFit = earliestFit(occupied, from, until, dur);
    let chosen = plainFit;

    if (plainFit !== null) {
      // Meals the day could seat if this item were not placed at all.
      const before = survivingFlexible(occupied);
      let scan: number | null = plainFit;
      while (scan !== null) {
        const after = survivingFlexible([...occupied, [scan, scan + dur] as Range]);
        const starves = before.some((key) => after.indexOf(key) === -1);
        if (!starves) {
          chosen = scan;
          break;
        }
        scan = earliestFit(occupied, scan + 1, until, dur);
      }
      // scan === null → no start spares every meal. Keep `plainFit`: the
      // activity is real and keeps its length; a meal gives way and is
      // reported as dropped below.
    }

    if (chosen === null) {
      dropped.push({ key: item.key, durationMin: dur });
      continue;
    }

    const end = chosen + dur;
    placements.push({ key: item.key, startMin: chosen, endMin: end, durationMin: dur });
    occupied.push([chosen, end]);
    cursor = end;
  }

  for (const item of flexible) {
    const [from, until] = bounds(item);
    const start = nearestFit(occupied, from, until, item.durationMin, item.idealStart ?? from);
    if (start === null) {
      dropped.push({ key: item.key, durationMin: item.durationMin });
      continue;
    }
    const end = start + item.durationMin;
    placements.push({ key: item.key, startMin: start, endMin: end, durationMin: item.durationMin });
    occupied.push([start, end]);
  }

  placements.sort((a, b) => a.startMin - b.startMin);
  return { placements, dropped };
}

/** Nominal length of a curated activity, which carries no duration of its own. */
export const DEFAULT_ACTIVITY_MIN = 90;

/** Nominal length of a curated restaurant visit. */
export const DEFAULT_RESTAURANT_MIN = 60;

/**
 * Lazy-build path: produce a complete day schedule (transport + spread
 * activities + lunch/dinner restaurants) from the city's curated lists.
 * Used by the DayPlanner modal when a day has no schedule yet (legacy
 * trips loaded from DB, or modal opened before PlanningChat's eager
 * scheduler ran).
 *
 * `city.activities` are bare strings with no stated duration, so each one
 * gets `DEFAULT_ACTIVITY_MIN`. It used to get `availableMinutes / count`
 * instead, which silently shrank every block on a busy day; now a day
 * that cannot hold them all places as many as fit, whole, and leaves the
 * rest off rather than squeezing. The two restaurants go into the lunch
 * and dinner WINDOWS instead of the old hard-coded 12:30 / 19:30, which
 * is what used to make a meal vanish whenever an activity happened to
 * cover that one minute.
 */
export function buildDefaultSchedule(
  city: City,
  date: string,
  trip: Trip,
  cityIndex: number,
): ScheduledEvent[] {
  const ctx = buildDayTransportContext(city, date, trip, cityIndex);
  const events = [...ctx.events];

  const dayStart = Math.max(DAY_OPEN_MIN, ctx.windowStart);
  const dayEnd = Math.min(DAY_CLOSE_MIN, ctx.windowEnd);
  const busyRanges = ctx.events.map(
    (e): [number, number] => [timeToMinutes(e.startTime), timeToMinutes(e.endTime)],
  );

  const makers = new Map<string, (startMin: number, endMin: number) => ScheduledEvent>();

  // Curated activities keep the 09:00–21:00 daytime window this path has
  // always used; only the truncation is gone.
  const activityOpen = Math.max(dayStart, 9 * 60);
  const activityClose = Math.min(dayEnd, 21 * 60);

  const sequence: PlanItem[] = city.activities.map((a, i) => {
    const key = `activity-${i}`;
    makers.set(key, (startMin, endMin) => ({
      id: newId(),
      title: a,
      startTime: minutesToTime(startMin),
      endTime: minutesToTime(endMin),
      category: 'activity',
    }));
    return {
      key,
      durationMin: DEFAULT_ACTIVITY_MIN,
      earliestStart: activityOpen,
      latestEnd: activityClose,
    };
  });

  // First curated restaurant is lunch, second is dinner — same intent as
  // before, but each now lands anywhere inside its window.
  const mealWindows = [MEAL_WINDOWS.lunch, MEAL_WINDOWS.dinner];
  const flexible: PlanItem[] = city.restaurants.slice(0, 2).map((r, i) => {
    const key = `restaurant-${i}`;
    const window = mealWindows[i];
    makers.set(key, (startMin, endMin) => ({
      id: newId(),
      title: r.name,
      startTime: minutesToTime(startMin),
      endTime: minutesToTime(endMin),
      category: 'restaurant',
      notes: `${r.cuisine} · ${r.priceRange}`,
    }));
    return {
      key,
      durationMin: DEFAULT_RESTAURANT_MIN,
      earliestStart: window.open,
      latestEnd: window.close,
      idealStart: window.ideal,
    };
  });

  const plan = planDay({ dayStart, dayEnd, busyRanges, sequence, flexible });

  for (const placement of plan.placements) {
    const make = makers.get(placement.key);
    if (!make) continue;
    events.push({
      ...make(placement.startMin, placement.endMin),
      plannedDurationMin: placement.durationMin,
    });
  }

  events.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  return events;
}

/* ────────────────── Trip-creation path (AI suggestions) ────────────────── */

/** What `buildCityScheduleFromSuggestions` produces for one city stay. */
export type CitySchedule = {
  /** Per-day events, keyed by ISO date. Same shape `City.schedule` holds. */
  schedule: Record<string, ScheduledEvent[]>;
  /**
   * Items that were tried on at least one day of the stay and never fit
   * at their real length. Empty when everything landed. Surplus
   * suggestions the stay simply had no day for are NOT listed here —
   * only things the planner actually had to turn away.
   */
  unscheduled: UnscheduledItem[];
};

/**
 * Spread AI-picked activities AND restaurants across the days of a city
 * stay. Each day gets up to one morning / afternoon / evening activity
 * plus breakfast / lunch / dinner, consumed from queues as the days
 * advance so the full list is spread across the whole stay.
 *
 * Lifted out of `PlanningChat` (it was a component closure and so could
 * not be tested) — it never touched component state, only its arguments.
 *
 * Every activity is scheduled at the duration the AI gave it. When a day
 * cannot hold one, the activity is NOT shortened: it goes back on its
 * queue for a later day, and if no day of the stay can take it, it is
 * reported in `unscheduled`. Same for a meal the day had no room for.
 */
export function buildCityScheduleFromSuggestions(
  activities: ActivitySuggestion[],
  restaurants: RestaurantSuggestion[],
  city: City,
  cityIndex: number,
  trip: Trip,
): CitySchedule {
  const schedule: Record<string, ScheduledEvent[]> = {};

  // parseLocal avoids the UTC-vs-local-midnight off-by-one that bare
  // `new Date('YYYY-MM-DD')` produces in west-of-UTC timezones.
  const arrival = parseLocal(city.dates.arrival);
  const departure = parseLocal(city.dates.departure);
  const stayDays = Math.max(
    1,
    Math.ceil((departure.getTime() - arrival.getTime()) / (1000 * 60 * 60 * 24)),
  );
  // The fly-home day (cities[last].departure) doesn't belong to any
  // city's stay, but the home-return transport blocks need to live
  // somewhere — extend the loop by one day for the last city so its
  // schedule covers that final morning.
  const isLastCity = cityIndex === trip.cities.length - 1;
  const dayCount = isLastCity ? stayDays + 1 : stayDays;

  type ActBucket = 'morning' | 'afternoon' | 'evening';
  const actBuckets: Record<ActBucket, ActivitySuggestion[]> = {
    morning: activities.filter((s) => s.timeOfDay === 'morning'),
    afternoon: activities.filter((s) => s.timeOfDay === 'afternoon'),
    evening: activities.filter((s) => s.timeOfDay === 'evening'),
  };

  type RestBucket = 'breakfast' | 'lunch' | 'dinner' | 'any';
  const restBuckets: Record<RestBucket, RestaurantSuggestion[]> = {
    breakfast: restaurants.filter((r) => r.mealType === 'breakfast'),
    lunch: restaurants.filter((r) => r.mealType === 'lunch'),
    dinner: restaurants.filter((r) => r.mealType === 'dinner'),
    any: restaurants.filter((r) => r.mealType === 'any'),
  };

  const takeRestaurant = (
    preferred: Exclude<RestBucket, 'any'>,
  ): { suggestion: RestaurantSuggestion; bucket: RestBucket } | undefined => {
    const fromPreferred = restBuckets[preferred].shift();
    if (fromPreferred) return { suggestion: fromPreferred, bucket: preferred };
    const fromAny = restBuckets.any.shift();
    if (fromAny) return { suggestion: fromAny, bucket: 'any' };
    return undefined;
  };

  /**
   * Items turned away on some day, keyed so a later day that DOES seat
   * the item can clear the entry. What's left at the end is the honest
   * "this stay could not hold these" list.
   */
  const turnedAway: Array<{ key: string; item: UnscheduledItem }> = [];
  const awayKey = (kind: UnscheduledItem['kind'], title: string) => `${kind}:${title}`;
  const clearTurnedAway = (key: string) => {
    const at = turnedAway.findIndex((entry) => entry.key === key);
    if (at >= 0) turnedAway.splice(at, 1);
  };

  let idCounter = 0;

  for (let dayIdx = 0; dayIdx < dayCount; dayIdx++) {
    const dayDate = new Date(arrival);
    dayDate.setDate(dayDate.getDate() + dayIdx);
    // Local-time ISO (toIso) so the home-return day lands on the actual
    // calendar date the user departs, regardless of timezone.
    const dateKey = toIso(dayDate);

    // Transport is the hard constraint — flights can't move — so it is
    // resolved first and everything else is planned around it.
    const transportCtx = buildDayTransportContext(city, dateKey, trip, cityIndex);
    const events: ScheduledEvent[] = [...transportCtx.events];

    const dayStart = Math.max(DAY_OPEN_MIN, transportCtx.windowStart);
    const dayEnd = Math.min(DAY_CLOSE_MIN, transportCtx.windowEnd);
    const busyRanges = transportCtx.events.map(
      (e): [number, number] => [timeToMinutes(e.startTime), timeToMinutes(e.endTime)],
    );

    const makers = new Map<string, (startMin: number, endMin: number) => ScheduledEvent>();
    /** Everything handed to the planner this day, so drops can be put back. */
    const offered = new Map<
      string,
      | { kind: 'activity'; suggestion: ActivitySuggestion; bucket: ActBucket }
      | { kind: 'restaurant'; suggestion: RestaurantSuggestion; bucket: RestBucket }
    >();

    const sequence: PlanItem[] = [];
    const flexible: PlanItem[] = [];

    // ── The day's backbone: one activity per time-of-day, in order.
    (['morning', 'afternoon', 'evening'] as const).forEach((bucket) => {
      const suggestion = actBuckets[bucket].shift();
      if (!suggestion) return;
      const key = `${bucket}-activity`;
      offered.set(key, { kind: 'activity', suggestion, bucket });
      makers.set(key, (startMin, endMin) => ({
        id: `sched-${++idCounter}`,
        title: suggestion.name,
        startTime: minutesToTime(startMin),
        endTime: minutesToTime(endMin),
        category:
          suggestion.category === 'food' || suggestion.category === 'nightlife'
            ? 'restaurant'
            : 'activity',
        notes: suggestion.reason,
      }));
      sequence.push({
        key,
        durationMin: Number.isFinite(suggestion.durationHours)
          ? plannedDuration(suggestion.durationHours * 60)
          : ACTIVITY_FALLBACK_MIN[bucket],
        earliestStart: ACTIVITY_EARLIEST_MIN[bucket],
        latestEnd: dayEnd,
      });
    });

    // ── Meals, fitted into whatever gaps the backbone leaves.
    (['breakfast', 'lunch', 'dinner'] as const).forEach((meal) => {
      const taken = takeRestaurant(meal);
      if (!taken) return;
      const { suggestion, bucket } = taken;
      const key = `${meal}-restaurant`;
      const window = MEAL_WINDOWS[meal];
      offered.set(key, { kind: 'restaurant', suggestion, bucket });
      makers.set(key, (startMin, endMin) => ({
        id: `sched-${++idCounter}`,
        title: `${suggestion.name} (${suggestion.cuisine})`,
        startTime: minutesToTime(startMin),
        endTime: minutesToTime(endMin),
        category: 'restaurant',
        notes: `${suggestion.priceRange} · ${suggestion.reason}`,
      }));
      flexible.push({
        key,
        durationMin: MEAL_DURATION_MIN[meal],
        earliestStart: window.open,
        latestEnd: window.close,
        idealStart: window.ideal,
      });
    });

    const plan = planDay({ dayStart, dayEnd, busyRanges, sequence, flexible });

    for (const placement of plan.placements) {
      const make = makers.get(placement.key);
      if (!make) continue;
      events.push({
        ...make(placement.startMin, placement.endMin),
        plannedDurationMin: placement.durationMin,
      });
      const item = offered.get(placement.key);
      if (item) clearTurnedAway(awayKey(item.kind, item.suggestion.name));
    }

    for (const drop of plan.dropped) {
      const item = offered.get(drop.key);
      if (!item) continue;
      // Back on the END of its queue, so a roomier day can still take it
      // and one oversized item can't block its queue for the whole stay.
      if (item.kind === 'activity') actBuckets[item.bucket].push(item.suggestion);
      else restBuckets[item.bucket].push(item.suggestion);
      const key = awayKey(item.kind, item.suggestion.name);
      clearTurnedAway(key);
      turnedAway.push({
        key,
        item: {
          title: item.suggestion.name,
          kind: item.kind,
          durationMin: drop.durationMin,
          // The most recent day it was tried on.
          date: dateKey,
        },
      });
    }

    // Sort once at the end so transport blocks interleave correctly.
    events.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

    if (events.length > 0) schedule[dateKey] = events;
  }

  return { schedule, unscheduled: turnedAway.map((entry) => entry.item) };
}
