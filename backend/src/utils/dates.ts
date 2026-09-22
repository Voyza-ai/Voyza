/**
 * UTC-safe helpers for the bare YYYY-MM-DD strings the flight/train/hotel
 * APIs and the trips tables all speak.
 *
 * Why this file exists: `new Date('2026-03-05')` parses as UTC midnight,
 * but `setDate` / `getDate` / `setHours` work in the SERVER's local zone.
 * Mixing the two silently drops or gains a day whenever the local offset
 * changes across the span. Measured on the optimizer's old copies under
 * TZ=America/New_York (a dev laptop):
 *
 *   addDays('2026-03-05', 10)  → 2026-03-14   (want 03-15; DST starts 03-08)
 *   clampToFuture(<today>)     → tomorrow     (today read as "past")
 *   dates cursor, nights [3,2,2] from 03-05
 *                              → 2nd city got ONE night (03-08 → 03-09)
 *
 * and under TZ=Asia/Kolkata clampToFuture(<yesterday>) returned TODAY, not
 * tomorrow. Production (Railway) runs UTC, where all of it happens to be
 * right, so these only bit locally — until someone sets TZ. Everything
 * here is pure UTC arithmetic, independent of process.env.TZ.
 */

const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
const MS_PER_DAY = 86_400_000;

/** Today's date in UTC as YYYY-MM-DD. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Advance (or rewind, for negative `days`) a YYYY-MM-DD date without
 * mutating the input. A full timestamp is accepted and truncated to its
 * date part; anything else is returned unchanged rather than thrown, since
 * callers pass user- and AI-supplied dates and an exception here would
 * abort a whole optimize run.
 */
export function addDays(iso: string, days: number): string {
  const match = ISO_DATE_PREFIX.exec(iso ?? '');
  if (!match) return iso;
  const [, y, m, d] = match;
  const shifted = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)) + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Ensure a date is not in the past. Flight/train APIs return empty results
 * (or outright errors) for past dates, so when the user's chosen start date
 * + per-leg offset lands before today (UTC) we shift it to tomorrow to keep
 * the optimizer running instead of silently failing with zero-cost legs.
 * A date that IS today is left alone — same-day departures are legitimate.
 */
export function clampToFuture(iso: string): string {
  const today = todayIso();
  if (iso < today) return addDays(today, 1);
  return iso;
}
