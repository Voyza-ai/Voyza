/**
 * Parse freeform date input from the planning chat into a strict YYYY-MM-DD
 * string the backend optimizer will accept. Designed to be forgiving —
 * anything unrecognized falls back to "a month from now" so we never trip
 * the zod regex and crash the flow.
 *
 * Handles:
 *   - "2026-06-15"            → passthrough
 *   - "June 15, 2026"         → 2026-06-15
 *   - "June 2026"             → 2026-06-01 (first of that month)
 *   - "next week"             → today + 7
 *   - "next month"            → today + 30
 *   - "tomorrow"              → today + 1
 *   - "in 2 weeks"            → today + 14
 *   - "April 7-30"            → YYYY-04-07 (current or next year)
 *   - "summer"                → July 1 of current/next year
 *   - anything else           → today + 30
 */

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};

const SEASONS: Record<string, number> = {
  spring: 3, // April
  summer: 6, // July
  fall: 9,   // October
  autumn: 9,
  winter: 0, // January
};

const toISO = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const defaultFallback = (): string => {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return toISO(d);
};

export function parseDateInput(raw: string | undefined | null): string {
  if (!raw) return defaultFallback();
  const input = raw.trim().toLowerCase();
  if (!input) return defaultFallback();

  // Already YYYY-MM-DD
  const isoMatch = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) return input;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Relative phrases
  if (input === 'today' || input === 'now') return toISO(today);
  if (input === 'tomorrow') {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    return toISO(d);
  }
  if (input === 'next week' || input === 'in a week') {
    const d = new Date(today);
    d.setDate(d.getDate() + 7);
    return toISO(d);
  }
  if (input === 'next month' || input === 'in a month') {
    const d = new Date(today);
    d.setDate(d.getDate() + 30);
    return toISO(d);
  }
  if (input === 'next year') {
    const d = new Date(today);
    d.setFullYear(d.getFullYear() + 1);
    return toISO(d);
  }

  // "in 2 weeks", "in 3 days"
  const inMatch = input.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months)$/);
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    const d = new Date(today);
    if (unit.startsWith('day')) d.setDate(d.getDate() + n);
    else if (unit.startsWith('week')) d.setDate(d.getDate() + n * 7);
    else if (unit.startsWith('month')) d.setMonth(d.getMonth() + n);
    return toISO(d);
  }

  // "Month YYYY" — "June 2026"
  const monthYearMatch = input.match(/^(\w+)\s+(\d{4})$/);
  if (monthYearMatch && MONTHS[monthYearMatch[1]] !== undefined) {
    const m = MONTHS[monthYearMatch[1]];
    const y = parseInt(monthYearMatch[2], 10);
    return toISO(new Date(y, m, 1));
  }

  // "Month Day, YYYY" — "June 15, 2026" or "June 15 2026"
  const fullMatch = input.match(/^(\w+)\s+(\d{1,2})(?:,)?\s+(\d{4})$/);
  if (fullMatch && MONTHS[fullMatch[1]] !== undefined) {
    const m = MONTHS[fullMatch[1]];
    const day = parseInt(fullMatch[2], 10);
    const y = parseInt(fullMatch[3], 10);
    return toISO(new Date(y, m, day));
  }

  // "Month Day" — "June 15" (assume current year, or next year if past)
  const monthDayMatch = input.match(/^(\w+)\s+(\d{1,2})/);
  if (monthDayMatch && MONTHS[monthDayMatch[1]] !== undefined) {
    const m = MONTHS[monthDayMatch[1]];
    const day = parseInt(monthDayMatch[2], 10);
    const currentYear = today.getFullYear();
    const candidate = new Date(currentYear, m, day);
    if (candidate < today) candidate.setFullYear(currentYear + 1);
    return toISO(candidate);
  }

  // Just "Month" — "April", "July"
  if (MONTHS[input] !== undefined) {
    const m = MONTHS[input];
    const currentYear = today.getFullYear();
    const candidate = new Date(currentYear, m, 1);
    if (candidate < today) candidate.setFullYear(currentYear + 1);
    return toISO(candidate);
  }

  // Season — "summer", "winter"
  if (SEASONS[input] !== undefined) {
    const m = SEASONS[input];
    const currentYear = today.getFullYear();
    const candidate = new Date(currentYear, m, 1);
    if (candidate < today) candidate.setFullYear(currentYear + 1);
    return toISO(candidate);
  }

  // Last resort: try native Date constructor — works for many formats.
  const native = new Date(raw);
  if (!Number.isNaN(native.getTime())) return toISO(native);

  return defaultFallback();
}

// ─── Ranges ─────────────────────────────────────────────────────────────────

const MONTH_RE = `(${Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|')})\\.?`;
const DAY_RE = '(\\d{1,2})(?:st|nd|rd|th)?';
const YEAR_RE = '(?:,?\\s*(\\d{4}))?';
const SEP_RE = '\\s*(?:-|–|—|to|through|thru|until|till|til)\\s*';

