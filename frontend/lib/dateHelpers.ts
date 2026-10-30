/**
 * Date helpers for trip rendering.
 *
 * Why local-time parsing: the trip stores arrival/departure as bare
 * `YYYY-MM-DD` strings (no timezone). Passing those through `new Date(iso)`
 * interprets them as UTC midnight, which then renders as the *previous*
 * day in any timezone west of UTC. Splitting into Y/M/D and constructing
 * a local Date keeps "June 14" displaying as June 14 everywhere.
 *
 * Originally inlined inside `components/results/CalendarView.tsx`. Lifted
 * here so the new ScheduleView can share the same semantics — drift
 * between the two views would silently mis-place events on month-boundary
 * trips.
 */

/** Parse an ISO `YYYY-MM-DD` date string as local-time midnight. */
export const parseLocal = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

/** Format a Date as `YYYY-MM-DD` using its local-time year/month/day. */
export const toIso = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** Whole calendar days between two dates (b - a). Negative if b < a. */
export const daysBetween = (a: Date, b: Date): number =>
  Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const monthDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

/** "Jan 10, 2027": the results header's "Jan 10", with its year. */
export function humanDay(iso: string): string {
  return ISO_DAY.test(iso) ? `${monthDay(iso)}, ${iso.slice(0, 4)}` : iso;
}

/** "Jan 10 – Jan 17, 2027" — both ends, the year once, or on each end
 *  when they differ ("Dec 28, 2026 – Jan 4, 2027"). */
export function humanDayRange(start: string, end: string): string {
  if (!ISO_DAY.test(start) || !ISO_DAY.test(end)) return start;
  return start.slice(0, 4) === end.slice(0, 4)
    ? `${monthDay(start)} – ${monthDay(end)}, ${end.slice(0, 4)}`
    : `${humanDay(start)} – ${humanDay(end)}`;
}

/**
 * A trip duration in minutes as people write it: "53m", "2h", "2h 5m".
 * Never "0h 53m" (leg pills after a re-price used to read that) and never a
 * trailing space.
 */
export function formatMinutes(mins: number): string {
  const total = Math.max(0, Math.round(mins));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
