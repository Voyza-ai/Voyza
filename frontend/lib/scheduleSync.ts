import type { City, HomeLeg, ScheduledEvent, Transport, Trip, UnscheduledItem } from './types';
import {
  ACTIVITY_EARLIEST_MIN,
  DAY_CLOSE_MIN,
  DAY_OPEN_MIN,
  DEFAULT_ACTIVITY_MIN,
  MEAL_DURATION_MIN,
  MEAL_WINDOWS,
  buildDayTransportContext,
  planDay,
  type DayTransportContext,
  type PlanItem,
} from './dayScheduleDefaults';
import { reconcileDayEvents } from './transportReconcile';
import { parseStop, relayMovedStay } from './stayRelay';
import { homeDepartureDay } from './tripSpan';
import { parseLocal, toIso } from './dateHelpers';
import { coordsOf, travelBetween } from './geoSchedule';
import { dinnerNightAfter, insertDinner, isDinner, stayNights } from './dinnerPlace';

/**
 * Keep a city's day plans in step with its dates and transport.
 *
 * A city's schedule is a saved list of events per date, built when the trip
 * was planned. Dates and legs then move — an AI chat edit (a pinned stay, one
 * more night, a city added or replaced, another flight), the − / + nights on
 * a city card — and the schedule used to follow only partly: travel blocks
 * were re-derived (transportReconcile) but nothing else moved. A stay pushed
 * a day later kept its old full day where the traveller now flies in, so the
 * morning's sights sat before the flight landed; the old fly-home morning
 * became a mid-stay day with nothing on it.
 *
 * Here every day the city holds is checked against the transport as it is now:
 *
 *  - Travel blocks are re-derived (reconcileDayEvents: user-moved ones stay).
 *  - A planned stop the traveller can no longer make — before they land
 *    (plus the arrival cushion), after they leave for the airport, or over a
 *    travel block — moves later that day when it fits, else to another day of
 *    the same stay; one no day can hold is listed as unscheduled. Never
 *    shortened, never silently lost.
 *  - A day the stay no longer has drops its stops; they become free for the
 *    days it gained (and are listed as unscheduled when none takes them). The
 *    traveller's own blocks there are moved onto the stay.
 *  - A day never laid out, or one whose stops just had to move, is filled
 *    from what no day uses — the stops that just moved first, then the stops
 *    of the lost days, then the city's unused picks. After a date or
 *    transport change (`prev` given) so is a day the stay GAINED or whose
 *    free hours grew; if it still has nothing planned, it gets the city's
 *    default plan — its picks again, furthest-placed first — rather than
 *    staying empty. A planned day left empty is not refilled: the stay ran
 *    out of stops, or the traveller cleared it.
 *  - A day whose flight home is still being searched (the stay just moved) is
 *    left as it is until the flight lands.
 *
 * "Planned stop" is read from the data, as the planner wrote it: an activity
 * or meal whose block still spans its `plannedDurationMin`. Anything else —
 * events the traveller added, stops they resized — is theirs: left alone on
 * a plain pass, and only moved off a travel block after a date or transport
 * change.
 *
 * Pure. Returns the city's new schedule and unscheduled list, or null when
 * nothing changes (callers write nothing, so a view running this on every
 * render settles at once).
 */

type Meal = 'breakfast' | 'lunch' | 'dinner';
type Slot = 'morning' | 'afternoon' | 'evening';
type Range = [number, number];

/** Something to place: a stop already planned somewhere, or a pick with no block yet. */
type Stop = {
  key: string;
  /** Template: everything but the times is kept when it is placed. */
  event: ScheduledEvent;
  meal?: Meal;
  slot?: Slot;
  durationMin: number;
  /** 0 = moved off its day, 1 = from a day the stay lost, 2 = unused pick, 3 = default (a repeat). */
  rank: number;
  /** The day it was on, for "the nearest day" when it has to move. */
  day?: string;
};

