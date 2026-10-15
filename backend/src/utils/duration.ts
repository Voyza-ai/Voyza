/**
 * ISO 8601 duration → total minutes. Strict: returns null for anything that
 * isn't an ISO duration, so callers can tell "not this format" and "unknown"
 * apart from a real zero.
 *
 * This is the format providers speak. Duffel puts one on every offer slice
 * and segment (`duration: "PT7H35M"`), and preferring it over subtracting
 * timestamps avoids the whole timezone problem — the airline already did the
 * arithmetic.
 *
 * Accepts:
 *   - "PT7H35M"    → 455
 *   - "PT45M"      → 45
 *   - "PT7H"       → 420
 *   - "P1DT2H30M"  → 1590  (days are real: overnight-layover itineraries)
 *   - "P1D"        → 1440
 *   - "PT1H30M0S"  → 90
 *   - "3h 37m"     → null  (not ISO — parseDurationMinutes handles it)
 *
 * Year and month designators are rejected rather than guessed at: "P1M" is
 * calendar-ambiguous, and no flight or train is ever a month long.
 */
const ISO_DURATION =
  /^([+-])?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

export function parseIsoDuration(input: string | null | undefined): number | null {
  if (!input) return null;
  const match = ISO_DURATION.exec(String(input).trim());
  if (!match) return null;

  const [, sign, years, months, weeks, days, hours, minutes, seconds] = match;

  // "P" on its own matches the pattern but carries no duration at all.
  if (!years && !months && !weeks && !days && !hours && !minutes && !seconds) {
    return null;
  }
  // Calendar-ambiguous — can't be converted to minutes without a start date.
  if (years || months) return null;

  const total =
    (weeks ? Number(weeks) * 7 * 24 * 60 : 0) +
    (days ? Number(days) * 24 * 60 : 0) +
    (hours ? Number(hours) * 60 : 0) +
    (minutes ? Number(minutes) : 0) +
    (seconds ? Number(seconds) / 60 : 0);

  return sign === '-' ? -Math.round(total) : Math.round(total);
}

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
 *   - "PT7H35M" → 455  (ISO 8601, straight from a provider payload)
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

  // ISO 8601 first. The hours+minutes regex below happens to read "PT7H35M"
  // correctly by accident, but it silently drops the day part ("P1DT2H30M"
  // came out as 150 instead of 1590) and misses minute-only forms entirely
  // ("PT45M" → 0). Handle the format properly instead of relying on luck.
  const iso = parseIsoDuration(s);
  if (iso != null) return Math.max(0, iso);

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
