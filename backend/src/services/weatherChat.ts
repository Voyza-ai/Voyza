/**
 * BlueMurr AI chat: the weather and packing tools (tripChat.ts dispatches
 * `get_weather` and `packing_list` here).
 *
 * The weather is fetched first (weather.ts). The model then words the answer
 * from that data only, and the wording is CHECKED: every temperature, mm and
 * percentage it states must be one the server fetched, and forecast vs
 * typical must be named as such. Anything else — or no model — and the
 * reply is written straight from the data instead. The model never states
 * weather from its own knowledge.
 */
import { logger } from '../utils/logger';
import { todayIso } from '../utils/dates';
import { getAnthropicSafe, DEFAULT_MODEL } from './anthropic';
import { cityGeo } from './routeGeo';
import { tripWeather, type CityWeather, type DayWeather } from './weather';
import { packingFacts, shortDay, type PackingFacts } from './packing';

type Answer = { type: 'answer'; reply: string };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = (iso: string) => WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()];
const toF = (c: number) => Math.round((c * 9) / 5 + 32);
const r = (n: number) => Math.round(n);

/** A US home gets °F beside °C. */
function isUsHome(trip: any): boolean {
  const home = String(trip?.origin?.city ?? '').trim();
  return !!home && cityGeo(home)?.country === 'US';
}

function range(dates: string[]): string {
  if (!dates.length) return '';
  const a = shortDay(dates[0]);
  const b = shortDay(dates[dates.length - 1]);
  if (a === b) return a;
  return a.slice(0, 3) === b.slice(0, 3) ? `${a}–${b.slice(4)}` : `${a}–${b}`;
}

const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;

/** The data as the model sees it: per city, per day, labelled. */
export function weatherFacts(cities: CityWeather[], fahrenheit: boolean): any[] {
  return cities.map((c) => {
    const typical = c.days.filter((d) => d.kind === 'typical');
    const forecast = c.days.filter((d) => d.kind === 'forecast');
    const deg = (n: number) => (fahrenheit ? `${r(n)}°C (${toF(n)}°F)` : `${r(n)}°C`);
    return {
      city: c.city,
      daysInCity: range(c.dates),
      forecast: forecast.length
        ? {
            source: 'MET Norway forecast',
            days: forecast.map((d) => ({
              date: d.date,
              weekday: weekday(d.date),
              high: deg(d.highC),
              low: deg(d.lowC),
              rainOrSnowMm: d.precipMm,
              sky: d.summary,
            })),
          }
        : undefined,
      typical: typical.length
        ? {
            what: `Typical for ${range(typical.map((d) => d.date))} — averages of the same dates in ${c.typicalYears} (${(c.typicalSources ?? []).join(' / ')}), NOT a forecast`,
            dates: typical.map((d) => `${weekday(d.date)} ${d.date}`),
            averageHigh: deg(mean(typical.map((d) => d.highC))),
            averageLow: deg(mean(typical.map((d) => d.lowC))),
            rainyDaysInPastYearsPercent: typical.some((d) => d.wetDayShare != null)
              ? Math.round(mean(typical.map((d) => d.wetDayShare ?? 0)) * 100)
              : null,
          }
        : undefined,
      noDataFor: c.missing.length ? c.missing : undefined,
      problem: c.problem,
    };
  });
}

/** Every number the reply may state as a temperature, mm or percentage. */
function allowedNumbers(cities: CityWeather[]): Set<string> {
  const ok = new Set<string>();
  const add = (n: number) => {
    ok.add(String(r(n)));
    ok.add(String(Math.round(n * 10) / 10));
  };
  for (const c of cities) {
    const typical = c.days.filter((d) => d.kind === 'typical');
    const temps: number[] = c.days.flatMap((d) => [d.highC, d.lowC]);
    if (typical.length) temps.push(mean(typical.map((d) => d.highC)), mean(typical.map((d) => d.lowC)));
    for (const t of temps) {
      add(t);
      add(toF(t));
    }
    for (const d of c.days) if (d.precipMm != null) add(d.precipMm);
    if (typical.some((d) => d.wetDayShare != null)) add(mean(typical.map((d) => d.wetDayShare ?? 0)) * 100);
    for (const d of typical) if (d.wetDayShare != null) add(d.wetDayShare * 100);
  }
  return ok;
}