export type CityScheduleSync = { schedule: Record<string, ScheduledEvent[]>; unscheduled: City['unscheduled'] };

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};
const toTime = (mins: number): string =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const spanOf = (e: ScheduledEvent): Range => {
  const s = toMin(e.startTime);
  const end = toMin(e.endTime);
  return [s, end < s ? 24 * 60 : end];
};
const overlaps = (a: Range, b: Range) => a[0] < b[1] && b[0] < a[1];
const byStart = (a: ScheduledEvent, b: ScheduledEvent) => toMin(a.startTime) - toMin(b.startTime);
const itemKey = (name: string) => name.trim().toLowerCase();

let seq = 0;
const freshId = () => `sync-${Date.now().toString(36)}-${++seq}`;

/** A stop the planner placed and nobody has reshaped since. */
export const isPlannedStop = (e: ScheduledEvent): boolean =>
  (e.category === 'activity' || e.category === 'restaurant') &&
  typeof e.plannedDurationMin === 'number' &&
  spanOf(e)[1] - spanOf(e)[0] === e.plannedDurationMin;

/**
 * The traveller's own block: anything that is neither travel nor a planned
 * stop — nor a dinner plan, which has its own rule (below): it stays in its
 * city, on a night of the stay, at its time.
 */
export const isTravellersOwn = (e: ScheduledEvent) => e.category !== 'transport' && !isPlannedStop(e) && !isDinner(e);
const isOwn = isTravellersOwn;

const mealAt = (start: number): Meal => (start < 11 * 60 ? 'breakfast' : start < 16 * 60 ? 'lunch' : 'dinner');
const slotAt = (start: number): Slot => (start < 12 * 60 ? 'morning' : start < 17 * 60 ? 'afternoon' : 'evening');

/** A planned stop as something to place again. */
function stopOf(e: ScheduledEvent, rank: number, day?: string): Stop {
  const start = toMin(e.startTime);
  const parsed = parseStop(e);
  const isMeal = e.category === 'restaurant' && !!parsed.meal;
  const { travelFromPrev: _stale, ...event } = e;
  return {
    key: itemKey(parsed.name),
    event,
    meal: isMeal ? mealAt(start) : undefined,
    slot: isMeal ? undefined : slotAt(start),
    durationMin: e.plannedDurationMin ?? spanOf(e)[1] - spanOf(e)[0],
    rank,
    day,
  };
}

/** The days a city's schedule holds: its nights, the fly-home day of the last city, the home-departure day of the first. */
export function coverDays(trip: Pick<Trip, 'cities' | 'origin'>, cityIndex: number): string[] {
  const city = trip.cities[cityIndex];
  if (!city || !validIso(city.dates.arrival) || !validIso(city.dates.departure)) return [];
  const out: string[] = [];
  const homeDep = cityIndex === 0 ? homeDepartureDay(trip) : null;
  if (homeDep) out.push(homeDep);
  const end = parseLocal(city.dates.departure);
  for (let d = parseLocal(city.dates.arrival); d < end && out.length < 400; d.setDate(d.getDate() + 1)) out.push(toIso(d));
  if (cityIndex === trip.cities.length - 1 && !out.includes(city.dates.departure)) out.push(city.dates.departure);
  return out;
}

/** The free hours of a day for planned stops, or null while its flight home is still being searched. */
function dayWindow(trip: Trip, cityIndex: number, date: string, ctx: DayTransportContext): Range | null {
  if (pendingHome(trip, cityIndex, date)) return null;
  if (ctx.homeSideOnly) return [24 * 60, 0];
  return [Math.max(DAY_OPEN_MIN, ctx.windowStart), Math.min(DAY_CLOSE_MIN, ctx.windowEnd)];
}

/**
 * The last day of a trip that flies home, while that flight is not known for
 * it: cleared for a re-search after the stay moved, or still the old day's
 * flight. Its hours are unknown, so nothing is moved or planned around it yet.
 */
function pendingHome(trip: Trip, cityIndex: number, date: string): boolean {
  const last = trip.cities.length - 1;
  if (cityIndex !== last || trip.cities[last]?.dates.departure !== date) return false;
  if (!trip.origin?.city || trip.returnToHome === false) return false;
  const leg = trip.origin.returnLeg;
  return !leg?.departTime || (!!leg.departDate && leg.departDate !== date);
}

