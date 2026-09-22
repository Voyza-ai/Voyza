/**
 * Convert a timestamp that carries NO UTC offset into a real instant, using
 * the tz-database zone it was written in.
 *
 * Why this exists: Duffel's `departing_at` / `arriving_at` are ISO 8601
 * datetimes with no offset and no `Z` — they are LOCAL wall-clock times at
 * each airport. `new Date("2026-06-01T21:00:00")` parses that in the SERVER's
 * zone, so subtracting a departure from an arrival silently ignored the
 * timezone difference between the two airports: NRT 21:00 JST → HNL 09:00 HST
 * came out as -720 minutes instead of 420.
 *
 * The offsets come from real data — Duffel puts the tz-database zone name on
 * every segment's `origin.time_zone` / `destination.time_zone` — so there is
 * no hardcoded offset table here to drift out of date.
 */

/** Matches "Z", "+02:00" or "-0500" at the end of a timestamp. */
const OFFSET_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** True when the timestamp already pins itself to an instant. */
export function hasUtcOffset(timestamp: string): boolean {
  return OFFSET_SUFFIX.test(timestamp.trim());
}

/**
 * The offset (minutes east of UTC) that `timeZone` was observing at the
 * instant `utcMs`. Derived by asking Intl to render that instant as wall
 * clock in the zone and measuring the gap, so DST is handled by ICU rather
 * than by us.
 */
function zoneOffsetMinutes(utcMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));

    const field: Record<string, string> = {};
    for (const { type, value } of parts) field[type] = value;

    const asUtc = Date.UTC(
      Number(field.year),
      Number(field.month) - 1,
      Number(field.day),
      Number(field.hour),
      Number(field.minute),
      Number(field.second),
    );
    if (Number.isNaN(asUtc)) return null;
    return Math.round((asUtc - utcMs) / 60000);
  } catch {
    // Unknown zone name, or an ICU build without tz data.
    return null;
  }
}

/** "2026-06-01T21:00:00" (optionally with fractional seconds) → field parts. */
const NAIVE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * Resolve an offset-free local timestamp to epoch milliseconds in `timeZone`.
 * Returns null when the timestamp isn't parseable or the zone is unknown —
 * callers treat null as "unknown", never as zero.
 *
 * Two passes: the first guesses the offset from the wall-clock reading, the
 * second re-checks it at the corrected instant so a timestamp that lands on
 * a DST change still resolves correctly.
 */
export function localTimestampToEpochMs(
  timestamp: string,
  timeZone: string,
): number | null {
  const m = NAIVE_TIMESTAMP.exec(timestamp.trim());
  if (!m) return null;

  const naiveAsUtc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    m[6] ? Number(m[6]) : 0,
  );
  if (Number.isNaN(naiveAsUtc)) return null;

  let instant = naiveAsUtc;
  for (let pass = 0; pass < 2; pass++) {
    const offset = zoneOffsetMinutes(instant, timeZone);
    if (offset == null) return null;
    const corrected = naiveAsUtc - offset * 60000;
    if (corrected === instant) return instant;
    instant = corrected;
  }
  return instant;
}

/**
 * Elapsed minutes between two timestamps, honouring the zone each one was
 * written in. Timestamps that already carry an offset (or `Z`) are trusted
 * as-is and the zone names are ignored.
 *
 * Returns null — never a negative or zero number — when the inputs can't be
 * resolved to two real instants, so callers can tell "unknown" apart from a
 * genuinely short hop.
 */
export function elapsedMinutesBetween(
  departingAt: string | null | undefined,
  arrivingAt: string | null | undefined,
  departureTimeZone?: string | null,
  arrivalTimeZone?: string | null,
): number | null {
  if (!departingAt || !arrivingAt) return null;

  let departMs: number | null;
  let arriveMs: number | null;

  if (hasUtcOffset(departingAt) && hasUtcOffset(arrivingAt)) {
    departMs = Date.parse(departingAt);
    arriveMs = Date.parse(arrivingAt);
  } else if (departureTimeZone && arrivalTimeZone) {
    departMs = localTimestampToEpochMs(departingAt, departureTimeZone);
    arriveMs = localTimestampToEpochMs(arrivingAt, arrivalTimeZone);
  } else {
    // Offset-free timestamps with no zone to anchor them. Any subtraction
    // here would be the original bug, so report "unknown" instead.
    return null;
  }

  if (departMs == null || arriveMs == null) return null;
  if (Number.isNaN(departMs) || Number.isNaN(arriveMs)) return null;

  const minutes = Math.round((arriveMs - departMs) / 60000);
  return minutes > 0 ? minutes : null;
}
