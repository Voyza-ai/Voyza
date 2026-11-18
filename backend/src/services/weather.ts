/**
 * Weather for the days the traveller is actually in each city — fetched,
 * never invented.
 *
 * Two kinds of data, always labelled:
 *
 *   forecast  MET Norway Locationforecast 2.0 (api.met.no, free, ~9 days
 *             ahead). Their terms ask for an identifying User-Agent and that
 *             a response is not re-fetched before its Expires header.
 *   typical   What those calendar days were like in the last 10 full years:
 *             NASA POWER daily point data (power.larc.nasa.gov, public
 *             domain), averaged over a ±3-day window around each trip date.
 *
 * Why NASA POWER DAILY rather than its climatology endpoint: climatology
 * T2M_MAX is the month's EXTREME (Paris: 14°C in January, 40°C in July), not
 * a typical daily high. Averaging the daily T2M_MAX / T2M_MIN gives real
 * typical highs and lows. Measured 2016–2025 (2026-11-17):
 *   Paris Jan  6.6 / 0.6°C    (Météo-France Paris: ~7 / ~3)
 *   Rome  Jul 33.4 / 21.3°C   (Ciampino: ~31 / ~18)
 *   London Jan 7.0 / 1.3°C    (Met Office: ~8 / ~2)
 * POWER is a ~50 km grid (MERRA-2), so it reads a city's surroundings: lows
 * run 1–3°C under the city centre and inland summer highs a little over.
 * Good for "pack a warm coat", not for a single degree — the replies round
 * and say "about".
 *
 * Open-Meteo was the other candidate: it answered 429 from the cloud's shared
 * IP and its free tier is non-commercial only.
 *
 * Results are cached in memory (forecast: until Expires; typical: 7 days).
 * Nothing is written anywhere.
 */
import { addDays, todayIso } from '../utils/dates';
import { logger } from '../utils/logger';
import { cityGeo } from './routeGeo';

export const WEATHER_USER_AGENT = 'BlueMurr/1.0 https://bluemurr.com';

export type DayWeather = {
  date: string;
  kind: 'forecast' | 'typical';
  /** Daily high / low, °C, one decimal. */
  highC: number;
  lowC: number;
  /** forecast: rain/snow expected that day, mm. */
  precipMm?: number;
  /** forecast: "rain", "partly cloudy", … */
  summary?: string;
  /** typical: share of past years' days in the window with ≥ 1 mm. 0..1 */
  wetDayShare?: number;
  /** typical: where the averages come from. */
  source?: string;
};

export type CityWeather = {
  city: string;
  country: string;
  /** The traveller's days in the city, in order. */
  dates: string[];
  days: DayWeather[];
  /** Dates no source could cover (provider down, or the city couldn't be placed). */
  missing: string[];
  /** Why something is missing, in plain words, when it is. */
  problem?: string;
  /** "2016–2025" when any day is typical. */
  typicalYears?: string;
  /** Where the typical figures come from (station / grid). */
  typicalSources?: string[];
  /** Last day MET Norway's forecast fully covers, when it answered. */
  forecastUntil?: string;
};

type Fetcher = typeof fetch;
let fetcher: Fetcher = (...args) => fetch(...args);
/** Tests replace the network. */
export function setWeatherFetch(f: Fetcher | null): void {
  fetcher = f ?? ((...args) => fetch(...args));
}

// ─── Trip days ───────────────────────────────────────────────────────

/**
 * The dates the traveller is in each city: arrival up to the day before
 * departure (that night's city), and for the LAST city its departure day too
 * (they leave from there). A same-day stop is its one day.
 */
export function tripCityDays(trip: any): Array<{ city: string; country: string; dates: string[] }> {
  const cities: any[] = Array.isArray(trip?.cities) ? trip.cities : [];
  return cities.map((c, i) => {
    const arrival = String(c?.dates?.arrival ?? '').slice(0, 10);
    const departure = String(c?.dates?.departure ?? '').slice(0, 10);
    const dates: string[] = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(arrival)) {
      const last = /^\d{4}-\d{2}-\d{2}$/.test(departure) && departure > arrival
        ? i === cities.length - 1 ? departure : addDays(departure, -1)
        : arrival;
      for (let d = arrival; d <= last && dates.length < 60; d = addDays(d, 1)) dates.push(d);
    }
    return { city: String(c?.name ?? ''), country: String(c?.country ?? ''), dates };
  });
}