/**
 * Bring one city's schedule in line with the trip. `prev` is the trip as it
 * was before a change (the store passes it); with it, the days the stay
 * gained — or whose free hours grew — may take the city's default plan when
 * nothing unused is left for them.
 */
export function syncCitySchedule(
  trip: Trip,
  cityIndex: number,
  prev?: { trip: Trip; cityIndex: number } | null,
): CityScheduleSync | null {
  const city = trip.cities[cityIndex];
  const cover = coverDays(trip, cityIndex);
  if (!city || cover.length === 0) return null;
  const coverSet = new Set(cover);
  const original = city.schedule ?? {};
  let old = original;
  let unscheduled: UnscheduledItem[] = [...(city.unscheduled ?? [])];
  const afterChange = !!prev;

  // The traveller's own blocks on days the stay no longer has: moved onto it below.
  const orphans: Array<{ e: ScheduledEvent; day: string }> = [];
  for (const [d, events] of Object.entries(original)) {
    if (coverSet.has(d)) continue;
    for (const e of events) if (isOwn(e)) orphans.push({ e, day: d });
  }

  // A stay with nothing planned on any of its days, while it has stops to
  // place (moved wholesale, or never laid out): the stay-wide geographic
  // planner lays it out again from those stops.
  const plannedOn = (d: string) => (old[d] ?? []).some(isPlannedStop);
  if (!cover.some(plannedOn)) {
    const relaid = relayMovedStay(trip, cityIndex);
    if (relaid) {
      old = relaid.schedule;
      unscheduled = [...(relaid.unscheduled ?? [])];
    }
  }

  const next: Record<string, ScheduledEvent[]> = {};
  const ctxs = new Map<string, DayTransportContext>();
  const windows = new Map<string, Range | null>();
  const changed = new Set<string>();
  const displaced: Stop[] = [];
  const refitDays = new Set<string>();
  const keyless = new Set<string>();

  for (const d of cover) {
    const ctx = buildDayTransportContext(city, d, trip, cityIndex);
    ctxs.set(d, ctx);
    const win = dayWindow(trip, cityIndex, d, ctx);
    windows.set(d, win);
    const existing = old[d];
    if (existing === undefined) {
      next[d] = [...ctx.events];
      keyless.add(d);
      changed.add(d);
      continue;
    }
    const reconciled = reconcileDayEvents(existing, ctx.events);
    let events = reconciled ?? existing;
    if (reconciled) changed.add(d);
    if (!win) {
      next[d] = events;
      continue;
    }

    // Planned stops the traveller can no longer make; after a change, also
    // their own blocks that now sit on a travel block.
    const travel = travelRanges(events, ctx);
    const misplaced = events.filter((e) => {
      if (e.category === 'transport' || isDinner(e)) return false;
      const r = spanOf(e);
      const onTravel = travel.some((t) => overlaps(r, t));
      if (isPlannedStop(e)) return onTravel || r[0] < win[0] || r[1] > win[1];
      return afterChange && onTravel;
    });
    if (misplaced.length === 0) {
      next[d] = events;
      continue;
    }
    events = events.filter((e) => !misplaced.includes(e));
    changed.add(d);
    refitDays.add(d);
    // Later the same day, where it fits.
    for (const e of misplaced) {
      const planned = isPlannedStop(e);
      // A planned stop goes later; the traveller's own block to the free
      // time nearest where they put it.
      const placed = planned
        ? placeOn(events, travel, win, e, { from: toMin(e.startTime) })
        : placeOn(events, travel, [0, 24 * 60], e, { near: true });
      if (placed) events = [...events, placed].sort(byStart);
      else if (planned) displaced.push(stopOf(e, 0, d));
      else orphans.push({ e, day: d });
    }
    next[d] = events;
  }

  // Days the stay lost: their stops are free for the days it has now.
  const placedKeys = () => {
    const keys = new Set<string>();
    for (const d of cover) for (const e of next[d] ?? []) if (e.category !== 'transport') keys.add(itemKey(parseStop(e).name));
    return keys;
  };
  const lost: Stop[] = [];
  for (const d of Object.keys(old).sort()) {
    if (coverSet.has(d)) continue;
    for (const e of [...old[d]].sort(byStart)) if (isPlannedStop(e)) lost.push(stopOf(e, 1, d));
  }
  const removedKeys = Object.keys(original).some((d) => !coverSet.has(d));

  // The pool, best first: what just moved, then the lost days' stops, then
  // picks no day uses. A dinner plan's restaurant counts as used wherever the
  // dinner sits now — it is put back on its night only at the end, and a
  // moved stay's dinner is still on an old date here (live, after a drag:
  // Septime filled Jan 14's evening while it was Jan 13's dinner).
  const dinnerSpots = new Set(Object.values(original).flat().filter(isDinner).map((e) => itemKey(e.dinner!.restaurant)));
  const onStay = placedKeys();
  dinnerSpots.forEach((k) => onStay.add(k));
  const pool: Stop[] = [];
  const inPool = new Set<string>();
  const add = (s: Stop) => {
    if (onStay.has(s.key) || inPool.has(s.key)) return;
    inPool.add(s.key);
    pool.push(s);
  };
  displaced.forEach(add);
  lost.forEach(add);
  for (const s of picksOf(city, 2)) add(s);

  // Which days the pool may fill: a day never planned (no schedule yet), one
  // whose stops just had to move, and — after a change — the days the stay
  // gained or whose free hours grew; those may also take the city's
  // defaults. A planned day left empty is not refilled: the stay ran out of
  // stops, or the traveller cleared it.
  const eligible = afterChange ? grownDays(trip, cityIndex, cover, prev!) : new Set<string>();
  const fillable = (d: string): Range | null => {
    const win = windows.get(d);
    return win && win[1] - win[0] >= 30 ? win : null;
  };
  const write = (d: string, events: ScheduledEvent[]) => {
    if (events === next[d]) return;
    next[d] = events;
    changed.add(d);
  };

  // The traveller's own blocks first — they never disappear: onto the
  // nearest day of the stay, at their time when it is free, else the free
  // time nearest it, else as they were.
  for (const { e, day } of orphans) {
    const days = nearestFirst(cover, day);
    let target = days[0];
    let placed: ScheduledEvent | null = null;
    for (const d of days) {
      const events = next[d];
      placed = placeOn(events, travelRanges(events, ctxs.get(d)!), [0, 24 * 60], e, { near: true });
      if (placed) {
        target = d;
        break;
      }
    }
    write(target, [...next[target], placed ?? e].sort(byStart));
  }

  for (const d of cover) {
    const win = fillable(d);
    if (!win || (!keyless.has(d) && !refitDays.has(d) && !eligible.has(d))) continue;
    write(d, fillDay(next[d], travelRanges(next[d], ctxs.get(d)!), win, pool));
  }

  // Stops that had to move and no day above took: any day of the stay with room.
  for (const s of pool.filter((p) => p.rank === 0)) {
    let done = false;
    for (const d of nearestFirst(cover, s.day)) {
      const win = windows.get(d);
      if (!win) continue;
      const events = next[d];
      if (s.meal && events.some((e) => isMealOf(e, s.meal!))) continue;
      const placed = placeStop(events, travelRanges(events, ctxs.get(d)!), win, s);
      if (placed) {
        write(d, [...events, placed].sort(byStart));
        done = true;
        break;
      }
    }
    pool.splice(pool.indexOf(s), 1);
    if (!done) {
      unscheduled = [
        ...unscheduled.filter((u) => itemKey(u.title) !== s.key),
        { title: parseStop(s.event).name, kind: s.meal ? 'restaurant' : 'activity', durationMin: s.durationMin, date: null },
      ];
    }
  }

  // Stops of the days the stay lost that no day took: listed, not lost.
  for (const s of pool.filter((p) => p.rank === 1)) {
    unscheduled = [
      ...unscheduled.filter((u) => itemKey(u.title) !== s.key),
      { title: parseStop(s.event).name, kind: s.meal ? 'restaurant' : 'activity', durationMin: s.durationMin, date: s.day ?? null },
    ];
  }

  // A day the stay just gained (or whose free hours grew) with still nothing
  // planned on it: the city's own default plan rather than an empty day — its
  // picks again, those placed furthest from this day first, so a stop is not
  // repeated the day after it was seen.
  for (const d of cover) {
    const win = fillable(d);
    if (!win || !eligible.has(d) || next[d].some((e) => e.category !== 'transport')) continue;
    write(d, fillDay(next[d], travelRanges(next[d], ctxs.get(d)!), win, defaultsFor(city, d, cover, next, dinnerSpots)));
  }

  // Dinner plans (ScheduledEvent.dinner): each stays on its night at its
  // time. A stay that moved wholesale (a reorder) takes its dinner to the
  // same night of the stay; otherwise one whose night the stay no longer has
  // moves to the nearest night it still has (a later one on a tie) — see
  // dinnerNightAfter; the backend's chat reply says the same. It keeps its
  // time and records where it came from, so the views can say it moved. It
  // never moves to another city, and never lands on the fly-home morning,
  // which is not a night. It takes the place of a dinner the planner put on
  // that evening.
  const dinners: Array<{ e: ScheduledEvent; day: string }> = [];
  for (const [d, events] of Object.entries(original)) for (const e of events) if (isDinner(e)) dinners.push({ e, day: d });
  if (dinners.length > 0) {
    const nights = stayNights(city);
    const prevCity = prev ? prev.trip.cities[prev.cityIndex] : null;
    const oldNights = prevCity ? stayNights(prevCity) : null;
    for (const d of Object.keys(next)) if (next[d].some(isDinner)) next[d] = next[d].filter((e) => !isDinner(e));
    for (const { e, day } of dinners) {
      const target = dinnerNightAfter(oldNights, nights, day);
      if (!target || !next[target]) continue;
      const ev = target === day ? e : { ...e, dinner: { ...e.dinner!, movedFrom: e.dinner!.movedFrom ?? day } };
      const placed = insertDinner(next[target], ev, target);
      next[target] = placed.events;
      changed.add(target);
      for (const u of placed.dropped) unscheduled = [...unscheduled.filter((x) => itemKey(x.title) !== itemKey(u.title)), u];
    }
    for (const d of cover) if (!sameDay(next[d], original[d])) changed.add(d);
  }

  // What is on the stay now is no longer "unscheduled".
  const nowPlaced = placedKeys();
  const nextUnscheduled = unscheduled.filter((u) => !nowPlaced.has(itemKey(u.title)));

  const sameUnscheduled = JSON.stringify(nextUnscheduled) === JSON.stringify(city.unscheduled ?? []);
  const sameDays = cover.every((d) => !changed.has(d) || sameDay(next[d], original[d]));
  if (old === original && sameDays && sameUnscheduled && !removedKeys) return null;
  return { schedule: next, unscheduled: nextUnscheduled };
}

