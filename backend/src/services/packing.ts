/**
 * Packing help for BlueMurr AI — grounded in THIS trip: each city's weather
 * on the traveller's own days (weather.ts, fetched), the trip's length, what's
 * on the schedule (activities, a dinner plan), how they travel between cities,
 * and each country's plugs.
 *
 * `packingFacts` gathers the facts and a deterministic list of suggestions,
 * each with its reason. The chat may word them (weatherChat.ts), but every
 * item and number comes from here.
 */
import { cityGeo } from './routeGeo';
import { tripLegs } from './tripLegs';
import type { CityWeather } from './weather';

// ─── Plugs ───────────────────────────────────────────────────────────

export type Plug = { types: string[]; volts: number };

/** Plug types and mains voltage by ISO country (IEC World Plugs). */
export const PLUGS: Record<string, Plug> = {
  US: { types: ['A', 'B'], volts: 120 }, CA: { types: ['A', 'B'], volts: 120 }, MX: { types: ['A', 'B'], volts: 127 },
  GB: { types: ['G'], volts: 230 }, IE: { types: ['G'], volts: 230 }, MT: { types: ['G'], volts: 230 }, CY: { types: ['G'], volts: 230 },
  FR: { types: ['C', 'E'], volts: 230 }, BE: { types: ['C', 'E'], volts: 230 }, CZ: { types: ['C', 'E'], volts: 230 },
  SK: { types: ['C', 'E'], volts: 230 }, PL: { types: ['C', 'E'], volts: 230 }, MC: { types: ['C', 'E', 'F'], volts: 230 },
  DE: { types: ['C', 'F'], volts: 230 }, AT: { types: ['C', 'F'], volts: 230 }, NL: { types: ['C', 'F'], volts: 230 },
  ES: { types: ['C', 'F'], volts: 230 }, PT: { types: ['C', 'F'], volts: 230 }, SE: { types: ['C', 'F'], volts: 230 },
  NO: { types: ['C', 'F'], volts: 230 }, FI: { types: ['C', 'F'], volts: 230 }, DK: { types: ['C', 'E', 'F', 'K'], volts: 230 },
  GR: { types: ['C', 'F'], volts: 230 }, HU: { types: ['C', 'F'], volts: 230 }, HR: { types: ['C', 'F'], volts: 230 },
  SI: { types: ['C', 'F'], volts: 230 }, RO: { types: ['C', 'F'], volts: 230 }, BG: { types: ['C', 'F'], volts: 230 },
  LU: { types: ['C', 'F'], volts: 230 }, EE: { types: ['C', 'F'], volts: 230 }, LV: { types: ['C', 'F'], volts: 230 },
  LT: { types: ['C', 'F'], volts: 230 }, IS: { types: ['C', 'F'], volts: 230 }, RS: { types: ['C', 'F'], volts: 230 },
  ME: { types: ['C', 'F'], volts: 230 }, BA: { types: ['C', 'F'], volts: 230 }, AL: { types: ['C', 'F'], volts: 230 },
  MK: { types: ['C', 'F'], volts: 230 }, TR: { types: ['C', 'F'], volts: 230 }, UA: { types: ['C', 'F'], volts: 230 },
  IT: { types: ['C', 'F', 'L'], volts: 230 }, CH: { types: ['C', 'J'], volts: 230 }, LI: { types: ['C', 'J'], volts: 230 },
  IL: { types: ['C', 'H'], volts: 230 }, MA: { types: ['C', 'E'], volts: 220 }, EG: { types: ['C', 'F'], volts: 220 },
  ZA: { types: ['C', 'M', 'N'], volts: 230 }, KE: { types: ['G'], volts: 240 }, TZ: { types: ['D', 'G'], volts: 230 },
  AE: { types: ['G'], volts: 230 }, QA: { types: ['D', 'G'], volts: 240 }, SA: { types: ['G'], volts: 230 },
  JO: { types: ['B', 'C', 'D', 'F', 'G', 'J'], volts: 230 }, IN: { types: ['C', 'D', 'M'], volts: 230 },
  LK: { types: ['D', 'G'], volts: 230 }, NP: { types: ['C', 'D', 'M'], volts: 230 }, SG: { types: ['G'], volts: 230 },
  MY: { types: ['G'], volts: 240 }, HK: { types: ['G'], volts: 220 }, TH: { types: ['A', 'B', 'C', 'O'], volts: 220 },
  VN: { types: ['A', 'C'], volts: 220 }, ID: { types: ['C', 'F'], volts: 230 }, PH: { types: ['A', 'B', 'C'], volts: 220 },
  CN: { types: ['A', 'C', 'I'], volts: 220 }, TW: { types: ['A', 'B'], volts: 110 }, KR: { types: ['C', 'F'], volts: 220 },
  JP: { types: ['A', 'B'], volts: 100 }, AU: { types: ['I'], volts: 230 }, NZ: { types: ['I'], volts: 230 },
  FJ: { types: ['I'], volts: 240 }, BR: { types: ['C', 'N'], volts: 127 }, AR: { types: ['C', 'I'], volts: 220 },
  CL: { types: ['C', 'L'], volts: 220 }, PE: { types: ['A', 'C'], volts: 220 }, CO: { types: ['A', 'B'], volts: 110 },
  CR: { types: ['A', 'B'], volts: 120 }, PA: { types: ['A', 'B'], volts: 120 }, CU: { types: ['A', 'B', 'C', 'L'], volts: 110 },
  DO: { types: ['A', 'B'], volts: 120 }, JM: { types: ['A', 'B'], volts: 110 }, PR: { types: ['A', 'B'], volts: 120 },
  BS: { types: ['A', 'B'], volts: 120 }, EC: { types: ['A', 'B'], volts: 120 }, UY: { types: ['C', 'F', 'I', 'L'], volts: 220 },
};