/** "Jan 10[, 2027] to Jan 17[, 2027]" */
const MD_MD = new RegExp(`^${MONTH_RE}\\s+${DAY_RE}${YEAR_RE}${SEP_RE}${MONTH_RE}\\s+${DAY_RE}${YEAR_RE}$`);
/** "Jan 10-17[, 2027]" */
const MD_D = new RegExp(`^${MONTH_RE}\\s+${DAY_RE}${SEP_RE}${DAY_RE}${YEAR_RE}$`);
/** "10 Jan[ 2027] to 17 Jan[ 2027]" */
const DM_DM = new RegExp(`^${DAY_RE}\\s+${MONTH_RE}${YEAR_RE}${SEP_RE}${DAY_RE}\\s+${MONTH_RE}${YEAR_RE}$`);
/** "10-17 Jan[ 2027]" */
const D_DM = new RegExp(`^${DAY_RE}${SEP_RE}${DAY_RE}\\s+${MONTH_RE}${YEAR_RE}$`);
/** "2027-01-10 to 2027-01-17" */
const ISO_ISO = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})${SEP_RE}(\\d{4})-(\\d{2})-(\\d{2})$`);

/** A real calendar day, or null — `new Date(2027, 1, 30)` silently becomes 2 March. */
const calendarDay = (y: number, m: number, d: number): Date | null => {
  const date = new Date(y, m, d);
  return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? date : null;
};

/**
 * Parse a typed date RANGE into two YYYY-MM-DD strings, or null if the text is
 * not a whole, unambiguous range.
 *
 * `parseDateInput` returns one date, so the planner's typed-dates path stored
 * "Jan 10 to Jan 17, 2027" as a flexible trip starting Jan 10 with no end —
 * the end date silently dropped, and the year with it (the start was "the next
 * Jan 10", so "…, 2028" also started in 2027).
 *
 * Deliberately strict: the WHOLE input must be a range, so a window plus a
 * length ("April 7-30, one week") or anything else is left to the existing
 * single-date path exactly as before. A year given once applies to both ends;
 * written at the end of a range that crosses New Year ("Dec 28 to Jan 4, 2027")
 * it belongs to the end date. With no year, the start is its next occurrence
 * (the rule `parseDateInput` uses) and the end the first date after it. A range
 * that is backwards, empty or names a day that doesn't exist is not a range.
 */
export function parseDateRangeInput(
  raw: string | undefined | null,
): { start: string; end: string } | null {
  const input = (raw ?? '').trim().toLowerCase().replace(/^from\s+/, '');
  if (!input) return null;

  let parts:
    | { m1: number; d1: number; y1?: number; m2: number; d2: number; y2?: number }
    | null = null;
  let m: RegExpMatchArray | null;
  const year = (s: string | undefined) => (s ? parseInt(s, 10) : undefined);

  if ((m = input.match(ISO_ISO))) {
    parts = {
      y1: +m[1], m1: +m[2] - 1, d1: +m[3],
      y2: +m[4], m2: +m[5] - 1, d2: +m[6],
    };
  } else if ((m = input.match(MD_MD))) {
    parts = {
      m1: MONTHS[m[1]], d1: +m[2], y1: year(m[3]),
      m2: MONTHS[m[4]], d2: +m[5], y2: year(m[6]),
    };
  } else if ((m = input.match(MD_D))) {
    parts = { m1: MONTHS[m[1]], d1: +m[2], m2: MONTHS[m[1]], d2: +m[3], y2: year(m[4]) };
  } else if ((m = input.match(DM_DM))) {
    parts = {
      d1: +m[1], m1: MONTHS[m[2]], y1: year(m[3]),
      d2: +m[4], m2: MONTHS[m[5]], y2: year(m[6]),
    };
  } else if ((m = input.match(D_DM))) {
    parts = { d1: +m[1], m1: MONTHS[m[3]], d2: +m[2], m2: MONTHS[m[3]], y2: year(m[4]) };
  }
  if (!parts || parts.m1 === undefined || parts.m2 === undefined) return null;
  const { m1, d1, m2, d2 } = parts;

  // Which ends carry a year decides the other's. Only an earlier MONTH reads
  // as crossing New Year; "Jan 17 to Jan 10" is backwards, not 358 nights.
  const endBeforeStartInYear = m2 < m1;
  let y1: number;
  let y2: number;
  if (parts.y1 !== undefined && parts.y2 !== undefined) {
    y1 = parts.y1;
    y2 = parts.y2;
  } else if (parts.y2 !== undefined) {
    y2 = parts.y2;
    y1 = endBeforeStartInYear ? y2 - 1 : y2;
  } else if (parts.y1 !== undefined) {
    y1 = parts.y1;
    y2 = endBeforeStartInYear ? y1 + 1 : y1;
  } else {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    y1 = today.getFullYear();
    const next = calendarDay(y1, m1, d1);
    if (next && next < today) y1 += 1;
    y2 = endBeforeStartInYear ? y1 + 1 : y1;
  }

  const start = calendarDay(y1, m1, d1);
  const end = calendarDay(y2, m2, d2);
  if (!start || !end || end <= start) return null;
  // The planner clamps a typed night count to 90 (PlanningChat's nights
  // step); a "range" longer than that is a typo, not a trip.
  if (Math.round((end.getTime() - start.getTime()) / 86_400_000) > MAX_RANGE_NIGHTS) return null;
  return { start: toISO(start), end: toISO(end) };
}

const MAX_RANGE_NIGHTS = 90;