/**
 * Every city after a change from `prev` to `trip`. Only cities whose dates or
 * transport moved are synced; the trip comes back unchanged (same object)
 * when none needs anything.
 */
export function syncTripSchedules(prev: Trip | null | undefined, trip: Trip): Trip {
  if (!prev || prev === trip) return trip;
  let cities: City[] | null = null;
  trip.cities.forEach((city, i) => {
    const pi = prev.cities.findIndex((c) => c.name.toLowerCase() === city.name.toLowerCase());
    // Nothing laid out yet: the views build it when they show it.
    if (!city.schedule) return;
    if (pi >= 0 && transportKey(prev, pi) === transportKey(trip, i)) return;
    const out = syncCitySchedule(trip, i, pi >= 0 ? { trip: prev, cityIndex: pi } : null);
    if (!out) return;
    cities = cities ?? [...trip.cities];
    cities[i] = { ...city, schedule: out.schedule, unscheduled: out.unscheduled };
  });
  return cities ? { ...trip, cities } : trip;
}

/** Everything a city's day plans are built from: dates, its place in the trip, its legs. */
function transportKey(trip: Trip, i: number): string {
  const c = trip.cities[i];
  const last = trip.cities.length - 1;
  const leg = (t: Transport | undefined) =>
    t ? [t.mode, t.departTime, t.arriveTime, t.duration, t.unavailable ? 1 : 0, t.fromStation, t.toStation] : null;
  const home = (h: Omit<HomeLeg, 'alternatives'> | null | undefined) =>
    h ? [h.departTime, h.arriveTime, h.departDate, h.originAirport, h.destAirport] : null;
  return JSON.stringify([
    c.dates,
    i === 0,
    i === last,
    leg(c.transportIn),
    leg(c.transportOut),
    i === 0 ? home(trip.origin?.outboundLeg) : null,
    i === last ? home(trip.origin?.returnLeg) : null,
    i === last ? [trip.origin?.city ?? null, trip.returnToHome ?? true] : null,
  ]);
}