/** Why a model-written reply can't be used, or null when it holds up. */
export function replyProblem(reply: string, cities: CityWeather[], extraOk: Set<string> = new Set()): string | null {
  const ok = allowedNumbers(cities);
  extraOk.forEach((n) => ok.add(n));
  const claims = [
    ...reply.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:°|º|degrees?\b)/gi),
    ...reply.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:–|-|to)\s*-?\d+(?:\.\d+)?\s*(?:°|º)/gi), // the low end of "2–7°C"
    ...reply.matchAll(/(\d+(?:\.\d+)?)\s*mm\b/gi),
    ...reply.matchAll(/(\d+(?:\.\d+)?)\s*%/g),
  ];
  for (const m of claims) {
    const n = String(Number(m[1]));
    if (!ok.has(n) && !ok.has(String(r(Number(m[1]))))) return `states ${m[0].trim()}, which isn't in the fetched data`;
  }
  const hasTypical = cities.some((c) => c.days.some((d) => d.kind === 'typical'));
  const hasForecast = cities.some((c) => c.days.some((d) => d.kind === 'forecast'));
  if (hasTypical && !/typical|average|past years|usually/i.test(reply)) return 'does not say the figures are typical, not a forecast';
  if (hasForecast && !/forecast/i.test(reply)) return 'does not say which figures are a forecast';
  const missing = cities.filter((c) => c.missing.length);
  if (missing.length && !/couldn'?t|could not|unable|no (weather )?data|not available|unavailable/i.test(reply)) {
    return 'does not say some weather is missing';
  }
  return null;
}

/** Plain text for the chat bubble (it shows text as-is, no markdown). */
function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();
}

async function write(system: string, user: string): Promise<string | null> {
  const anthropic = getAnthropicSafe();
  if (!anthropic) return null;
  try {
    const res: any = await anthropic.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 900,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = res?.content?.find((b: any) => b.type === 'text')?.text;
    return typeof text === 'string' && text.trim() ? plain(text) : null;
  } catch (err: any) {
    logger.warn('weather chat: writer call failed', { message: err?.message });
    return null;
  }
}

const WRITER_RULES = `You are BlueMurr AI, the traveller's personal travel agent. Answer in plain text for a small chat bubble: no markdown, no headings, no bold; "•" bullets are fine. Short and scannable.
HARD RULES:
- Use ONLY the weather in DATA. Never state a temperature, rainfall, percentage or condition that isn't in DATA, and never use your own knowledge of the climate. No conversions or arithmetic: copy temperatures exactly as written in DATA, including any °F in brackets.
- Say plainly which figures are a FORECAST (MET Norway) and which are TYPICAL for those dates (averages of past years, not a forecast).
- If DATA has noDataFor or a problem for a city, say you couldn't get the weather for it. Don't guess.
- Today is ${'{TODAY}'}. Refer to days by weekday and date (e.g. "Sat Jan 17").`;

// ─── get_weather ─────────────────────────────────────────────────────

