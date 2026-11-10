import type { AutoTransportRole, City, ScheduledEvent, Trip } from './types';
import { buildDayTransportContext } from './dayScheduleDefaults';

/**
 * Keep a day's generated travel blocks in step with the trip's transport.
 *
 * The flowchart reads `transportIn` / `transportOut` (and the home legs)
 * live, but a day's schedule is a saved list of events: once built, its
 * "Head to the airport" / flight / "Arrive at" blocks used to keep the
 * times of whatever flight was picked when the day was first opened. This
 * module re-derives those blocks from the current transport and swaps them
 * in, leaving everything else on the day alone.
 *
 * Rules:
 *   - Only generated blocks are rewritten: `auto: true`, or legacy blocks
 *     saved before the flag existed that still look generated (category
 *     'transport', a generator title, and — for the head-to / arrive
 *     blocks, whose length is fixed — the generator's length).
 *   - A block the user moved or edited (`auto: false`) is honoured: it
 *     stays where they put it, and its slot (`autoRole`) is not generated
 *     a second time.
 *   - Restaurants, activities and user-added events are never touched.
 *   - Unchanged days return `null`, so callers can skip the store write
 *     (and the re-render loop a write would start).
 */

const HEAD_TO = /^head to\s/i;
const TRAVEL = /^(flight|train|bus)\s.+\s→\s.+/i;
const ARRIVE = /^arrive at\s/i;

/** Every buffer `buildDayTransportContext` puts before a departure. */
const HEAD_TO_MINUTES = new Set([120, 30, 15, 60]);
const ARRIVE_MINUTES = 15;

const toMin = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
};

type LegacyKind = 'head' | 'travel' | 'arrive';

const legacyKind = (e: ScheduledEvent): LegacyKind | null => {
  if (e.auto !== undefined || e.category !== 'transport') return null;
  if (HEAD_TO.test(e.title)) return 'head';
  if (ARRIVE.test(e.title)) return 'arrive';
  if (TRAVEL.test(e.title)) return 'travel';
  return null;
};

/**
 * Does a legacy block still have the shape the generator gave it? A
 * "Head to" spans one of the fixed buffers (or was clamped to midnight);
 * an "Arrive at" is 15 minutes (or clamped to 24:00). A flight / train
 * block's length comes from the carrier, so it cannot be checked and is
 * taken as generated.
 */
const legacyLooksGenerated = (e: ScheduledEvent, kind: LegacyKind): boolean => {
  const len = toMin(e.endTime) - toMin(e.startTime);
  if (kind === 'head') return HEAD_TO_MINUTES.has(len) || e.startTime === '00:00';
  if (kind === 'arrive') return len === ARRIVE_MINUTES || e.endTime === '24:00';
  return true;
};

/**
 * The slot a legacy block fills. "Arrive at" is always inbound. A head-to
 * or travel block is inbound or outbound by which side of the day the
 * generator would put it on now; with both (a same-day in-and-out), the
 * nearer fresh block of the same kind decides.
 */
const legacyRole = (
  e: ScheduledEvent,
  kind: LegacyKind,
  fresh: ScheduledEvent[],
): AutoTransportRole => {
  if (kind === 'arrive') return 'in-arrive';
  const inRole: AutoTransportRole = kind === 'head' ? 'in-head' : 'in-travel';
  const outRole: AutoTransportRole = kind === 'head' ? 'out-head' : 'out-travel';
  const inFresh = fresh.find((f) => f.autoRole === inRole);
  const outFresh = fresh.find((f) => f.autoRole === outRole);
  if (inFresh && !outFresh) return inRole;
  if (outFresh && !inFresh) return outRole;
  if (inFresh && outFresh) {
    const at = toMin(e.startTime);
    return Math.abs(toMin(inFresh.startTime) - at) <= Math.abs(toMin(outFresh.startTime) - at)
      ? inRole
      : outRole;
  }
  return inRole;
};

/** Content of a day, ids aside, in start order — for the no-change check. */
const signature = (events: ScheduledEvent[]): string =>
  JSON.stringify(
    [...events]
      .map(({ id: _id, ...rest }) => rest)
      .sort((a, b) => toMin(a.startTime) - toMin(b.startTime) || a.title.localeCompare(b.title)),
  );

