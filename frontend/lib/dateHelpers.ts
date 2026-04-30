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
