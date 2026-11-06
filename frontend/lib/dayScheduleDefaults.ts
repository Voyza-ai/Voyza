import { City, Trip, ScheduledEvent, Transport, HomeLeg, UnscheduledItem } from './types';
import { parseLocal, toIso } from './dateHelpers';
import { homeDepartureDay } from './tripSpan';
// `import type` only — keeps the fetch layer in lib/api out of this
// module's runtime graph while still typing the AI's suggestion shapes.
import type { ActivitySuggestion, RestaurantSuggestion } from './api';
import { coordsOf, hasCoords, nearestIndex, travelBetween, type Located, type TravelLegs } from './geoSchedule';

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
  /**
   * True on the HOME departure day of an overnight outbound — the day the
   * traveller leaves home, before the first stay begins. `events` is the
   * home side of the trip (head to the airport, the flight) and nothing may
   * be planned around it: the traveller is not in the city yet.
   */
  homeSideOnly?: true;
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

  // The home departure day of an overnight outbound (JFK 19:25 Jan 10 →
  // Paris 12:10 Jan 11). The first stay starts the day the flight LANDS, so
  // this day is before it: the traveller heads to the airport and boards, and
  // that is all. Same two blocks, with the same titles and times, that the
  // same-day branch below renders — the "Arrive at" marker stays on the
  // landing day.
  if (cityIndex === 0 && date === homeDepartureDay(trip)) {
    const t = homeLegToTransport(trip.origin?.outboundLeg);
    if (t?.departTime) {
      const departMins = timeToMinutes(t.departTime);
      const fromShort = shortStation(t.fromStation) || 'the airport';
      const toShort = shortStation(t.toStation) || city.name;
      events.push({
        id: newId(),
        title: `Head to ${fromShort}`,
        startTime: minutesToTime(Math.max(0, departMins - (BUFFER_MIN[t.mode] ?? 60))),
        endTime: minutesToTime(departMins),
        category: 'transport',
        notes: 'Allow 2h for check-in & security',
      });
      events.push({
        id: newId(),
        title: `Flight ${fromShort} → ${toShort}`,
        startTime: t.departTime,
        endTime: t.arriveTime ?? minutesToTime(Math.min(departMins + 60, 24 * 60)),
        category: 'transport',
        notes: t.duration || undefined,
      });
    }
    return { events: tagAuto(events), windowStart: 24 * 60, windowEnd: 0, homeSideOnly: true };
  }

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
  return { events: tagAuto(events), windowStart, windowEnd };
}

/**
 * Fingerprint of a day's generated travel blocks. Everything in them is a
 * pure function of the transport behind the day, so the blocks themselves
 * are the cheapest faithful signature of "which flight/train this was".
 */
export function transportSignature(events: Pick<ScheduledEvent, 'title' | 'startTime' | 'endTime'>[]): string {
  return events.map((e) => `${e.title}|${e.startTime}|${e.endTime}`).join(';');
}

function tagAuto(events: ScheduledEvent[]): ScheduledEvent[] {
  const sig = transportSignature(events);
  return events.map((e) => ({ ...e, auto: 'transport' as const, autoSig: sig }));
}

/** Travel blocks saved before blocks were tagged `auto` — recognised by
 *  the exact titles `buildDayTransportContext` writes. */
const LEGACY_AUTO_TITLE = /^(Head to |Flight |Train |Bus |Arrive at )/;

function isAutoTransport(e: ScheduledEvent): boolean {
  if (e.auto === 'transport') return true;
  return (
    !e.auto &&
    e.category === 'transport' &&
    e.plannedDurationMin === undefined &&
    LEGACY_AUTO_TITLE.test(e.title)
  );
}

/**
 * Bring one day's travel blocks in line with the trip's CURRENT transport.
 *
 * Returns the new event list, or `null` when nothing needs to change (so the
 * caller can skip a store write). Rules:
 *   - Only auto travel blocks are touched. Activities, meals and the user's
 *     own events are kept as they are — same objects, same ids.
 *   - Fingerprint unchanged → nothing happens, so blocks the user dragged by
 *     hand keep their hand-set times until the flight itself changes.
 *   - Fingerprint changed → the old blocks are replaced by fresh ones built
 *     from the new transport. Untagged blocks from older saved trips count as
 *     auto here and are tagged on the way through.
 *   - A day with no auto blocks at all is left alone: the user deleted them,
 *     and re-adding on every render would undo that.
 */