/**
 * Days that gained free hours from `prev`: new to the stay, waiting on a
 * flight before, or with a later departure / earlier arrival than they had.
 */
function grownDays(trip: Trip, cityIndex: number, cover: string[], prev: { trip: Trip; cityIndex: number }): Set<string> {
  const before = new Set(prev.cityIndex >= 0 ? coverDays(prev.trip, prev.cityIndex) : []);
  const prevCity = prev.trip.cities[prev.cityIndex];
  const out = new Set<string>();
  for (const d of cover) {
    const ctx = buildDayTransportContext(trip.cities[cityIndex], d, trip, cityIndex);
    const now = dayWindow(trip, cityIndex, d, ctx);
    if (!now) continue;
    if (!before.has(d) || !prevCity) {
      out.add(d);
      continue;
    }
    const then = dayWindow(prev.trip, prev.cityIndex, d, buildDayTransportContext(prevCity, d, prev.trip, prev.cityIndex));
    if (!then || now[0] < then[0] - 30 || now[1] > then[1] + 30) out.add(d);
  }
  return out;
}

/**
 * The city's picks as stops: its activity list and restaurants. A pick the
 * planner turned away keeps the length it needed; the rest carry none, so
 * they get the default the per-day plan always used.
 */
function picksOf(city: City, rank: number): Stop[] {
  const out: Stop[] = [];
  const needed = new Map((city.unscheduled ?? []).map((u) => [itemKey(u.title), u.durationMin]));
  city.activities.forEach((name) => {
    out.push({
      key: itemKey(name),
      event: { id: '', title: name, startTime: '00:00', endTime: '00:00', category: 'activity' },
      durationMin: needed.get(itemKey(name)) ?? DEFAULT_ACTIVITY_MIN,
      rank,
    });
  });
  city.restaurants.forEach((r) => {
    out.push({
      key: itemKey(r.name),
      event: {
        id: '',
        title: r.name,
        startTime: '00:00',
        endTime: '00:00',
        category: 'restaurant',
        notes: `${r.cuisine} · ${r.priceRange}`,
        ...coordsOf(r),
      },
      meal: undefined, // a curated restaurant suits lunch or dinner
      durationMin: 0,
      rank,
    });
  });
  return out;
}