export function weatherFallbackReply(cities: CityWeather[], fahrenheit: boolean): string {
  const deg = (n: number) => (fahrenheit ? `${r(n)}°C (${toF(n)}°F)` : `${r(n)}°C`);
  const parts: string[] = [];
  for (const c of cities) {
    const lines: string[] = [];
    const forecast = c.days.filter((d) => d.kind === 'forecast');
    const typical = c.days.filter((d) => d.kind === 'typical');
    if (forecast.length) {
      lines.push(`${c.city}, ${range(forecast.map((d) => d.date))} — forecast (MET Norway):`);
      for (const d of forecast) {
        const wet = (d.precipMm ?? 0) >= 0.5 ? `, ${d.precipMm} mm of rain` : ', no rain expected';
        lines.push(`• ${weekday(d.date)} ${shortDay(d.date)}: high ${deg(d.highC)}, low ${deg(d.lowC)}, ${d.summary}${wet}`);
      }
    }
    if (typical.length) {
      const share = typical.some((d) => d.wetDayShare != null) ? Math.round(mean(typical.map((d) => d.wetDayShare ?? 0)) * 100) : null;
      lines.push(`${c.city}, ${range(typical.map((d) => d.date))} — typical for those dates (averages of ${c.typicalYears}, ${(c.typicalSources ?? []).join(' / ')}; not a forecast):`);
      lines.push(
        `• highs about ${deg(mean(typical.map((d) => d.highC)))}, lows about ${deg(mean(typical.map((d) => d.lowC)))}` +
          (share != null ? `; it rained on about ${share}% of these days in past years` : ''),
      );
    }
    if (c.problem) lines.push(c.problem);
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

export async function runWeatherTool(trip: any, input: any, message: string): Promise<Answer> {
  const dates = Array.isArray(input?.dates) ? input.dates.filter((d: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))) : null;
  const { cities, notOnTrip } = await tripWeather(trip, { city: input?.city ?? null, dates });
  if (notOnTrip && !cities.length) {
    return { type: 'answer', reply: `${notOnTrip} isn't on this trip. Tell me which dates you'd be there and I'll look up its weather.` };
  }
  if (!cities.length) {
    return { type: 'answer', reply: "You aren't in any of the trip's cities on those dates, so there's no weather to show for them." };
  }
  if (cities.every((c) => c.days.length === 0)) {
    return {
      type: 'answer',
      reply: `Sorry — I couldn't get the weather right now (the weather services didn't answer), so I won't guess. Try again in a few minutes.`,
    };
  }
  const fahrenheit = isUsHome(trip);
  const fallback = weatherFallbackReply(cities, fahrenheit);
  logger.info('weather chat: fetched', { cities: cities.map((c) => ({ city: c.city, days: c.days, missing: c.missing })) });
  const text = await write(
    WRITER_RULES.replace('{TODAY}', todayIso()),
    `TRAVELLER ASKED: ${message}\n\nDATA (the traveller's own days in each city):\n${JSON.stringify(weatherFacts(cities, fahrenheit), null, 1)}\n\nAnswer the question directly first (e.g. "Yes — rain is forecast on Sat Jan 17"), then the day-by-day or summary figures that matter. 2–8 short lines.`,
  );
  const problem = text ? replyProblem(text, cities) : 'no model reply';
  if (text && !problem) return { type: 'answer', reply: text };
  if (text) logger.warn('weather chat: model reply rejected, using the data as written', { problem });
  return { type: 'answer', reply: fallback };
}

// ─── packing_list ────────────────────────────────────────────────────

export function packingFallbackReply(f: PackingFacts): string {
  const head =
    f.scope === 'whole trip'
      ? `What to pack for your trip (${f.cities.map((c) => c.city).join(', ')} — ${f.nights} nights):`
      : `What to pack for ${f.scope} (${range([f.cities[0]?.from, f.cities[0]?.to].filter(Boolean) as string[])}, ${f.nights} nights):`;
  const lines = f.items.map((i) => `• ${i.item} — ${i.why}`);
  const missing = f.weatherMissing.length ? [`I couldn't get the weather for ${f.weatherMissing.join(', ')}, so this list doesn't account for it there.`] : [];
  return [head, ...lines, ...missing].join('\n');
}

export async function runPackingTool(trip: any, input: any, message: string): Promise<Answer> {
  const city = input?.city ? String(input.city) : null;
  const tripCities = (Array.isArray(trip?.cities) ? trip.cities : []).map((c: any) => String(c?.name ?? ''));
  if (city && !tripCities.some((n: string) => n.toLowerCase() === city.trim().toLowerCase())) {
    return { type: 'answer', reply: `${city} isn't on this trip — its cities are ${tripCities.join(', ')}. Which one should I pack for?` };
  }
  const { cities } = await tripWeather(trip, { city });
  const facts = packingFacts(trip, cities, city);
  logger.info('packing chat: fetched', { cities: cities.map((c) => ({ city: c.city, days: c.days, missing: c.missing })) });
  const fahrenheit = isUsHome(trip);
  const fallback = packingFallbackReply(facts);
  // Numbers the list itself uses (rain-day shares, liquids, volts, nights) are fine too.
  const extra = new Set<string>(['100', '3.4', '1', ...(fallback.match(/\d+(?:\.\d+)?/g) ?? [])]);
  const text = await write(
    WRITER_RULES.replace('{TODAY}', todayIso()),
    `TRAVELLER ASKED: ${message}\n\nPACKING LIST (every item and reason comes from their trip — keep the items, you may merge or reword them; add nothing that contradicts it and no item the trip doesn't call for):\n${facts.items
      .map((i) => `- ${i.item} — ${i.why}`)
      .join('\n')}\n\nDATA (weather on their days):\n${JSON.stringify(weatherFacts(cities, fahrenheit), null, 1)}\n\nWrite a short packing list: one line saying what the weather will be like (labelled forecast or typical), then 6–12 "•" bullets, each with the trip reason in a few words. Group by: Weather, Plans, Travel days, Plugs & documents.`,
  );
  const problem = text ? replyProblem(text, cities, extra) : 'no model reply';
  if (text && !problem) return { type: 'answer', reply: text };
  if (text) logger.warn('packing chat: model reply rejected, using the list as built', { problem });
  return { type: 'answer', reply: fallback };
}

export type { DayWeather };

// ─── Tool definitions (spread into tripChat.ts CHAT_TOOLS) ───────────

export const WEATHER_TOOLS = [
  {
    name: 'get_weather',
    description:
      'The weather for the traveller\'s own days in a trip city (or every city): "What\'s the weather in Paris on our days?", "Will it rain Saturday?", "How cold will London be?", "weather for the whole trip". The server fetches a forecast for days within ~9 days and typical conditions (averages of past years) for later days, and words the answer from that data. Also for a city NOT on the trip when the user gives dates. Never answer weather yourself.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: ['string', 'null'], description: 'Trip city, exact trip spelling; null for every city on the trip.' },
        dates: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description:
            'YYYY-MM-DD days, ONLY when the user named specific days ("Saturday" → that date within the trip; "our last day in Rome" → that date). Null for the whole stay.',
        },
      },
      required: [],
    },
  },
  {
    name: 'packing_list',
    description:
      'What to pack or bring: "What should I pack for Paris?", "What should I bring for the whole trip?", "do I need an umbrella / adapter?". The server builds the list from the weather on their days, their schedule, how they travel and each country\'s plugs.',
    input_schema: {
      type: 'object' as const,
      properties: {
        city: { type: ['string', 'null'], description: 'Trip city, exact trip spelling; null for the whole trip.' },
      },
      required: [],
    },
  },
];

export const WEATHER_PROMPT_LINE =
  'get_weather / packing_list — the weather on their days ("will it rain Saturday?", "how cold will London be?") and what to pack or bring. You never know the weather yourself: always call get_weather for any weather question (not answer_only), and packing_list for packing.';