const COUNTRY_NAMES: Record<string, string> = {
  US: 'the US', GB: 'the UK', AE: 'the UAE', NL: 'the Netherlands', CZ: 'Czechia', PH: 'the Philippines',
  FR: 'France', DE: 'Germany', IT: 'Italy', ES: 'Spain', PT: 'Portugal', CH: 'Switzerland', AT: 'Austria',
  BE: 'Belgium', IE: 'Ireland', GR: 'Greece', JP: 'Japan', AU: 'Australia', CA: 'Canada', MX: 'Mexico',
  HU: 'Hungary', PL: 'Poland', HR: 'Croatia', DK: 'Denmark', SE: 'Sweden', NO: 'Norway', IS: 'Iceland', TR: 'Türkiye',
};
const countryWord = (iso: string, fallback: string) => COUNTRY_NAMES[iso] ?? (fallback || iso);

/** ISO-2 code for a trip city's country (geo index first; a 2-letter field as-is). */
function isoOf(city: string, country: string, others: string[]): string {
  const g = cityGeo(city, others);
  if (g?.country && /^[A-Z]{2}$/.test(g.country)) return g.country;
  return /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : '';
}

// ─── Facts ───────────────────────────────────────────────────────────

export type WeatherSummary = {
  kind: 'forecast' | 'typical' | 'mixed' | 'none';
  /** Warmest daily high and coldest low over the stay, °C, rounded. */
  maxHighC: number | null;
  minLowC: number | null;
  /** forecast days with ≥ 1 mm. */
  rainyForecastDays: number;
  /** typical: past years' share of wet days, averaged over the stay (0..1). */
  typicalWetShare: number | null;
  summaries: string[];
  days: number;
};

export type PackingItem = { item: string; why: string };

export type PackingFacts = {
  scope: string;
  nights: number;
  cities: Array<{
    city: string;
    country: string;
    from: string;
    to: string;
    nights: number;
    weather: WeatherSummary;
    plug: Plug | null;
    activities: string[];
    dinners: Array<{ restaurant: string; date: string; priceRange: string | null }>;
  }>;
  home: { city: string; country: string; plug: Plug | null } | null;
  flights: number;
  trains: number;
  items: PackingItem[];
  weatherMissing: string[];
};

export function summarizeWeather(w: CityWeather | undefined): WeatherSummary {
  const days = w?.days ?? [];
  if (!days.length) {
    return { kind: 'none', maxHighC: null, minLowC: null, rainyForecastDays: 0, typicalWetShare: null, summaries: [], days: 0 };
  }
  const kinds = new Set(days.map((d) => d.kind));
  const typical = days.filter((d) => d.kind === 'typical' && d.wetDayShare != null);
  return {
    kind: kinds.size > 1 ? 'mixed' : days[0].kind,
    maxHighC: Math.round(Math.max(...days.map((d) => d.highC))),
    minLowC: Math.round(Math.min(...days.map((d) => d.lowC))),
    rainyForecastDays: days.filter((d) => d.kind === 'forecast' && (d.precipMm ?? 0) >= 1).length,
    typicalWetShare: typical.length ? Math.round((typical.reduce((s, d) => s + (d.wetDayShare ?? 0), 0) / typical.length) * 100) / 100 : null,
    summaries: [...new Set(days.map((d) => d.summary).filter((s): s is string => !!s))],
    days: days.length,
  };
}