/**
 * The city's picks for a day that has nothing left to take: those placed
 * furthest from it first. A pick already on the stay is offered as it was
 * planned there — its time of day, length and place — so an evening food
 * tour is not put in a morning slot as a bare name.
 */
function defaultsFor(city: City, day: string, cover: string[], schedule: Record<string, ScheduledEvent[]>, dinnerSpots: Set<string>): Stop[] {
  const at = new Map<string, { gap: number; event: ScheduledEvent }>();
  const t = parseLocal(day).getTime();
  for (const d of cover) {
    const gap = Math.abs(parseLocal(d).getTime() - t);
    for (const e of schedule[d] ?? []) {
      if (!isPlannedStop(e)) continue;
      const k = itemKey(parseStop(e).name);
      const held = at.get(k);
      if (!held || gap < held.gap) at.set(k, { gap, event: e });
    }
  }
  // A restaurant a dinner plan uses is not placed again on an empty day.
  return picksOf(city, 3)
    .filter((s) => !dinnerSpots.has(s.key))
    .map((s, i) => {
      const held = at.get(s.key);
      return { s: held ? { ...stopOf(held.event, 3), event: { ...stopOf(held.event, 3).event, id: '' } } : s, i, gap: held?.gap ?? Infinity };
    })
    .sort((a, b) => b.gap - a.gap || a.i - b.i)
    .map(({ s }) => s);
}