export function reconcileDayTransport(
  events: ScheduledEvent[],
  city: City,
  date: string,
  trip: Trip,
  cityIndex: number,
): ScheduledEvent[] | null {
  const existingAuto = events.filter(isAutoTransport);
  if (existingAuto.length === 0) return null;

  const ctx = buildDayTransportContext(city, date, trip, cityIndex);
  const fresh = ctx.events;
  const freshSig = transportSignature(fresh);
  const allTaggedCurrent = existingAuto.every((e) => e.auto === 'transport' && e.autoSig === freshSig);
  if (allTaggedCurrent) return null;

  const kept = refitPlannerItems(events.filter((e) => !isAutoTransport(e)), ctx);
  const next = [...kept, ...fresh];
  next.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  return next;
}

/**
 * After the travel blocks move, an activity the PLANNER placed can end up
 * at a time the traveller is not in the city yet (a later train) or has
 * already left. Those — and only those — are fitted again into the hours
 * the traveller is actually there.
 *
 * "Placed by the planner and untouched" is read from the data: it carries
 * `plannedDurationMin` and its block still spans exactly that long. Every
 * hand edit in the day planner drags an edge, which changes the span, so an
 * edited block is never moved. Items the user added carry no
 * `plannedDurationMin` at all. An item that no longer fits anywhere stays
 * where it was rather than being dropped — nothing the user can see
 * disappears because a train changed.
 */