const nightsBetween = (a: string, b: string) => {
  const n = Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Dinners on a city's schedule: planned dinners (dinner.ts) and restaurant blocks. */
function dinnersOf(c: any): Array<{ restaurant: string; date: string; priceRange: string | null }> {
  const out: Array<{ restaurant: string; date: string; priceRange: string | null }> = [];
  const sched = c?.schedule && typeof c.schedule === 'object' ? c.schedule : {};
  const picks: any[] = Array.isArray(c?.restaurants) ? c.restaurants : [];
  for (const [date, events] of Object.entries(sched)) {
    for (const e of Array.isArray(events) ? (events as any[]) : []) {
      if (e?.dinner) {
        out.push({ restaurant: String(e.dinner.restaurant ?? e.title ?? ''), date, priceRange: e.dinner.priceRange ?? null });
      } else if (e?.category === 'restaurant' && /dinner/i.test(String(e?.title ?? '')) && String(e?.startTime ?? '') >= '17:00') {
        const pick = picks.find((r) => String(e.title).toLowerCase().includes(String(r?.name ?? '').toLowerCase()) && r?.name);
        out.push({ restaurant: String(pick?.name ?? e.title), date, priceRange: pick?.priceRange ?? null });
      }
    }
  }
  return out;
}

function activitiesOf(c: any): string[] {
  const names = new Set<string>();
  for (const a of Array.isArray(c?.activities) ? c.activities : []) {
    const n = typeof a === 'string' ? a : a?.name;
    if (n) names.add(String(n));
  }
  const sched = c?.schedule && typeof c.schedule === 'object' ? c.schedule : {};
  for (const events of Object.values(sched)) {
    for (const e of Array.isArray(events) ? (events as any[]) : []) {
      if (e?.category === 'activity' && e?.title) names.add(String(e.title));
    }
  }
  return [...names].slice(0, 12);
}

const isFancy = (p: string | null) => !!p && /^\${3,}$/.test(p.trim());

/**
 * Facts and suggestions for packing. `city` narrows to one trip city (its
 * days, its weather, the travel in and out of it); null means the whole trip.
 * `weather` is what weather.ts fetched for those cities.
 */
export function packingFacts(trip: any, weather: CityWeather[], city?: string | null): PackingFacts {
  const all: any[] = Array.isArray(trip?.cities) ? trip.cities : [];
  const names = all.map((c) => String(c?.name ?? ''));
  const want = city?.trim().toLowerCase();
  const chosen = want ? all.filter((c) => String(c?.name ?? '').toLowerCase() === want) : all;

  const cities = chosen.map((c) => {
    const name = String(c?.name ?? '');
    const iso = isoOf(name, String(c?.country ?? ''), names);
    const from = String(c?.dates?.arrival ?? '').slice(0, 10);
    const to = String(c?.dates?.departure ?? '').slice(0, 10);
    return {
      city: name,
      country: iso || String(c?.country ?? ''),
      from,
      to,
      nights: nightsBetween(from, to),
      weather: summarizeWeather(weather.find((w) => w.city.toLowerCase() === name.toLowerCase())),
      plug: PLUGS[iso] ?? null,
      activities: activitiesOf(c),
      dinners: dinnersOf(c),
    };
  });

  const homeCity = String(trip?.origin?.city ?? '').trim();
  const homeIso = homeCity ? isoOf(homeCity, '', []) : '';
  const home = homeCity ? { city: homeCity, country: homeIso, plug: PLUGS[homeIso] ?? null } : null;

  // Legs that touch the chosen cities (all legs for the whole trip).
  const chosenNames = new Set(cities.map((c) => c.city.toLowerCase()));
  let flights = 0;
  let trains = 0;
  for (const leg of tripLegs(trip)) {
    const touches = !want || chosenNames.has(String(leg.from).toLowerCase()) || chosenNames.has(String(leg.to).toLowerCase());
    if (!touches) continue;
    const mode = leg.current?.mode;
    if (mode === 'flight') flights++;
    else if (mode === 'train') trains++;
  }

  const nights = cities.reduce((s, c) => s + c.nights, 0);
  const facts: PackingFacts = {
    scope: want ? cities[0]?.city ?? city! : 'whole trip',
    nights,
    cities,
    home,
    flights,
    trains,
    items: [],
    weatherMissing: weather.filter((w) => w.missing.length).map((w) => w.city),
  };
  facts.items = packingItems(facts);
  return facts;
}

// ─── The list ────────────────────────────────────────────────────────

const where = (cs: Array<{ city: string }>) => cs.map((c) => c.city).join(' and ');
const label = (w: WeatherSummary) => (w.kind === 'forecast' ? 'forecast' : w.kind === 'mixed' ? 'forecast / typical' : 'typical for your dates');

/** Deterministic suggestions, each with the trip fact behind it. */
export function packingItems(f: PackingFacts): PackingItem[] {
  const items: PackingItem[] = [];
  const withW = f.cities.filter((c) => c.weather.days > 0);

  // Temperature
  const cold = withW.filter((c) => (c.weather.minLowC ?? 99) <= 5);
  const cool = withW.filter((c) => !cold.includes(c) && ((c.weather.minLowC ?? 99) <= 12 || (c.weather.maxHighC ?? 99) <= 16));
  const hot = withW.filter((c) => (c.weather.maxHighC ?? -99) >= 28);
  const warm = withW.filter((c) => !hot.includes(c) && (c.weather.maxHighC ?? -99) >= 22);
  if (cold.length) {
    items.push({
      item: 'Warm winter coat, hat, gloves and a scarf',
      why: cold.map((c) => `${c.city} lows around ${c.weather.minLowC}°C (${label(c.weather)})`).join('; '),
    });
    items.push({ item: 'Warm layers (sweater or fleece) and closed shoes with warm socks', why: 'for layering under the coat' });
  }
  if (cool.length) {
    items.push({
      item: 'A warm layer and a light jacket for evenings',
      why: cool.map((c) => `${c.city} ${c.weather.minLowC}–${c.weather.maxHighC}°C (${label(c.weather)})`).join('; '),
    });
  }
  if (hot.length) {
    items.push({
      item: 'Light, breathable clothes, sunscreen, sunglasses and a sun hat',
      why: hot.map((c) => `${c.city} highs up to ${c.weather.maxHighC}°C (${label(c.weather)})`).join('; '),
    });
    items.push({ item: 'A refillable water bottle', why: 'hot days of sightseeing' });
  } else if (warm.length) {
    items.push({
      item: 'T-shirts plus one layer for the evening',
      why: warm.map((c) => `${c.city} highs around ${c.weather.maxHighC}°C (${label(c.weather)})`).join('; '),
    });
  }

  // Rain / snow
  const snowy = withW.filter((c) => c.weather.summaries.some((s) => /snow|sleet/.test(s)));
  const wet = withW.filter(
    (c) => c.weather.rainyForecastDays > 0 || (c.weather.typicalWetShare ?? 0) >= 0.25 || c.weather.summaries.some((s) => /rain|showers|thunder/.test(s)),
  );
  const maybeWet = withW.filter((c) => !wet.includes(c) && (c.weather.typicalWetShare ?? 0) >= 0.12);
  if (wet.length) {
    items.push({
      item: 'Compact umbrella and a water-resistant jacket',
      why: wet
        .map((c) =>
          c.weather.rainyForecastDays > 0
            ? `${c.city}: rain forecast on ${c.weather.rainyForecastDays} of ${c.weather.days} days`
            : c.weather.typicalWetShare != null
              ? `${c.city}: in past years it rained on about ${Math.round(c.weather.typicalWetShare * 100)}% of these days`
              : `${c.city}: ${c.weather.summaries.join(', ')} in the forecast`,
        )
        .join('; '),
    });
  } else if (maybeWet.length) {
    items.push({
      item: 'A small umbrella, just in case',
      why: maybeWet.map((c) => `${c.city}: rain on about ${Math.round((c.weather.typicalWetShare ?? 0) * 100)}% of these days in past years`).join('; '),
    });
  }
  if (snowy.length) items.push({ item: 'Waterproof boots with grip', why: `${where(snowy)}: snow or sleet in the forecast` });

  // Schedule
  const acts = f.cities.flatMap((c) => c.activities.map((a) => ({ city: c.city, a })));
  items.push({
    item: 'Comfortable, broken-in walking shoes',
    why: acts.length ? `${acts.length} activities planned, e.g. ${acts.slice(0, 2).map((x) => x.a).join(', ')}` : 'city sightseeing is mostly on foot',
  });
  const match = (re: RegExp) => acts.filter((x) => re.test(x.a));
  const sacred = match(/cathedral|basilica|church|chapel|abbey|mosque|temple|synagogue|vatican|sainte-chapelle|notre[- ]dame|sagrada/i);
  if (sacred.length) items.push({ item: 'A scarf or layer to cover shoulders (and knees) for religious sites', why: `${sacred[0].a} (${sacred[0].city})` });
  const beach = match(/beach|swim|pool|spa|thermal|bath|lido|snorkel/i);
  if (beach.length) items.push({ item: 'Swimsuit and a quick-dry towel', why: `${beach[0].a} (${beach[0].city})` });
  const hike = match(/hike|hiking|trail|mountain|summit|climb|trek/i);
  if (hike.length) items.push({ item: 'Trainers or hiking shoes with grip', why: `${hike[0].a} (${hike[0].city})` });
  const show = match(/opera|ballet|theatre|theater|concert|symphony|philharmon|west end|broadway/i);
  const dinners = f.cities.flatMap((c) => c.dinners.map((d) => ({ ...d, city: c.city })));
  const fancy = dinners.filter((d) => isFancy(d.priceRange));
  if (fancy.length || show.length) {
    const reasons = [
      ...fancy.map((d) => `dinner at ${d.restaurant} (${d.priceRange}) on ${shortDay(d.date)} in ${d.city}`),
      ...show.slice(0, 1).map((x) => `${x.a} (${x.city})`),
    ];
    items.push({ item: 'One smart outfit and dressier shoes', why: reasons.join('; ') });
  } else if (dinners.length) {
    items.push({ item: 'A smart-casual outfit for dinner', why: `dinner at ${dinners[0].restaurant} on ${shortDay(dinners[0].date)} in ${dinners[0].city}` });
  }

  // Travel between cities
  if (f.flights > 0) {
    items.push({
      item: 'Carry-on liquids in containers of 100 ml (3.4 oz) or less, all in one clear 1-litre bag',
      why: `${f.flights} flight${f.flights === 1 ? '' : 's'} on this ${f.scope === 'whole trip' ? 'trip' : 'part of the trip'}`,
    });
    items.push({ item: 'Power bank and spare batteries in your carry-on, never in checked bags', why: 'airline safety rules' });
    items.push({ item: "Check your airline's carry-on size and weight before you pack", why: 'limits differ by airline, and low-cost European carriers are strict' });
  }
  if (f.trains > 0 && f.flights === 0) {
    items.push({ item: 'Pack as you like — trains have no liquid limits; keep the bag one you can lift onto a rack', why: `${f.trains} train${f.trains === 1 ? '' : 's'}` });
  }

  // Plugs and documents
  const homePlug = f.home?.plug;
  const byCountry = new Map<string, (typeof f.cities)[number]>();
  for (const c of f.cities) if (c.plug && !byCountry.has(c.country)) byCountry.set(c.country, c);
  const needs = [...byCountry.values()].filter((c) => !homePlug || !c.plug!.types.some((t) => homePlug.types.includes(t)));
  if (needs.length) {
    items.push({
      item: `Plug adapter${needs.length > 1 ? 's' : ''}: ${needs.map((c) => `type ${c.plug!.types.join('/')} for ${countryWord(c.country, c.country)}`).join(', ')}`,
      why: homePlug ? `your ${f.home!.city} plugs are type ${homePlug.types.join('/')}` : 'plug types differ by country',
    });
  }
  if (homePlug) {
    const volts = [...byCountry.values()].filter((c) => Math.abs(c.plug!.volts - homePlug.volts) >= 50);
    if (volts.length) {
      items.push({
        item: 'Check chargers say "100–240V" (phones and laptops do); leave hair dryers and straighteners at home or bring dual-voltage ones',
        why: `${volts.map((c) => `${countryWord(c.country, c.country)} is ${c.plug!.volts}V`).join(', ')}; ${f.home!.city} is ${homePlug.volts}V`,
      });
    }
  }
  const abroad = f.home?.country && f.cities.some((c) => c.country && c.country !== f.home!.country);
  if (abroad) items.push({ item: 'Passport (valid well beyond your return date)', why: 'international travel' });

  // Length
  if (f.nights > 7) {
    items.push({ item: 'Clothes for about a week, plus a laundry stop', why: `${f.nights} nights in all` });
  } else if (f.nights > 0) {
    items.push({ item: `Outfits for ${f.nights} day${f.nights === 1 ? '' : 's'} — layers you can mix and repeat`, why: `${f.nights} night${f.nights === 1 ? '' : 's'}` });
  }
  return items;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : iso;
}