/** Travel blocks of a day as busy ranges (the generated ones as the transport context measures them). */
function travelRanges(events: ScheduledEvent[], ctx: DayTransportContext): Range[] {
  const generated = new Map(ctx.events.map((e, i) => [`${e.title}|${e.startTime}|${e.endTime}`, ctx.busy[i]]));
  return events
    .filter((e) => e.category === 'transport')
    .map((e) => generated.get(`${e.title}|${e.startTime}|${e.endTime}`) ?? spanOf(e));
}

const isMealOf = (e: ScheduledEvent, meal: Meal) =>
  (isDinner(e) && meal === 'dinner') ||
  (e.category === 'restaurant' && !!parseStop(e).meal && mealAt(toMin(e.startTime)) === meal);

/** Cover days, nearest to `day` first (later before earlier on a tie); in order without one. */
function nearestFirst(cover: string[], day: string | undefined): string[] {
  if (!day) return [...cover];
  const dist = (d: string) => Math.abs(parseLocal(d).getTime() - parseLocal(day).getTime());
  return [...cover].sort((a, b) => dist(a) - dist(b) || (a < b ? 1 : -1));
}

/** Busy ranges of a day: travel blocks (as measured) plus every other block. */
const busyOf = (events: ScheduledEvent[], travel: Range[]): Range[] => [
  ...travel,
  ...events.filter((e) => e.category !== 'transport').map(spanOf),
];

/**
 * `e` moved inside `win`, keeping its length; null when the day has no room.
 * `from`: the first free start at or after that minute (a planned stop moving
 * later). `near`: its own time when that is free, else the free start nearest
 * it (the traveller's own block).
 */
function placeOn(
  events: ScheduledEvent[],
  travel: Range[],
  win: Range,
  e: ScheduledEvent,
  how: { from: number } | { near: true },
): ScheduledEvent | null {
  const [s0, e0] = spanOf(e);
  const dur = Math.max(15, e0 - s0);
  const busy = busyOf(events, travel);
  const near = 'near' in how;
  if (near && s0 >= win[0] && e0 <= win[1] && !busy.some((b) => overlaps([s0, e0], b))) return e;
  const meal = !near && e.category === 'restaurant' && parseStop(e).meal ? MEAL_WINDOWS[mealAt(s0)] : null;
  const lo = Math.max(win[0], meal ? meal.open : 0, near ? 0 : how.from);
  const hi = Math.min(win[1], meal ? meal.close : 24 * 60);
  const item = { key: 'x', durationMin: dur, earliestStart: lo, latestEnd: hi };
  const plan = planDay({
    dayStart: lo,
    dayEnd: hi,
    busyRanges: busy,
    sequence: near ? [] : [item],
    flexible: near ? [{ ...item, idealStart: s0 }] : [],
  });
  const p = plan.placements[0];
  if (!p) return null;
  const { travelFromPrev: _stale, ...rest } = e;
  return { ...rest, startTime: toTime(p.startMin), endTime: toTime(p.endMin) };
}

/** A pool stop onto a day, in its meal window or from its time of day; null when it does not fit. */
function placeStop(events: ScheduledEvent[], travel: Range[], win: Range, s: Stop): ScheduledEvent | null {
  const filled = fillDay(events, travel, win, [s], true);
  return filled === events ? null : filled.find((e) => !events.includes(e)) ?? null;
}

/**
 * Fill what a day is missing — breakfast, a morning, lunch, an afternoon, an
 * evening, dinner — from `pool`, best-ranked first, around what is on it.
 * Placed stops leave the pool. Returns `events` itself when nothing fit.
 * `any` takes the first stop in the pool that fits, whatever the day has.
 */
