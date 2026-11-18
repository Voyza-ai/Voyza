import type { City, ScheduledEvent, UnscheduledItem } from './types';
import { DAY_CLOSE_MIN, DAY_OPEN_MIN, planDay } from './dayScheduleDefaults';
import { parseLocal, toIso } from './dateHelpers';
import { parseStop } from './stayRelay';

/**
 * Placing a dinner plan (ScheduledEvent.dinner) on a day. Pure, and free of
 * scheduleSync so the sync can use it without an import cycle.
 */

const toMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};
const toTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const spanOf = (e: ScheduledEvent): [number, number] => {
  const s = toMin(e.startTime);
  const end = toMin(e.endTime);
  return [s, end < s ? 24 * 60 : end];
};
const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];

export const isDinner = (e: ScheduledEvent): boolean => !!e.dinner;

/** A stop the planner placed and nobody reshaped (same rule as scheduleSync.isPlannedStop). */
const planned = (e: ScheduledEvent) =>
  (e.category === 'activity' || e.category === 'restaurant') &&
  typeof e.plannedDurationMin === 'number' &&
  spanOf(e)[1] - spanOf(e)[0] === e.plannedDurationMin;

/** The nights of a stay: arrival up to (not including) departure. */
export function stayNights(city: Pick<City, 'dates'>): string[] {
  const { arrival, departure } = city.dates ?? ({} as City['dates']);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(departure ?? '')) return [];
  const out: string[] = [];
  const end = parseLocal(departure);
  for (let d = parseLocal(arrival); d < end && out.length < 400; d.setDate(d.getDate() + 1)) out.push(toIso(d));
  return out;
}

/** The night nearest `day`; a later one on a tie. Same rule as backend services/dinner.ts nearestNight. */
export function nearestNight(nights: string[], day: string): string | null {
  if (nights.length === 0) return null;
  const t = (s: string) => parseLocal(s).getTime();
  return [...nights].sort((a, b) => Math.abs(t(a) - t(day)) - Math.abs(t(b) - t(day)) || (a < b ? 1 : -1))[0];
}

/**
 * The night a dinner sits on after its stay's dates change. A stay that moved
 * wholesale — the same number of nights on new dates, as when the cities are
 * reordered or an earlier city changes length — takes its dinner with it to
 * the same night of the stay: the second night in Paris stays the second
 * night. Otherwise the dinner keeps its date while the stay still has that
 * night, and moves to the nearest night it has when not. Same rule as
 * backend services/dinner.ts dinnerNightAfter.
 */
export function dinnerNightAfter(oldNights: string[] | null, nights: string[], day: string): string | null {
  if (nights.length === 0) return null;
  if (oldNights && oldNights.length === nights.length && oldNights[0] !== nights[0]) {
    const i = oldNights.indexOf(day);
    if (i >= 0) return nights[i];
  }
  return nights.includes(day) ? day : nearestNight(nights, day);
}

/**
 * `dinner` put on a day's events. It takes the place of the dinner the
 * planner had put on that evening; a planned activity it overlaps moves to
 * the free time nearest it that day, or — when the day has none — is
 * returned in `dropped`, to be listed as unscheduled rather than lost. The
 * traveller's own blocks are left as they are.
 */
export function insertDinner(
  events: ScheduledEvent[],
  dinner: ScheduledEvent,
  date: string | null = null,
): { events: ScheduledEvent[]; dropped: UnscheduledItem[] } {
  const span = spanOf(dinner);
  const rest = events.filter((e) => e.id !== dinner.id);
  const keep: ScheduledEvent[] = [];
  const bump: ScheduledEvent[] = [];
  for (const e of rest) {
    if (!planned(e) || isDinner(e)) {
      keep.push(e);
      continue;
    }
    const s = spanOf(e);
    const hits = overlaps(s, span);
    const eveningMeal = e.category === 'restaurant' && s[0] >= 17 * 60 && (hits || !!parseStop(e).meal);
    if (eveningMeal) continue; // the evening's planned dinner: this dinner replaces it
    if (hits) bump.push(e);
    else keep.push(e);
  }
  const dropped: UnscheduledItem[] = [];
  let out = [...keep, dinner];
  for (const e of bump) {
    const busy = out.map(spanOf);
    const len = spanOf(e)[1] - spanOf(e)[0];
    const plan = planDay({
      dayStart: DAY_OPEN_MIN,
      dayEnd: DAY_CLOSE_MIN,
      busyRanges: busy,
      sequence: [],
      flexible: [{ key: 'x', durationMin: len, earliestStart: DAY_OPEN_MIN, latestEnd: DAY_CLOSE_MIN, idealStart: spanOf(e)[0] }],
    });
    const p = plan.placements[0];
    if (p) {
      const { travelFromPrev: _stale, ...moved } = e;
      out.push({ ...moved, startTime: toTime(p.startMin), endTime: toTime(p.endMin) });
    } else {
      dropped.push({ title: parseStop(e).name, kind: e.category === 'restaurant' ? 'restaurant' : 'activity', durationMin: len, date });
    }
  }
  out = out.sort((a, b) => toMin(a.startTime) - toMin(b.startTime));
  return { events: out, dropped };
}

/** Every dinner on a city's schedule with the night it sits on, in date order. */
export function cityDinners(city: City): Array<{ date: string; event: ScheduledEvent }> {
  const out: Array<{ date: string; event: ScheduledEvent }> = [];
  for (const [date, events] of Object.entries(city.schedule ?? {})) for (const e of events) if (isDinner(e)) out.push({ date, event: e });
  return out.sort((a, b) => (a.date + a.event.startTime).localeCompare(b.date + b.event.startTime));
}

/** "Tue, Dec 15" */
export const nightLabel = (iso: string) =>
  parseLocal(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
/** "7:30 PM" */
export function timeLabel(t: string): string {
  const m = toMin(t);
  const h = Math.floor(m / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