// ─── Forecast: MET Norway ────────────────────────────────────────────

type ForecastDay = { date: string; highC: number; lowC: number; precipMm: number; summary: string };
type ForecastResult = { days: Map<string, ForecastDay>; until: string | null };
const forecastCache = new Map<string, { expires: number; value: Promise<ForecastResult> }>();

const SYMBOL_WORDS: Array<[RegExp, string, number]> = [
  // [symbol pattern, words, severity] — the worst daytime symbol names the day.
  [/thunder/, 'thunderstorms', 9],
  [/heavysnow|^snow|lightsnow|snowshowers/, 'snow', 8],
  [/sleet/, 'sleet', 7],
  [/heavyrain/, 'heavy rain', 6],
  [/^rain$|^rain_|lightrain(?!showers)/, 'rain', 5],
  [/rainshowers/, 'showers', 4],
  [/fog/, 'fog', 3],
  [/^cloudy/, 'cloudy', 2],
  [/partlycloudy/, 'partly cloudy', 1],
  [/fair/, 'mostly sunny', 0.5],
  [/clearsky/, 'sunny', 0],
];
function symbolWords(code: string): [string, number] {
  for (const [re, words, sev] of SYMBOL_WORDS) if (re.test(code)) return [words, sev];
  return ['', -1];
}

/** Hours east of UTC, from longitude. Close enough to bucket a day's high and low. */
const solarOffsetHours = (lon: number) => Math.round(lon / 15);

export function parseMetForecast(json: any, lon: number): ForecastResult {
  const series: any[] = json?.properties?.timeseries ?? [];
  const off = solarOffsetHours(lon) * 3_600_000;
  type Acc = { temps: number[]; hours: Set<number>; precip: number; sym: [string, number] };
  const byDay = new Map<string, Acc>();
  for (const s of series) {
    const t = Date.parse(s?.time);
    const temp = s?.data?.instant?.details?.air_temperature;
    if (!Number.isFinite(t) || !Number.isFinite(temp)) continue;
    const local = new Date(t + off);
    const date = local.toISOString().slice(0, 10);
    const hour = local.getUTCHours();
    const acc = byDay.get(date) ?? { temps: [], hours: new Set<number>(), precip: 0, sym: ['', -1] as [string, number] };
    acc.temps.push(temp);
    acc.hours.add(hour);
    // Hourly steps carry next_1_hours; the 6-hourly tail carries next_6_hours.
    // Take the 1-hour amount when present so nothing is counted twice.
    const one = s?.data?.next_1_hours;
    const six = s?.data?.next_6_hours;
    if (one) acc.precip += Number(one.details?.precipitation_amount) || 0;
    else if (six) acc.precip += Number(six.details?.precipitation_amount) || 0;
    const code = (one ?? six)?.summary?.symbol_code;
    if (code && hour >= 6 && hour <= 20) {
      const w = symbolWords(String(code));
      if (w[1] > acc.sym[1]) acc.sym = w;
    }
    byDay.set(date, acc);
  }
  const days = new Map<string, ForecastDay>();
  let until: string | null = null;
  for (const [date, a] of [...byDay.entries()].sort()) {
    // A day counts only when the forecast covers it from morning to evening;
    // the first and last partial days would give a half-day "high".
    const hrs = [...a.hours];
    if (Math.min(...hrs) > 6 || Math.max(...hrs) < 18 || a.temps.length < 4) continue;
    days.set(date, {
      date,
      highC: round1(Math.max(...a.temps)),
      lowC: round1(Math.min(...a.temps)),
      precipMm: round1(a.precip),
      summary: a.sym[0] || 'mixed',
    });
    until = date;
  }
  return { days, until };
}