function fillDay(events: ScheduledEvent[], travel: Range[], win: Range, pool: Stop[], any = false): ScheduledEvent[] {
  if (pool.length === 0) return events;
  const own = events.filter((e) => e.category !== 'transport');
  const has = {
    meal: (m: Meal) => own.some((e) => isMealOf(e, m)),
    slot: (s: Slot) => own.some((e) => e.category !== 'transport' && !isMealOfAny(e) && slotAt(toMin(e.startTime)) === s),
  };
  const onDay = new Set(own.map((e) => itemKey(parseStop(e).name)));
  const ordered = [...pool].sort((a, b) => a.rank - b.rank);
  const taken = new Set<Stop>();
  const take = (ok: (s: Stop) => boolean) => {
    const s = ordered.find((x) => !taken.has(x) && !onDay.has(x.key) && ok(x));
    if (s) taken.add(s);
    return s;
  };

  const chosen: Array<{ stop: Stop; meal?: Meal; slot?: Slot }> = [];
  if (any) {
    const s = ordered[0];
    if (s) chosen.push({ stop: s, meal: s.meal ?? (s.event.category === 'restaurant' && !s.slot ? 'lunch' : undefined), slot: s.slot });
  } else {
    for (const slot of ['morning', 'afternoon', 'evening'] as const) {
      if (has.slot(slot)) continue;
      const s = take((x) => !x.meal && x.event.category !== 'restaurant' && x.slot === slot) ??
        // A pick with no time of its own suits a morning or an afternoon.
        (slot !== 'evening' ? take((x) => !x.meal && x.event.category === 'activity' && !x.slot) : undefined) ??
        take((x) => !x.meal && x.slot === slot);
      if (s) chosen.push({ stop: s, slot });
    }
    for (const meal of ['breakfast', 'lunch', 'dinner'] as const) {
      if (has.meal(meal)) continue;
      const s = take((x) => x.meal === meal) ??
        (meal !== 'breakfast' ? take((x) => !x.meal && !x.slot && x.event.category === 'restaurant') : undefined);
      if (s) chosen.push({ stop: s, meal });
    }
  }
  if (chosen.length === 0) return events;

  const sequence: PlanItem[] = [];
  const flexible: PlanItem[] = [];
  const byKey = new Map<string, { stop: Stop; meal?: Meal }>();
  chosen.forEach(({ stop, meal, slot }, i) => {
    const key = `s${i}`;
    byKey.set(key, { stop, meal });
    if (meal) {
      const w = MEAL_WINDOWS[meal];
      flexible.push({
        key,
        durationMin: stop.durationMin > 0 ? stop.durationMin : MEAL_DURATION_MIN[meal],
        earliestStart: w.open,
        latestEnd: w.close,
        idealStart: w.ideal,
      });
    } else {
      sequence.push({
        key,
        durationMin: stop.durationMin,
        earliestStart: ACTIVITY_EARLIEST_MIN[slot ?? 'morning'],
        latestEnd: win[1],
      });
    }
  });
  const located = new Map(chosen.map(({ stop }, i) => [`s${i}`, stop.event]));
  const plan = planDay({
    dayStart: win[0],
    dayEnd: win[1],
    busyRanges: busyOf(events, travel),
    sequence,
    flexible,
    travelMin: (a, b) => travelBetween(located.get(a), located.get(b))?.minutes ?? null,
  });
  if (plan.placements.length === 0) return events;

  const added: ScheduledEvent[] = [];
  for (const p of plan.placements) {
    const { stop } = byKey.get(p.key)!;
    const { travelFromPrev: _stale, ...template } = stop.event;
    added.push({
      ...template,
      id: template.id || freshId(),
      startTime: toTime(p.startMin),
      endTime: toTime(p.endMin),
      plannedDurationMin: p.durationMin,
    });
    const at = pool.indexOf(stop);
    if (at >= 0) pool.splice(at, 1);
  }
  return [...events, ...added].sort(byStart);
}

const isMealOfAny = (e: ScheduledEvent) => e.category === 'restaurant' && !!parseStop(e).meal;

/** Same content, ids and measured travel aside. */
function sameDay(a: ScheduledEvent[] | undefined, b: ScheduledEvent[] | undefined): boolean {
  if (!a || !b) return a === b;
  const sig = (events: ScheduledEvent[]) =>
    JSON.stringify([...events].map(({ travelFromPrev: _t, ...rest }) => rest).sort((x, y) => byStart(x, y) || x.title.localeCompare(y.title)));
  return sig(a) === sig(b);
}

const validIso = (s: string | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
