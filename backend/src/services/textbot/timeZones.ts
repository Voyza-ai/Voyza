import { getCityCountry } from '../../data/cityCountries';

/**
 * City → IANA time zone, for nudges that depend on local time (leave-now,
 * quiet hours, "today"). Deliberately conservative: a city we can't place
 * returns null and every time-based nudge for it is SKIPPED rather than sent
 * at a guessed hour.
 *
 * Single-zone countries map by country code (data/cityCountries.ts); the big
 * multi-zone countries map by city.
 */

const BY_COUNTRY: Record<string, string> = {
  IT: 'Europe/Rome', FR: 'Europe/Paris', ES: 'Europe/Madrid', GB: 'Europe/London', UK: 'Europe/London',
  DE: 'Europe/Berlin', NL: 'Europe/Amsterdam', BE: 'Europe/Brussels', CH: 'Europe/Zurich',
  AT: 'Europe/Vienna', CZ: 'Europe/Prague', PL: 'Europe/Warsaw', HU: 'Europe/Budapest',
  HR: 'Europe/Zagreb', GR: 'Europe/Athens', IE: 'Europe/Dublin', DK: 'Europe/Copenhagen',
  SE: 'Europe/Stockholm', NO: 'Europe/Oslo', FI: 'Europe/Helsinki', IS: 'Atlantic/Reykjavik',
  TR: 'Europe/Istanbul', MA: 'Africa/Casablanca', EG: 'Africa/Cairo', AE: 'Asia/Dubai',
  IL: 'Asia/Jerusalem', JO: 'Asia/Amman', IN: 'Asia/Kolkata', TH: 'Asia/Bangkok',
  VN: 'Asia/Ho_Chi_Minh', KH: 'Asia/Phnom_Penh', SG: 'Asia/Singapore', MY: 'Asia/Kuala_Lumpur',
  JP: 'Asia/Tokyo', KR: 'Asia/Seoul', CN: 'Asia/Shanghai', HK: 'Asia/Hong_Kong', TW: 'Asia/Taipei',
  PH: 'Asia/Manila', NZ: 'Pacific/Auckland', PE: 'America/Lima', CO: 'America/Bogota',
  AR: 'America/Argentina/Buenos_Aires', CR: 'America/Costa_Rica', CU: 'America/Havana',
  SI: 'Europe/Ljubljana', SK: 'Europe/Bratislava', RO: 'Europe/Bucharest', BG: 'Europe/Sofia',
  ME: 'Europe/Podgorica', MT: 'Europe/Malta', LU: 'Europe/Luxembourg', MC: 'Europe/Monaco',
  ZA: 'Africa/Johannesburg', KE: 'Africa/Nairobi', TZ: 'Africa/Dar_es_Salaam',
};

/** Multi-zone countries (US, CA, AU, MX, BR, …) and common home cities. */
const BY_CITY: Record<string, string> = {
  'new york': 'America/New_York', 'nyc': 'America/New_York', 'philadelphia': 'America/New_York',
  'boston': 'America/New_York', 'washington': 'America/New_York', 'washington dc': 'America/New_York',
  'miami': 'America/New_York', 'atlanta': 'America/New_York', 'orlando': 'America/New_York',
  'charlotte': 'America/New_York', 'pittsburgh': 'America/New_York', 'baltimore': 'America/New_York',
  'detroit': 'America/Detroit', 'newark': 'America/New_York', 'raleigh': 'America/New_York',
  'tampa': 'America/New_York', 'toronto': 'America/Toronto', 'montreal': 'America/Toronto',
  'ottawa': 'America/Toronto',
  'chicago': 'America/Chicago', 'dallas': 'America/Chicago', 'houston': 'America/Chicago',
  'austin': 'America/Chicago', 'san antonio': 'America/Chicago', 'minneapolis': 'America/Chicago',
  'nashville': 'America/Chicago', 'new orleans': 'America/Chicago', 'st. louis': 'America/Chicago',
  'kansas city': 'America/Chicago', 'mexico city': 'America/Mexico_City', 'winnipeg': 'America/Winnipeg',
  'denver': 'America/Denver', 'salt lake city': 'America/Denver', 'calgary': 'America/Edmonton',
  'phoenix': 'America/Phoenix',
  'los angeles': 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', 'seattle': 'America/Los_Angeles',
  'san diego': 'America/Los_Angeles', 'portland': 'America/Los_Angeles', 'las vegas': 'America/Los_Angeles',
  'san jose': 'America/Los_Angeles', 'vancouver': 'America/Vancouver',
  'honolulu': 'Pacific/Honolulu', 'anchorage': 'America/Anchorage',
  'cancun': 'America/Cancun', 'sydney': 'Australia/Sydney', 'melbourne': 'Australia/Melbourne',
  'brisbane': 'Australia/Brisbane', 'perth': 'Australia/Perth', 'rio de janeiro': 'America/Sao_Paulo',
  'sao paulo': 'America/Sao_Paulo', 'lisbon': 'Europe/Lisbon', 'porto': 'Europe/Lisbon',
  'madeira': 'Atlantic/Madeira', 'santiago': 'America/Santiago', 'bali': 'Asia/Makassar',
  'jakarta': 'Asia/Jakarta', 'moscow': 'Europe/Moscow',
};

export function timeZoneForCity(city: string | null | undefined, country?: string | null): string | null {
  if (!city) return null;
  const key = city.trim().toLowerCase();
  if (BY_CITY[key]) return BY_CITY[key];
  const cc = (getCityCountry(city) ?? '').toUpperCase();
  if (cc && BY_COUNTRY[cc]) return BY_COUNTRY[cc];
  const byName = country ? COUNTRY_NAMES[country.trim().toLowerCase()] : undefined;
  return byName ?? null;
}

const COUNTRY_NAMES: Record<string, string> = {
  italy: 'Europe/Rome', france: 'Europe/Paris', spain: 'Europe/Madrid', 'united kingdom': 'Europe/London',
  england: 'Europe/London', germany: 'Europe/Berlin', netherlands: 'Europe/Amsterdam', japan: 'Asia/Tokyo',
  greece: 'Europe/Athens', switzerland: 'Europe/Zurich', austria: 'Europe/Vienna', ireland: 'Europe/Dublin',
  'czech republic': 'Europe/Prague', czechia: 'Europe/Prague', croatia: 'Europe/Zagreb', thailand: 'Asia/Bangkok',
  'south korea': 'Asia/Seoul', iceland: 'Atlantic/Reykjavik', belgium: 'Europe/Brussels', hungary: 'Europe/Budapest',
};

/** Offset (ms) of `tz` from UTC at instant `utcMs`. */
function offsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Local "YYYY-MM-DD" + "HH:MM" in `tz` → UTC epoch ms (DST-correct). */
export function zonedToUtc(date: string, time: string, tz: string): number | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!d || !t) return null;
  const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}

/** UTC instant → local { date: "YYYY-MM-DD", hour, minute } in `tz`. */
export function localParts(utcMs: number, tz: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(utcMs));
  const v = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${v('year')}-${v('month')}-${v('day')}`, hour: Number(v('hour')), minute: Number(v('minute')) };
}