async function metForecast(lat: number, lon: number): Promise<ForecastResult> {
  // MET asks for at most 4 decimals; 2 (~1 km) keeps their cache warm.
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = forecastCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const entry = { expires: Date.now() + 60_000, value: null as unknown as Promise<ForecastResult> };
  entry.value = (async () => {
    const res = await fetcher(
      `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`,
      { headers: { 'User-Agent': WEATHER_USER_AGENT, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`MET Norway ${res.status}`);
    const expires = Date.parse(res.headers.get('expires') ?? '');
    // Respect Expires (never re-fetch before it), with a 10-minute floor.
    entry.expires = Math.max(Number.isFinite(expires) ? expires : 0, Date.now() + 10 * 60_000);
    return parseMetForecast(await res.json(), lon);
  })();
  forecastCache.set(key, entry);
  entry.value.catch(() => forecastCache.delete(key));
  return entry.value;
}

// ─── Typical: NASA POWER daily history ───────────────────────────────

type History = {
  years: [number, number];
  /** "NOAA GHCN-Daily, PARIS-MONTSOURIS station" / "NASA POWER" */
  source: string;
  hi: Record<string, number>;
  lo: Record<string, number>;
  pr: Record<string, number>;
};
const historyCache = new Map<string, { expires: number; value: Promise<unknown> }>();
/**
 * NOAA usually answers in ~1 s but took over 10 s twice on 2026-11-18, which
 * sent Paris to NASA's grid (about 2°C colder) for one request and not the
 * next; Heathrow's ten years took 28 s. A request waits for the station at
 * most NOAA_WAIT_MS and then uses the grid, while the download carries on (up
 * to NOAA_TIMEOUT_MS) and is kept for the requests after it.
 */
const NOAA_TIMEOUT_MS = 60000;
const NOAA_WAIT_MS = 20000;
/** For tests: how long a request waits for the station. */
let stationWaitMs = NOAA_WAIT_MS;
export function __setStationWaitMs(ms: number | null): void {
  stationWaitMs = ms ?? NOAA_WAIT_MS;
}
/**
 * A city's typical figures for a date, once worked out, for 6 hours: the
 * Calendar, the Schedule and the chat show the same numbers for the same day
 * even when a slow station sent one request to the grid and not another.
 */
const typicalCache = new Map<string, { expires: number; value: Omit<DayWeather, 'date' | 'kind'> & { years: [number, number] } }>();
const TYPICAL_TTL_MS = 6 * 3_600_000;
const TYPICAL_YEARS = 10;
const WINDOW_DAYS = 3;
const WET_MM = 1;

/**
 * Weather-station history: NOAA GHCN-Daily (ncei.noaa.gov, public domain).
 * The nearest station within ~40 km with decent coverage and data in the
 * last two years. Station records have gaps (Heathrow has almost no highs
 * before 2022); a date it can't average falls back to NASA POWER, as does a
 * city with no station. One station per request: asking for several at once
 * took 5–25 s and timed out (measured 2026-11-17), one takes ~1 s. Measured 2016–2025, January at Paris-Montsouris: 8.1 / 3.1°C — the
 * city's real climate, where POWER's grid cell reads 6.6 / 0.6.
 */
async function noaaHistory(lat: number, lon: number): Promise<History[]> {
  const lastYear = Number(todayIso().slice(0, 4)) - 1;
  const firstYear = lastYear - TYPICAL_YEARS + 1;
  const key = `noaa:${lat.toFixed(2)},${lon.toFixed(2)},${lastYear}`;
  const hit = historyCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as any;
  const value = (async (): Promise<History[]> => {
    const d = 0.4;
    const search =
      `https://www.ncei.noaa.gov/access/services/search/v1/data?dataset=daily-summaries&dataTypes=TMAX,TMIN&limit=40` +
      `&bbox=${(lat + d).toFixed(3)},${(lon - d).toFixed(3)},${(lat - d).toFixed(3)},${(lon + d).toFixed(3)}` +
      `&startDate=${firstYear}-01-01T00:00:00&endDate=${lastYear}-12-31T23:59:59`;
    const res = await fetcher(search, { headers: { 'User-Agent': WEATHER_USER_AGENT }, signal: AbortSignal.timeout(NOAA_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`NOAA search ${res.status}`);
    const json: any = await res.json();
    const stations = pickStations(json?.results ?? [], lat, lon, lastYear).slice(0, 1);
    if (!stations.length) return [];
    const dataUrl =
      `https://www.ncei.noaa.gov/access/services/data/v1?dataset=daily-summaries&stations=${stations.map((x) => encodeURIComponent(x.id)).join(',')}` +
      `&startDate=${firstYear}-01-01&endDate=${lastYear}-12-31&dataTypes=TMAX,TMIN,PRCP&format=json&units=metric`;
    const dres = await fetcher(dataUrl, { headers: { 'User-Agent': WEATHER_USER_AGENT }, signal: AbortSignal.timeout(NOAA_TIMEOUT_MS) });
    if (!dres.ok) throw new Error(`NOAA data ${dres.status}`);
    const rows = (await dres.json()) as any[];
    const byId = new Map<string, History>(
      stations.map((x) => [x.id, { years: [firstYear, lastYear], source: `NOAA GHCN-Daily, ${x.name} station`, hi: {}, lo: {}, pr: {} }]),
    );
    const num = (v: any) => (v == null || v === '' ? NaN : Number(v));
    for (const row of Array.isArray(rows) ? rows : []) {
      const h = byId.get(String(row?.STATION ?? stations[0].id));
      if (!h) continue;
      const k = String(row?.DATE ?? '').replace(/-/g, '');
      if (Number.isFinite(num(row.TMAX))) h.hi[k] = num(row.TMAX);
      if (Number.isFinite(num(row.TMIN))) h.lo[k] = num(row.TMIN);
      if (Number.isFinite(num(row.PRCP))) h.pr[k] = num(row.PRCP);
    }
    return stations.map((x) => byId.get(x.id)!).filter((h) => Object.keys(h.hi).length > 100);
  })();
  historyCache.set(key, { expires: Date.now() + 7 * 86_400_000, value: value as any });
  value.catch(() => historyCache.delete(key));
  return value;
}

/** Stations with ≥ 50% TMAX/TMIN coverage and data since last year, within 40 km, nearest first. */
export function pickStations(results: any[], lat: number, lon: number, lastYear: number): Array<{ id: string; name: string; km: number }> {
  const out: Array<{ id: string; name: string; km: number }> = [];
  for (const r of results) {
    const st = r?.stations?.[0];
    const pt = r?.boundingPoints?.[0]?.coordinates;
    if (!st?.id || !Array.isArray(pt)) continue;
    const dt = (id: string) => (st.dataTypes ?? []).find((x: any) => x?.id === id);
    const tmax = dt('TMAX');
    const tmin = dt('TMIN');
    if (!tmax || !tmin || Math.min(tmax.coverage ?? 0, tmin.coverage ?? 0) < 50) continue;
    if (String(tmin.endDate ?? '').slice(0, 4) < String(lastYear - 1)) continue;
    const km = Math.hypot((pt[1] - lat) * 111, (pt[0] - lon) * 111 * Math.cos((lat * Math.PI) / 180));
    if (km > 40) continue;
    out.push({ id: String(st.id), name: titleCase(String(st.name ?? st.id).replace(/,\s*[A-Z]{2}$/, '')), km });
  }
  return out.sort((x, y) => x.km - y.km).slice(0, 5);
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

async function nasaHistory(lat: number, lon: number): Promise<History> {
  const lastYear = Number(todayIso().slice(0, 4)) - 1;
  const firstYear = lastYear - TYPICAL_YEARS + 1;
  // POWER's grid is 0.5° × 0.625°: nearby points share a cell.
  const la = Math.round(lat * 4) / 4;
  const lo = Math.round(lon * 4) / 4;
  const key = `${la},${lo},${lastYear}`;
  const hit = historyCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<History>;
  const value = (async () => {
    const url =
      `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=T2M_MAX,T2M_MIN,PRECTOTCORR&community=RE` +
      `&latitude=${la}&longitude=${lo}&start=${firstYear}0101&end=${lastYear}1231&format=JSON`;
    const res = await fetcher(url, { headers: { 'User-Agent': WEATHER_USER_AGENT }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`NASA POWER ${res.status}`);
    const json: any = await res.json();
    const p = json?.properties?.parameter;
    if (!p?.T2M_MAX || !p?.T2M_MIN) throw new Error('NASA POWER: no daily data');
    return { years: [firstYear, lastYear] as [number, number], source: 'NASA POWER', hi: p.T2M_MAX, lo: p.T2M_MIN, pr: p.PRECTOTCORR ?? {} };
  })();
  historyCache.set(key, { expires: Date.now() + 7 * 86_400_000, value });
  value.catch(() => historyCache.delete(key));
  return value;
}

const valid = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > -900;

/** Averages for one calendar day over the history, ±3 days. Null when too few samples. */
export function typicalFor(h: History, date: string): Omit<DayWeather, 'date' | 'kind'> | null {
  const mmdd = date.slice(5, 10);
  const his: number[] = [];
  const los: number[] = [];
  let wet = 0;
  let rainN = 0;
  for (let y = h.years[0]; y <= h.years[1]; y++) {
    // Feb 29 in a common year reads as Mar 1 — one day off, inside the window.
    const center = mmdd === '02-29' && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? `${y}-03-01` : `${y}-${mmdd}`;
    for (let k = -WINDOW_DAYS; k <= WINDOW_DAYS; k++) {
      const d = addDays(center, k).replace(/-/g, '');
      // Each from the days that have it: Heathrow's record has a high and a
      // low on the same day in only ~10% of 2016–2021, so requiring both sent
      // London to NASA's grid, whose lows read ~2°C cold.
      if (valid(h.hi[d])) his.push(h.hi[d]);
      if (valid(h.lo[d])) los.push(h.lo[d]);
      if (valid(h.pr[d])) {
        rainN++;
        if (h.pr[d] >= WET_MM) wet++;
      }
    }
  }
  if (his.length < 20 || los.length < 20) return null;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  return { highC: round1(mean(his)), lowC: round1(mean(los)), wetDayShare: rainN ? Math.round((wet / rainN) * 100) / 100 : undefined };
}

// ─── Per city ────────────────────────────────────────────────────────

const round1 = (n: number) => Math.round(n * 10) / 10;
/** How far ahead MET Norway's forecast reaches; beyond it, don't ask. */
const FORECAST_HORIZON_DAYS = 10;

/**
 * Weather for a city on given dates: forecast where MET Norway covers the
 * day, typical (past years) otherwise. A day neither source can cover goes in
 * `missing` — it is never filled in.
 */
export async function weatherForCity(
  city: string,
  dates: string[],
  opts: { country?: string; otherCities?: string[] } = {},
): Promise<CityWeather> {
  const geo = cityGeo(city, opts.otherCities ?? []);
  const out: CityWeather = { city, country: geo?.country || opts.country || '', dates, days: [], missing: [] };
  if (!geo) {
    out.missing = [...dates];
    out.problem = `I couldn't place ${city} on the map, so I couldn't look up its weather.`;
    return out;
  }
  const today = todayIso();
  const horizon = addDays(today, FORECAST_HORIZON_DAYS);
  const wantsForecast = dates.some((d) => d >= today && d <= horizon);
  // Typical: a nearby weather station first, NASA POWER's grid when there is
  // none or it has gaps on a date. Each is fetched at most once, on first
  // need; the station is started alongside the forecast when days lie past it.
  const lazy = <T>(f: () => Promise<T>) => {
    let p: Promise<T> | null = null;
    return () => (p ??= f());
  };
  const station = lazy(() => {
    const history = noaaHistory(geo.lat, geo.lon).catch((e) => fail('typical (station)', city, e));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        logger.warn('weather station slow: using the grid for this request', { city, waitedMs: stationWaitMs });
        resolve(null);
      }, stationWaitMs);
    });
    return Promise.race([history, late]).finally(() => clearTimeout(timer));
  });
  const grid = lazy(() => nasaHistory(geo.lat, geo.lon).catch((e) => fail('typical (grid)', city, e)));
  if (dates.some((d) => d > addDays(today, 8) || d < today) || !wantsForecast) {
    // Both at once: the grid is the fallback for a station's gaps, and
    // waiting for one then the other doubled the reply time.
    void station();
    void grid();
  }
  const fc = wantsForecast ? await metForecast(geo.lat, geo.lon).catch((e) => fail('forecast', city, e)) : null;
  if (fc?.until) out.forecastUntil = fc.until;
  const sources = new Set<string>();
  for (const date of dates) {
    const f = fc?.days.get(date);
    if (f) {
      out.days.push({ date, kind: 'forecast', highC: f.highC, lowC: f.lowC, precipMm: f.precipMm, summary: f.summary });
      continue;
    }
    const stickyKey = `${geo.lat.toFixed(2)},${geo.lon.toFixed(2)}|${date}`;
    const sticky = typicalCache.get(stickyKey);
    if (sticky && sticky.expires > Date.now()) {
      const { years, ...t } = sticky.value;
      out.days.push({ date, kind: 'typical', ...t });
      out.typicalYears = `${years[0]}–${years[1]}`;
      if (t.source) sources.add(t.source);
      continue;
    }
    let h: History | null = null;
    let t: ReturnType<typeof typicalFor> = null;
    for (const st of (await station()) ?? []) {
      t = typicalFor(st, date);
      if (t) {
        h = st;
        break;
      }
    }
    if (!t) {
      h = await grid();
      t = h ? typicalFor(h, date) : null;
    }
    if (t && h) {
      typicalCache.set(stickyKey, { expires: Date.now() + TYPICAL_TTL_MS, value: { ...t, source: h.source, years: h.years } });
      out.days.push({ date, kind: 'typical', ...t, source: h.source });
      out.typicalYears = `${h.years[0]}–${h.years[1]}`;
      sources.add(h.source);
    } else out.missing.push(date);
  }
  if (sources.size) out.typicalSources = [...sources];
  if (out.missing.length) {
    out.problem = `I couldn't get the weather for ${city} on ${out.missing.length === dates.length ? 'those days' : out.missing.join(', ')} — the weather services didn't answer.`;
  }
  return out;
}

function fail(kind: string, city: string, e: any): null {
  logger.warn('weather fetch failed', { kind, city, message: e?.message });
  return null;
}

/**
 * Weather for each trip city on its own days. `city` narrows it to one trip
 * city (case-insensitive); `dates` narrows the days (kept only where the
 * traveller is in that city, unless the city isn't on the trip).
 */
export async function tripWeather(
  trip: any,
  opts: { city?: string | null; dates?: string[] | null } = {},
): Promise<{ cities: CityWeather[]; notOnTrip?: string }> {
  const stays = tripCityDays(trip);
  const names = stays.map((s) => s.city);
  const wantCity = opts.city?.trim().toLowerCase();
  let picked = wantCity ? stays.filter((s) => s.city.toLowerCase() === wantCity) : stays;
  let notOnTrip: string | undefined;
  if (wantCity && picked.length === 0) {
    // A city that isn't on the trip: only with dates the user gave.
    notOnTrip = opts.city!.trim();
    if (!opts.dates?.length) return { cities: [], notOnTrip };
    picked = [{ city: notOnTrip, country: '', dates: [...opts.dates].sort() }];
  } else if (opts.dates?.length) {
    const want = new Set(opts.dates);
    picked = picked.map((s) => ({ ...s, dates: s.dates.filter((d) => want.has(d)) })).filter((s) => s.dates.length);
  }
  const cities = await Promise.all(
    picked.map((s) => weatherForCity(s.city, s.dates, { country: s.country, otherCities: names })),
  );
  return { cities, notOnTrip };
}

/** For tests: forget cached responses. */
export function __resetWeatherCache(): void {
  forecastCache.clear();
  historyCache.clear();
  typicalCache.clear();
}