function refitPlannerItems(kept: ScheduledEvent[], ctx: DayTransportContext): ScheduledEvent[] {
  if (ctx.homeSideOnly) return kept;
  const dayStart = Math.max(DAY_OPEN_MIN, ctx.windowStart);
  const dayEnd = Math.min(DAY_CLOSE_MIN, ctx.windowEnd);
  const travel: Range[] = ctx.events.map((e) => [timeToMinutes(e.startTime), timeToMinutes(e.endTime)]);
  const span = (e: ScheduledEvent): Range => [timeToMinutes(e.startTime), timeToMinutes(e.endTime)];
  const overlaps = (a: Range, b: Range) => a[0] < b[1] && b[0] < a[1];

  const isPlannerItem = (e: ScheduledEvent) =>
    (e.category === 'activity' || e.category === 'restaurant') &&
    typeof e.plannedDurationMin === 'number' &&
    span(e)[1] - span(e)[0] === e.plannedDurationMin;
  const misplaced = (e: ScheduledEvent) => {
    const r = span(e);
    return r[0] < dayStart || r[1] > dayEnd || travel.some((t) => overlaps(r, t));
  };

  const toMove = kept.filter((e) => isPlannerItem(e) && misplaced(e));
  if (toMove.length === 0) return kept;

  const staying = kept.filter((e) => !toMove.includes(e));
  const busyRanges: Range[] = [...travel, ...staying.map(span)];
  const sequence: PlanItem[] = [];
  const flexible: PlanItem[] = [];
  for (const e of toMove) {
    const item = { key: e.id, durationMin: e.plannedDurationMin! };
    if (e.category === 'restaurant') {
      const w = span(e)[0] < 16 * 60 ? MEAL_WINDOWS.lunch : MEAL_WINDOWS.dinner;
      flexible.push({ ...item, earliestStart: w.open, latestEnd: w.close, idealStart: w.ideal });
    } else {
      sequence.push({ ...item, earliestStart: Math.max(dayStart, 9 * 60), latestEnd: Math.min(dayEnd, 21 * 60) });
    }
  }
  const plan = planDay({ dayStart, dayEnd, busyRanges, sequence, flexible });
  const placed = new Map(plan.placements.map((p) => [p.key, p]));

  return kept.map((e) => {
    const p = placed.get(e.id);
    if (!p || !toMove.includes(e)) return e;
    // The measured leg from the previous slot no longer holds once moved.
    const { travelFromPrev: _stale, ...rest } = e;
    return { ...rest, startTime: minutesToTime(p.startMin), endTime: minutesToTime(p.endMin) };
  });
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

/**
 * An occupied stretch of the day. `key` names the planned item it holds (a
 * transport block has none), so travel time to and from it can be looked up.
 */
type Block = { range: Range; key?: string };

/**
 * Minutes needed between a block and a candidate placed next to it, given
 * which side the candidate is on. Never less than `SLOT_BUFFER_MIN`.
 */
type PadFor = (block: Block, side: 'before' | 'after') => number;

const uniformPad: PadFor = () => SLOT_BUFFER_MIN;

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
const freeGaps = (
  occupied: Block[],
  from: number,
  until: number,
  pad: PadFor = uniformPad,
): Range[] => {
  // A block is widened by the travel time FROM the candidate on its start
  // side (the candidate would end before it) and TO the candidate on its end
  // side (the candidate would start after it). Both are at least the plain
  // buffer, so geography only ever adds room — it can never create overlap.
  const blocked = mergeRanges(
    occupied.map(
      (b): Range => [b.range[0] - pad(b, 'before'), b.range[1] + pad(b, 'after')],
    ),
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
  occupied: Block[],
  from: number,
  until: number,
  dur: number,
  pad?: PadFor,
): number | null => {
  for (const [gs, ge] of freeGaps(occupied, from, until, pad)) {
    if (ge - gs >= dur) return gs;
  }
  return null;
};

/** Free minute closest to `ideal` where `dur` fits whole. */
const nearestFit = (
  occupied: Block[],
  from: number,
  until: number,
  dur: number,
  ideal: number,
  pad?: PadFor,
): number | null => {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const [gs, ge] of freeGaps(occupied, from, until, pad)) {
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
  /**
   * Minutes to get from one planned item to another, when both have a
   * location. Null / absent = unknown, and the plain `SLOT_BUFFER_MIN` is
   * kept. Anything longer than the buffer widens the gap between the two.
   */
  travelMin?: (fromKey: string, toKey: string) => number | null;
}): DayPlan {
  const { dayStart, dayEnd, busyRanges, sequence, flexible, travelMin } = params;

  /** Gap rule for placing `candidate` next to each occupied block. */
  const padFor = (candidate: string): PadFor => (block, side) => {
    if (!travelMin || !block.key) return SLOT_BUFFER_MIN;
    const t = side === 'after' ? travelMin(block.key, candidate) : travelMin(candidate, block.key);
    return Math.max(SLOT_BUFFER_MIN, t ?? 0);
  };

  const placements: PlanPlacement[] = [];
  const dropped: PlanDrop[] = [];
  // A block that ends before it starts wraps midnight — an overnight flight
  // or train rendered as "19:25–12:00". It occupies the rest of THIS day.
  // `mergeRanges` drops any range with end <= start, so passing it through
  // as-is made the flight invisible: the planner put a 3-hour evening
  // activity at 19:40 on the day of a 19:25 departure (production trip,
  // JFK → Paris, 2026-10-29).
  const occupied: Block[] = busyRanges.map(([s, e]): Block => ({ range: [s, e < s ? 24 * 60 : e] }));

  const bounds = (item: PlanItem): Range => [
    Math.max(dayStart, item.earliestStart),
    Math.min(dayEnd, item.latestEnd),
  ];

  /**
   * Which flexible items would still find a home against `probe`.
   * Simulated in window order, because seating breakfast can be what
   * leaves lunch nowhere to sit.
   */
  const survivingFlexible = (probe: Block[]): string[] => {
    const sim: Block[] = probe.map((b): Block => ({ range: [b.range[0], b.range[1]], key: b.key }));
    const alive: string[] = [];
    for (const item of flexible) {
      const [from, until] = bounds(item);
      const hit = nearestFit(sim, from, until, item.durationMin, item.idealStart ?? from, padFor(item.key));
      if (hit !== null) {
        alive.push(item.key);
        sim.push({ range: [hit, hit + item.durationMin], key: item.key });
      }
    }
    return alive;
  };

  let cursor: number | null = null;

  for (const item of sequence) {
    const [itemFrom, until] = bounds(item);
    const from = cursor === null ? itemFrom : Math.max(itemFrom, cursor + SLOT_BUFFER_MIN);
    const dur = item.durationMin;

    const pad = padFor(item.key);
    const plainFit = earliestFit(occupied, from, until, dur, pad);
    let chosen = plainFit;

    if (plainFit !== null) {
      // Meals the day could seat if this item were not placed at all.
      const before = survivingFlexible(occupied);
      let scan: number | null = plainFit;
      while (scan !== null) {
        const after = survivingFlexible([...occupied, { range: [scan, scan + dur], key: item.key }]);
        const starves = before.some((key) => after.indexOf(key) === -1);
        if (!starves) {
          chosen = scan;
          break;
        }
        scan = earliestFit(occupied, scan + 1, until, dur, pad);
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
    occupied.push({ range: [chosen, end], key: item.key });
    cursor = end;
  }

  for (const item of flexible) {
    const [from, until] = bounds(item);
    const start = nearestFit(
      occupied,
      from,
      until,
      item.durationMin,
      item.idealStart ?? from,
      padFor(item.key),
    );
    if (start === null) {
      dropped.push({ key: item.key, durationMin: item.durationMin });
      continue;
    }
    const end = start + item.durationMin;
    placements.push({ key: item.key, startMin: start, endMin: end, durationMin: item.durationMin });
    occupied.push({ range: [start, end], key: item.key });
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
  // Leaving home: nothing in the city is planned on this day.
  if (ctx.homeSideOnly) return events;

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

/**
 * Record, on each located event, the leg from the event right before it —
 * when that one is located too. Transport blocks break the chain (the
 * traveller's position around a flight is the airport, not a POI).
 * Mutates and returns `events`, which must be sorted by start time.
 */
export function annotateTravel(events: ScheduledEvent[], legs?: TravelLegs | null): ScheduledEvent[] {
  for (let i = 0; i < events.length; i++) {
    const evt = events[i];
    delete evt.travelFromPrev;
    const prev = events[i - 1];
    if (!prev || prev.category === 'transport' || evt.category === 'transport') continue;
    const leg = travelBetween(prev, evt, legs);
    if (leg) evt.travelFromPrev = leg;
  }
  return events;
}

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
 *
 * Geography: when picks carry real coordinates (from the backend's POI
 * provider), each day is chained by distance — the morning activity, then
 * the lunch spot NEAREST it, then the afternoon activity nearest lunch, the
 * evening one nearest that, and breakfast / dinner nearest their neighbours.
 * The gap between two located slots is at least the travel time between
 * them (`opts.legs` when the backend measured it, else an estimate), and
 * each located event records that leg in `travelFromPrev`. A pick without
 * coordinates is taken in queue order, exactly as before, so a city with no
 * located picks schedules identically to the non-geographic planner.
 */
export function buildCityScheduleFromSuggestions(
  activities: ActivitySuggestion[],
  restaurants: RestaurantSuggestion[],
  city: City,
  cityIndex: number,
  trip: Trip,
  opts: { legs?: TravelLegs | null } = {},
): CitySchedule {
  const legs = opts.legs ?? null;
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

  /**
   * The next restaurant for a meal. With a located `near`, the closest
   * located one in the meal's own queue or the 'any' queue; otherwise (or
   * when none of them is located) queue order, preferred queue first.
   */
  const takeRestaurant = (
    preferred: Exclude<RestBucket, 'any'>,
    near: Located | null = null,
  ): { suggestion: RestaurantSuggestion; bucket: RestBucket } | undefined => {
    if (hasCoords(near)) {
      const pool: Array<{ suggestion: RestaurantSuggestion; bucket: RestBucket }> = [
        ...restBuckets[preferred].map((r) => ({ suggestion: r, bucket: preferred as RestBucket })),
        ...restBuckets.any.map((r) => ({ suggestion: r, bucket: 'any' as RestBucket })),
      ];
      const at = nearestIndex(near, pool.map((c) => c.suggestion));
      if (at >= 0) {
        const chosen = pool[at];
        const queue = restBuckets[chosen.bucket];
        queue.splice(queue.indexOf(chosen.suggestion), 1);
        return chosen;
      }
    }
    const fromPreferred = restBuckets[preferred].shift();
    if (fromPreferred) return { suggestion: fromPreferred, bucket: preferred };
    const fromAny = restBuckets.any.shift();
    if (fromAny) return { suggestion: fromAny, bucket: 'any' };
    return undefined;
  };

  /** The next activity for a time of day: nearest `near` when both are located, else queue order. */
  const takeActivity = (bucket: ActBucket, near: Located | null): ActivitySuggestion | undefined => {
    const queue = actBuckets[bucket];
    const at = nearestIndex(near, queue);
    return at >= 0 ? queue.splice(at, 1)[0] : queue.shift();
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

  // The home departure day of an overnight outbound sits BEFORE the stay:
  // the head-to-airport and flight blocks live there, under the first city
  // (the same way the fly-home day lives under the last one), and nothing
  // from the city's queues is spent on it.
  const homeDeparture = cityIndex === 0 ? homeDepartureDay(trip) : null;
  if (homeDeparture) {
    const { events } = buildDayTransportContext(city, homeDeparture, trip, cityIndex);
    if (events.length > 0) schedule[homeDeparture] = events;
  }

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
    /** Where each offered item is, for travel time between them. */
    const located = new Map<string, Located>();

    // ── Choose the day's picks, chained by distance where located:
    //    morning → lunch nearest it → afternoon nearest lunch → evening
    //    nearest that; breakfast nearest the morning, dinner nearest the
    //    last activity. `anchor` is the latest located stop in that chain.
    let anchor: Located | null = null;
    const advance = (p: Located | undefined) => {
      if (hasCoords(p)) anchor = p;
    };
    const morning = takeActivity('morning', null);
    advance(morning);
    const breakfast = takeRestaurant('breakfast', morning ?? null);
    const lunch = takeRestaurant('lunch', anchor);
    advance(lunch?.suggestion);
    const afternoon = takeActivity('afternoon', anchor);
    advance(afternoon);
    const evening = takeActivity('evening', anchor);
    advance(evening);
    const dinner = takeRestaurant('dinner', anchor);
    const chosenActivities: Record<ActBucket, ActivitySuggestion | undefined> = { morning, afternoon, evening };
    const chosenMeals: Record<'breakfast' | 'lunch' | 'dinner', ReturnType<typeof takeRestaurant>> = {
      breakfast,
      lunch,
      dinner,
    };

    // ── The day's backbone: one activity per time-of-day, in order.
    (['morning', 'afternoon', 'evening'] as const).forEach((bucket) => {
      const suggestion = chosenActivities[bucket];
      if (!suggestion) return;
      const key = `${bucket}-activity`;
      offered.set(key, { kind: 'activity', suggestion, bucket });
      if (hasCoords(suggestion)) located.set(key, suggestion);
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
        ...coordsOf(suggestion),
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
      const taken = chosenMeals[meal];
      if (!taken) return;
      const { suggestion, bucket } = taken;
      const key = `${meal}-restaurant`;
      const window = MEAL_WINDOWS[meal];
      offered.set(key, { kind: 'restaurant', suggestion, bucket });
      if (hasCoords(suggestion)) located.set(key, suggestion);
      makers.set(key, (startMin, endMin) => ({
        id: `sched-${++idCounter}`,
        title: `${suggestion.name} (${suggestion.cuisine})`,
        startTime: minutesToTime(startMin),
        endTime: minutesToTime(endMin),
        category: 'restaurant',
        notes: `${suggestion.priceRange} · ${suggestion.reason}`,
        ...coordsOf(suggestion),
      }));
      flexible.push({
        key,
        durationMin: MEAL_DURATION_MIN[meal],
        earliestStart: window.open,
        latestEnd: window.close,
        idealStart: window.ideal,
      });
    });

    const travelMin = (fromKey: string, toKey: string): number | null =>
      travelBetween(located.get(fromKey), located.get(toKey), legs)?.minutes ?? null;
    const plan = planDay({ dayStart, dayEnd, busyRanges, sequence, flexible, travelMin });

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
    annotateTravel(events, legs);

    if (events.length > 0) schedule[dateKey] = events;
  }

  return { schedule, unscheduled: turnedAway.map((entry) => entry.item) };
}
