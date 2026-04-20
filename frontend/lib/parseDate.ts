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
