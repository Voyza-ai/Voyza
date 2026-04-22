/**
 * Parse a freeform duration string into total minutes.
 *
 * The frontend's `buildTripFromOptimize` produces strings like "3h 37m",
 * "15m", or "1h 4m" for transport durations. The old write handler used
 * `parseInt(t.duration)` which grabs only the first number — so "3h 37m"
 * became 3 minutes instead of 217. This caused the transports table to
 * show wildly wrong durations whenever a transport did land.
 *
 * Accepts:
 *   - "3h 37m"  → 217
 *   - "4h"      → 240
 *   - "15m"     → 15
 *   - "102"     → 102  (already a number string)
 *   - 217       → 217  (pass-through for numbers)
 *   - ""        → 0
 *   - undefined → 0
 */
export function parseDurationMinutes(input: string | number | null | undefined): number {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, Math.round(input));
  if (!input) return 0;
  const s = String(input).trim();
  if (!s) return 0;

  // Pure integer string
  if (/^\d+$/.test(s)) return parseInt(s, 10);

  // Hours + minutes form: "3h 37m", "3h37m", "3 h 37 m"
  const match = s.match(/(\d+)\s*h(?:our|rs)?\s*(\d+)?\s*m?/i);
  if (match) {
    const hours = parseInt(match[1], 10);
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    return hours * 60 + minutes;
  }

  // Just minutes: "15m", "15 min", "15 minutes"
  const minOnly = s.match(/^(\d+)\s*m(?:in|inutes?)?$/i);
  if (minOnly) return parseInt(minOnly[1], 10);

  // Just hours: "4h", "4 hours"
  const hoursOnly = s.match(/^(\d+)\s*h(?:our|rs?)?$/i);
  if (hoursOnly) return parseInt(hoursOnly[1], 10) * 60;

  // Fall back to parseInt (same as old behavior) so we don't throw on novel
  // formats. 0 means "unknown" which is safer than a wrong number.
  const fallback = parseInt(s, 10);
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 0;
}