const byStart = (a: ScheduledEvent, b: ScheduledEvent) => toMin(a.startTime) - toMin(b.startTime);

/**
 * Reconcile one day's events against freshly generated travel blocks.
 * Pure: `fresh` is `buildDayTransportContext(...).events`. Returns the new
 * day, or `null` when nothing would change.
 */
export function reconcileDayEvents(
  existing: ScheduledEvent[],
  fresh: ScheduledEvent[],
): ScheduledEvent[] | null {
  const kept: ScheduledEvent[] = [];
  const claimed = new Set<AutoTransportRole>();
  const idByRole = new Map<AutoTransportRole, string>();

  for (const e of existing) {
    if (e.auto === true) {
      if (e.autoRole && !idByRole.has(e.autoRole)) idByRole.set(e.autoRole, e.id);
      continue; // replaced by its fresh counterpart below
    }
    if (e.auto === false) {
      if (e.autoRole) claimed.add(e.autoRole);
      kept.push(e);
      continue;
    }
    const kind = legacyKind(e);
    if (!kind) {
      kept.push(e); // activity, restaurant, user-added
      continue;
    }
    const role = legacyRole(e, kind, fresh);
    if (legacyLooksGenerated(e, kind)) {
      if (!idByRole.has(role)) idByRole.set(role, e.id);
      continue;
    }
    // A legacy block the user already reshaped: keep it, as theirs.
    claimed.add(role);
    kept.push({ ...e, auto: false, autoRole: role });
  }

  const regenerated = fresh
    .filter((f) => !f.autoRole || !claimed.has(f.autoRole))
    .map((f) => {
      const id = f.autoRole ? idByRole.get(f.autoRole) : undefined;
      return id ? { ...f, id } : f;
    });

  const next = [...kept, ...regenerated].sort(byStart);
  return signature(next) === signature(existing) ? null : next;
}

/**
 * Reconcile the day `date` on `trip.cities[cityIndex]` with that city's
 * current transport. `null` when the day has no schedule yet (the lazy
 * build will generate it fresh) or nothing changed.
 */
export function reconcileDayTransport(
  trip: Trip,
  cityIndex: number,
  date: string,
): ScheduledEvent[] | null {
  const city: City | undefined = trip.cities[cityIndex];
  const existing = city?.schedule?.[date];
  if (!city || !existing) return null;
  const { events: fresh } = buildDayTransportContext(city, date, trip, cityIndex);
  return reconcileDayEvents(existing, fresh);
}

/**
 * Reconcile every scheduled day of every city. Used after a transport swap
 * so days the planner is not showing (and the persisted session) are right
 * too. Returns the same trip object when nothing changed.
 */
export function reconcileTripTransport(trip: Trip): Trip {
  let cities: City[] | null = null;
  trip.cities.forEach((city, i) => {
    if (!city.schedule) return;
    let schedule: Record<string, ScheduledEvent[]> | null = null;
    for (const date of Object.keys(city.schedule)) {
      const next = reconcileDayTransport(trip, i, date);
      if (!next) continue;
      schedule = schedule ?? { ...city.schedule };
      schedule[date] = next;
    }
    if (schedule) {
      cities = cities ?? [...trip.cities];
      cities[i] = { ...city, schedule };
    }
  });
  return cities ? { ...trip, cities } : trip;
}

/**
 * The fields a user edit can change on a generated block. Touching any of
 * them makes the block the user's: it loses `auto` and is not snapped back.
 */
const EDIT_FIELDS: Array<keyof ScheduledEvent> = ['startTime', 'endTime', 'title'];

/** Apply a user edit to an event, dropping `auto` when it reshapes a generated block. */
export function applyUserEdit(e: ScheduledEvent, updates: Partial<ScheduledEvent>): ScheduledEvent {
  const next = { ...e, ...updates };
  if (e.auto === true && !('auto' in updates)) {
    const changed = EDIT_FIELDS.some((k) => k in updates && updates[k] !== e[k]);
    if (changed) next.auto = false;
  }
  return next;
}
