import type { Trip } from '@/lib/types';
import { useTripStore } from '@/store/tripStore';
import stored from '@/data/demoTrips.json';

/**
 * Demo trips: real searches, stored, that open on /results at once.
 *
 * Each one is the exact trip a live "Find my trip" search put on the results
 * page (flights, trains, hotels and home flights, every price as the APIs
 * answered it on `capturedAt`), committed as data/demoTrips.json. Opening one
 * asks no API: the trip goes straight into the store, and /results has
 * nothing to backfill because every hotel list and home flight is already
 * there. Nothing is written to the database; saving it is the traveller's
 * own choice, as with any planned trip.
 *
 * Prices are as of `capturedAt` and are labelled so. Dates are kept when they
 * are still comfortably ahead; once a trip would start within
 * MIN_LEAD_DAYS, every date in it moves forward by whole weeks (weekdays,
 * and so the train and flight times, stay true to the search).
 */

export type DemoTrip = {
  slug: string;
  title: string;
  /** The cities as searched — for matching a live search to its demo. */
  cities: string[];
  /** ISO date the search ran: what the prices are "as of". */
  capturedAt: string;
  trip: Trip;
};

export const DEMO_TRIPS: DemoTrip[] = stored as unknown as DemoTrip[];

export const MIN_LEAD_DAYS = 14;
/** Where a shifted trip lands: at least this many days out. */
export const SHIFTED_LEAD_DAYS = 28;

const DAY_MS = 86_400_000;
// Not inside a longer number — but a date right after a URL-encoded space
// ("…%20on%202026-12-20" in a flight search link) is still a date.
const ISO_DATE = /(?<=^|\D|%20)\d{4}-\d{2}-\d{2}(?!\d)/g;

const parseIso = (iso: string): number | null => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso ? t : null;
};
const toIso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Local calendar date, as the planner's date pickers read "today". */
export function localTodayIso(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Every YYYY-MM-DD in a string moved by `days` (non-dates left alone). */
function shiftInString(s: string, days: number): string {
  return s.replace(ISO_DATE, (m) => {
    const t = parseIso(m);
    return t === null ? m : toIso(t + days * DAY_MS);
  });
}

/**
 * A deep copy of `value` with every calendar date in it moved by `days`:
 * string values (stay dates, flight dates, the date inside a booking link)
 * and object keys (a city's schedule is keyed by day).
 */
export function shiftDatesDeep<T>(value: T, days: number): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return days === 0 ? v : shiftInString(v, days);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) out[days === 0 ? k : shiftInString(k, days)] = walk(inner);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** The earliest calendar date anywhere in the trip: its first travel day. */
export function earliestDate(trip: Trip): string | null {
  let min: string | null = null;
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.match(ISO_DATE) ?? []) if (parseIso(m) !== null && (!min || m < min)) min = m;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk({ cities: trip.cities.map((c) => c.dates), origin: trip.origin });
  return min;
}

/**
 * Days to move a demo trip so it starts at least MIN_LEAD_DAYS from today:
 * 0 while it does, else the fewest whole weeks that put it SHIFTED_LEAD_DAYS
 * or more ahead.
 */
export function demoShiftDays(firstDate: string, todayIso: string): number {
  const first = parseIso(firstDate);
  const today = parseIso(todayIso);
  if (first === null || today === null) return 0;
  const lead = Math.round((first - today) / DAY_MS);
  if (lead >= MIN_LEAD_DAYS) return 0;
  return 7 * Math.ceil((SHIFTED_LEAD_DAYS - lead) / 7);
}

/** The trip to open for a demo today: a fresh copy, dates moved if stale. */
export function demoTripForToday(demo: DemoTrip, todayIso: string = localTodayIso()): Trip {
  const first = earliestDate(demo.trip);
  const days = first ? demoShiftDays(first, todayIso) : 0;
  const trip = shiftDatesDeep(demo.trip, days);
  // Never a saved trip and never an AI-picks run: nothing to persist to and
  // nothing to wait for.
  const { id: _id, picksRun: _run, ...rest } = trip as Trip & { picksRun?: string };
  return rest as Trip;
}

const cityKey = (names: string[]) =>
  names
    .map((n) => n.trim().toLowerCase())
    .sort()
    .join('|');

/** The demo trip for this set of cities (any order), if there is one. */
export function demoTripFor(cities: string[] | undefined | null): DemoTrip | null {
  if (!cities || cities.length === 0) return null;
  const key = cityKey(cities);
  return DEMO_TRIPS.find((d) => cityKey(d.cities) === key) ?? null;
}

export function getDemoTrip(slug: string): DemoTrip | null {
  return DEMO_TRIPS.find((d) => d.slug === slug) ?? null;
}

/** "Nov 15" for the "prices as of" label. */
export function capturedLabel(iso: string): string {
  const t = parseIso(iso);
  if (t === null) return iso;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Put a demo trip on screen and go to /results. Synchronous apart from the
 * navigation: no request is made.
 */
export function openDemoTrip(demo: DemoTrip, navigate: (href: string) => void): void {
  const trip = demoTripForToday(demo);
  const store = useTripStore.getState();
  store.resetPlanning();
  useTripStore.setState({ currentTrip: trip, tripPicks: null });
  navigate('/results');
}
