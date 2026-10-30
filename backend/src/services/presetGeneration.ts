import type { PresetData, PresetVibe, Region, DurationBucket, BudgetTier } from './presetTaxonomy';
import {
  budgetTier,
  countryKey,
  durationBucket,
  presetFacts,
  presetNights,
  ORIGIN_REGIONS,
  PRESET_ORIGIN_REGION,
  REGION_LABELS,
} from './presetTaxonomy';
import { resolve } from './location';
import { originIndex } from './location/originAirports';
import { getStaticIata } from '../data/cityAirports';

/**
 * Pure pieces of the AI preset generator (scripts/generatePresets.ts):
 * the taxonomy combinations to seed, the prompt, validation of Claude's
 * output, and small formatting helpers. No network here — testable.
 */

export type GenerationCombo = {
  vibe: PresetVibe;
  region: Region;
  duration: DurationBucket;
  tier: BudgetTier;
};

/**
 * Seed combinations across vibe × region × duration, in generation order.
 * The first 9 grow the 11 curated trips to a 20-trip catalog and are picked
 * to fill the curated set's gaps (Africa/Middle East, Oceania, the
 * Americas, Korea/Bali-style Asia, Europe weekends + mountains). The rest
 * are for growing the catalog later — re-running the script only fills
 * combos that don't have a trip yet.
 */
export const GENERATION_COMBOS: GenerationCombo[] = [
  // ── First batch (catalog → 20) ──
  { vibe: 'history', region: 'africa-middle-east', duration: 'one-week', tier: '$$' },
  { vibe: 'nature', region: 'oceania', duration: 'two-weeks', tier: '$$$' },
  { vibe: 'beach', region: 'americas', duration: 'weekend', tier: '$$' },
  { vibe: 'food', region: 'asia', duration: 'one-week', tier: '$$' },
  { vibe: 'nature', region: 'americas', duration: 'one-week', tier: '$$' },
  { vibe: 'nightlife', region: 'europe', duration: 'weekend', tier: '$' },
  { vibe: 'nature', region: 'europe', duration: 'one-week', tier: '$$' },
  { vibe: 'city', region: 'americas', duration: 'weekend', tier: '$' },
  { vibe: 'beach', region: 'asia', duration: 'one-week', tier: '$$' },
  // ── Later growth ──
  { vibe: 'romance', region: 'europe', duration: 'weekend', tier: '$$' },
  { vibe: 'food', region: 'europe', duration: 'one-week', tier: '$$' },
  { vibe: 'history', region: 'europe', duration: 'weekend', tier: '$$' },
  { vibe: 'beach', region: 'europe', duration: 'one-week', tier: '$$' },
  { vibe: 'art', region: 'europe', duration: 'one-week', tier: '$$' },
  { vibe: 'city', region: 'europe', duration: 'two-weeks', tier: '$$' },
  { vibe: 'nature', region: 'europe', duration: 'two-weeks', tier: '$$' },
  { vibe: 'romance', region: 'europe', duration: 'one-week', tier: '$$' },
  { vibe: 'history', region: 'europe', duration: 'month', tier: '$$' },
  { vibe: 'nature', region: 'asia', duration: 'two-weeks', tier: '$$' },
  { vibe: 'city', region: 'asia', duration: 'one-week', tier: '$$' },
  { vibe: 'history', region: 'asia', duration: 'one-week', tier: '$$' },
  { vibe: 'romance', region: 'asia', duration: 'one-week', tier: '$$' },
  { vibe: 'food', region: 'americas', duration: 'weekend', tier: '$$' },
  { vibe: 'history', region: 'americas', duration: 'one-week', tier: '$$' },
  { vibe: 'nature', region: 'americas', duration: 'two-weeks', tier: '$$' },
  { vibe: 'nature', region: 'africa-middle-east', duration: 'two-weeks', tier: '$$' },
  { vibe: 'food', region: 'africa-middle-east', duration: 'one-week', tier: '$$' },
  { vibe: 'city', region: 'africa-middle-east', duration: 'one-week', tier: '$$' },
  { vibe: 'beach', region: 'oceania', duration: 'two-weeks', tier: '$$' },
];

/** Every taxonomy combination (vibe × destination region × length × tier)
 *  — what `generatePresets.ts --all` batch-runs across. */
export function allTaxonomyCombos(): GenerationCombo[] {
  const regions: Region[] = ['europe', 'asia', 'americas', 'africa-middle-east', 'oceania'];
  const durations: DurationBucket[] = ['weekend', 'one-week', 'two-weeks', 'month'];
  const tiers: BudgetTier[] = ['$', '$$', '$$$', '$$$$'];
  const out: GenerationCombo[] = [];
  for (const vibe of VIBES) for (const region of regions) for (const duration of durations)
    for (const tier of tiers) out.push({ vibe, region, duration, tier });
  return out;
}

export const TIER_RANGE: Record<BudgetTier, string> = {
  $: 'under $750',
  $$: '$750–$1,500',
  $$$: '$1,500–$3,000',
  $$$$: '$3,000+',
};

export const NIGHTS_RANGE: Record<DurationBucket, [number, number]> = {
  weekend: [3, 4],
  'one-week': [5, 8],
  'two-weeks': [9, 15],
  month: [16, 24],
};

const VIBES: PresetVibe[] = ['beach', 'food', 'history', 'art', 'nature', 'city', 'nightlife', 'romance'];

export function generationPrompt(combo: GenerationCombo, avoidDestinations: string[]): string {
  const [lo, hi] = NIGHTS_RANGE[combo.duration];
  return [
    `Create one realistic, bookable multi-city travel itinerary for a BlueMurr preset trip.`,
    `Traveler: a party of 2 flying from ${ORIGIN_REGIONS[PRESET_ORIGIN_REGION].hubCity} (${ORIGIN_REGIONS[PRESET_ORIGIN_REGION].hubAirport}).`,
    `Main vibe: ${combo.vibe}. Region: ${REGION_LABELS[combo.region]}. Total nights: between ${lo} and ${hi}.`,
    `Budget tier: ${combo.tier} — ${TIER_RANGE[combo.tier]} per person for hotels + transport between cities`,
    `(excluding the flights from home). Pick hotels and routes that fit this tier.`,
    `budgetEstimateTotal = the trip's total cost in USD for BOTH travelers together:`,
    `(sum over cities of hotel pricePerNight × nights — they share one room)`,
    `+ (sum of every transportOut price × 2). No meals, activities, or flights from home.`,
    `Use 1–4 cities connected by realistic flights or trains; a weekend trip should be 1–2 cities.`,
    `Use REAL hotels, restaurants, and attractions that actually exist, with realistic current USD prices`,
    `(hotel pricePerNight is per room; transport price is per person, one way).`,
    `Every city needs 3–5 activities and 2–3 restaurants. Vibes must come only from: ${VIBES.join(', ')}.`,
    `The last city has no transportOut. coverImageWikipediaTitle must be the exact English Wikipedia`,
    `article title of the trip's most iconic landmark (e.g. "Machu Picchu", "Charles Bridge").`,
    avoidDestinations.length
      ? `Do NOT build the trip around these already-covered destinations: ${avoidDestinations.join(', ')}.`
      : '',
    `Title: 2–5 words, catchy, no colon or subtitle, no emoji (e.g. "Japan Golden Route", "Lisbon & Sintra Escape").`,
    `Then a one-sentence tagline and a 2–3 sentence description.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Claude tool schema — forces structured, typed output. */
export const PRESET_TOOL = {
  name: 'create_preset_trip',
  description: 'Return the itinerary as structured data.',
  input_schema: {
    type: 'object',
    required: ['title', 'tagline', 'description', 'searchTags', 'coverImageWikipediaTitle', 'budgetEstimateTotal', 'cities'],
    properties: {
      title: { type: 'string' },
      tagline: { type: 'string' },
      description: { type: 'string' },
      searchTags: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      coverImageWikipediaTitle: { type: 'string' },
      budgetEstimateTotal: { type: 'number' },
      cities: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          required: ['name', 'country', 'nights', 'hotel', 'activities', 'restaurants', 'vibes'],
          properties: {
            name: { type: 'string' },
            country: { type: 'string' },
            nights: { type: 'integer', minimum: 1 },
            hotel: {
              type: 'object',
              required: ['name', 'rating', 'pricePerNight', 'area'],
              properties: {
                name: { type: 'string' },
                rating: { type: 'number' },
                pricePerNight: { type: 'number' },
                area: { type: 'string' },
              },
            },
            activities: { type: 'array', items: { type: 'string' } },
            restaurants: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'cuisine', 'priceRange'],
                properties: {
                  name: { type: 'string' },
                  cuisine: { type: 'string' },
                  priceRange: { type: 'string', enum: ['$', '$$', '$$$', '$$$$'] },
                },
              },
            },
            vibes: { type: 'array', items: { type: 'string', enum: VIBES } },
            transportOut: {
              type: 'object',
              required: ['mode', 'operator', 'duration', 'price'],
              properties: {
                mode: { type: 'string', enum: ['flight', 'train'] },
                operator: { type: 'string' },
                duration: { type: 'string' },
                price: { type: 'number' },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export const ISO2: Record<string, string> = {
  france: 'FR', italy: 'IT', spain: 'ES', portugal: 'PT', germany: 'DE', netherlands: 'NL',
  belgium: 'BE', switzerland: 'CH', austria: 'AT', czechia: 'CZ', 'czech republic': 'CZ',
  poland: 'PL', hungary: 'HU', slovenia: 'SI', croatia: 'HR', greece: 'GR',
  'united kingdom': 'GB', uk: 'GB', england: 'GB', scotland: 'GB', ireland: 'IE', iceland: 'IS',
  norway: 'NO', sweden: 'SE', denmark: 'DK', finland: 'FI', estonia: 'EE', montenegro: 'ME',
  albania: 'AL', malta: 'MT', turkey: 'TR', türkiye: 'TR', japan: 'JP', 'south korea': 'KR',
  korea: 'KR', china: 'CN', 'hong kong': 'HK', taiwan: 'TW', thailand: 'TH', vietnam: 'VN',
  cambodia: 'KH', laos: 'LA', malaysia: 'MY', singapore: 'SG', indonesia: 'ID',
  philippines: 'PH', india: 'IN', 'sri lanka': 'LK', nepal: 'NP', maldives: 'MV',
  'united states': 'US', usa: 'US', canada: 'CA', mexico: 'MX', guatemala: 'GT', belize: 'BZ',
  'costa rica': 'CR', panama: 'PA', cuba: 'CU', 'dominican republic': 'DO', 'puerto rico': 'PR',
  jamaica: 'JM', bahamas: 'BS', colombia: 'CO', ecuador: 'EC', peru: 'PE', bolivia: 'BO',
  chile: 'CL', argentina: 'AR', uruguay: 'UY', brazil: 'BR', morocco: 'MA', egypt: 'EG',
  tunisia: 'TN', 'south africa': 'ZA', kenya: 'KE', tanzania: 'TZ', namibia: 'NA',
  botswana: 'BW', rwanda: 'RW', mauritius: 'MU', seychelles: 'SC',
  'united arab emirates': 'AE', uae: 'AE', oman: 'OM', jordan: 'JO', israel: 'IL', qatar: 'QA',
  australia: 'AU', 'new zealand': 'NZ', fiji: 'FJ', 'french polynesia': 'PF',
  'turks and caicos': 'TC', 'turks and caicos islands': 'TC', aruba: 'AW', barbados: 'BB',
  'saint lucia': 'LC', 'st lucia': 'LC', 'cayman islands': 'KY', bermuda: 'BM', curaçao: 'CW',
  curacao: 'CW', 'antigua and barbuda': 'AG', grenada: 'GD', 'trinidad and tobago': 'TT',
  'us virgin islands': 'VI', 'british virgin islands': 'VG', martinique: 'MQ', guadeloupe: 'GP',
  luxembourg: 'LU', slovakia: 'SK', latvia: 'LV', lithuania: 'LT', 'bosnia and herzegovina': 'BA',
  serbia: 'RS', paraguay: 'PY', romania: 'RO', bulgaria: 'BG', cyprus: 'CY', monaco: 'MC', myanmar: 'MM',
  bhutan: 'BT', mongolia: 'MN', 'saudi arabia': 'SA', ghana: 'GH', senegal: 'SN', uganda: 'UG',
};

export function flagFor(country: string): string {
  const code = ISO2[countryKey(country)];
  if (!code) return '';
  return String.fromCodePoint(...[...code].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

export function flagsFor(countries: string[]): string {
  return Array.from(new Set(countries)).map(flagFor).filter(Boolean).join(' ');
}

export function scopeFor(countries: string[], region: Region): string {
  const n = new Set(countries).size;
  if (n === 1) return 'One country';
  if (n >= 4) return region === 'europe' || region === 'asia' ? 'Continent' : `${n} countries`;
  return `${n} countries`;
}

/**
 * Normalize any Wikimedia Commons image URL to a 1280px thumbnail on
 * upload.wikimedia.org (the format the curated presets use). Handles both
 * originals (…/commons/a/ab/File.jpg) and thumbnails — including the
 * newer thumb.wikimedia.org host with ?utm_* tracking params the REST API
 * now returns. Non-Commons URLs come back unchanged (minus the query).
 */
export function wikimediaThumb(url: string, width = 1280): string {
  const clean = url.split('?')[0];
  const thumb = clean.match(/\/wikipedia\/commons\/thumb\/(\w)\/(\w\w)\/([^/]+)\//);
  const orig = clean.match(/\/wikipedia\/commons\/(\w)\/(\w\w)\/([^/]+)$/);
  const m = thumb ?? orig;
  if (!m) return clean;
  const [, a, ab, file] = m;
  if (/\.svg$/i.test(file)) return `https://upload.wikimedia.org/wikipedia/commons/${a}/${ab}/${file}`;
  return `https://upload.wikimedia.org/wikipedia/commons/thumb/${a}/${ab}/${file}/${width}px-${file}`;
}

// ── Checks the model's output can't be trusted to pass (audit E16) ──────
// Measured on the shipped generated.json: "Ferry + Transfer" stored as a
// FLIGHT, a hotel named "Hotel A", and cities no airport serves.

/** Modes the planner doesn't model. A leg naming one is not a flight or a
 *  train, whatever its `mode` says ("Ferry + Transfer" was a "flight"). */
const OTHER_MODE_WORDS =
  /\b(ferry|ferries|boat|bus|coach|transfer|shuttle|car|taxi|drive|driving|cruise|catamaran|hydrofoil|minivan|van)\b/i;
/** Names that only a train operator carries. "Express" is deliberately
 *  absent: Sky Express is an airline. */
const RAIL_WORDS =
  /\b(rail|railways?|railjet|trains?|shinkansen|eurostar|tgv|ouigo|thalys|frecciarossa|frecciargento|trenitalia|italo|sncf|renfe|amtrak|bahn)\b/i;
/** Names that only an airline carries. Plenty of airlines have none of
 *  these (Scoot, Volaris, LATAM), so this only catches a train that is
 *  plainly an airline, never the other way round. */
const AIR_WORDS = /\b(air|airlines?|airways|aerol[ií]neas|aviation|flights?)\b/i;

/** Why `operator` can't run a leg of this `mode`, or null when it can. */
export function operatorModeProblem(mode: string, operator: string): string | null {
  const op = operator.trim();
  if (!op) return 'no operator';
  if (OTHER_MODE_WORDS.test(op)) return `operator "${op}" is not a ${mode}`;
  if (mode === 'flight' && RAIL_WORDS.test(op)) return `operator "${op}" is a train, not a flight`;
  if (mode === 'train' && AIR_WORDS.test(op)) return `operator "${op}" is an airline, not a train`;
  return null;
}

/** Words that say what kind of place a hotel is, not which one. */
const GENERIC_HOTEL_WORDS = new Set([
  'hotel', 'hotels', 'resort', 'resorts', 'inn', 'hostel', 'lodge', 'motel', 'suites', 'suite',
  'rooms', 'apartments', 'apartment', 'villa', 'villas', 'guesthouse', 'guest', 'house', 'bnb',
  'b&b', 'boutique', 'spa', 'the', 'and', '&', 'by', 'local', 'central', 'city', 'centre',
  'center', 'downtown', 'old', 'town', 'beach', 'grand', 'luxury', 'budget', 'small', 'cozy',
  'charming', 'traditional', 'modern', 'view', 'standard', 'example', 'sample', 'generic',
]);

/**
 * True when a hotel name has nothing that identifies a real property —
 * "Hotel A", "The Hotel", "Boutique Hotel 2". Single letters and numbers
 * don't count. A city name DOES count ("Krabi Resort" is a real hotel).
 */
export function isGenericHotelName(name: string): boolean {
  const words = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9&]+/)
    .filter(Boolean);
  return !words.some((w) => !GENERIC_HOTEL_WORDS.has(w) && !/^\d+$/.test(w) && w.length > 1);
}

/** Farthest an airport can be and still be a city's gateway: Kyoto flies
 *  from KIX, 81 km away. */
export const MAX_GATEWAY_KM = 150;

/**
 * The airport a preset city is reached through, from the location resolver
 * (`"<city>, <country>"`, the reading in that country, its first airport
 * that serves it within MAX_GATEWAY_KM) — or, failing that, the hand-pinned
 * city → airport table getIataCode itself consults first, so a town someone
 * has pinned (km unknown) passes exactly when the planner can price it.
 * Null when there is neither: the planner prices every home and inter-city
 * flight from an airport, so such a city can't be priced or re-priced.
 */
export function gatewayAirport(city: string, country: string): { iata: string; km: number | null } | null {
  const want = ISO2[countryKey(country)];
  const r = resolve(`${city}, ${country}`, {}, originIndex());
  const places =
    r.status === 'resolved' ? [r.place] : r.status === 'ambiguous' ? r.candidates.map((c) => c.place) : [];
  const place = places.find((p) => !want || p.country === want);
  const airport = place?.airports.find((a) => a.servesPlace && a.km <= MAX_GATEWAY_KM);
  if (airport) return { iata: airport.iata, km: Math.round(airport.km) };
  const pinned = getStaticIata(city);
  return pinned ? { iata: pinned, km: null } : null;
}

const GRADIENTS = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
];

/**
 * Validate + normalize Claude's tool output into a PresetData. Returns
 * the list of problems instead of throwing so the script can report and
 * skip a bad generation without stopping the batch.
 */
export function validateGenerated(
  raw: any,
  combo: GenerationCombo,
  index: number,
): { preset?: PresetData; problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') return { problems: ['no tool output'], warnings };
  const cities = Array.isArray(raw.cities) ? raw.cities : [];
  if (cities.length === 0) problems.push('no cities');
  if (!raw.title || !raw.tagline || !raw.description) problems.push('missing title/tagline/description');
  // Card titles must be short: drop any "Title: Subtitle" tail, then cap.
  const title = String(raw.title ?? '').split(':')[0].trim();
  if (title.length > 40) problems.push(`title too long (${title.length} chars)`);

  const cleanCities = cities.map((c: any, i: number) => {
    const last = i === cities.length - 1;
    if (!c?.name || !c?.country) problems.push(`city ${i}: missing name/country`);
    else if (!gatewayAirport(String(c.name), String(c.country))) {
      problems.push(`city ${i}: no airport within ${MAX_GATEWAY_KM} km of ${c.name}, ${c.country}`);
    }
    if (!(c?.nights >= 1)) problems.push(`city ${i}: bad nights`);
    const ppn = Number(c?.hotel?.pricePerNight);
    if (!(ppn >= 20 && ppn <= 2000)) problems.push(`city ${i}: implausible hotel price ${ppn}`);
    if (isGenericHotelName(String(c?.hotel?.name ?? ''))) {
      problems.push(`city ${i}: generic hotel name "${c?.hotel?.name ?? ''}"`);
    }
    if (!Array.isArray(c?.activities) || c.activities.length < 2) problems.push(`city ${i}: too few activities`);
    if (!Array.isArray(c?.restaurants) || c.restaurants.length < 1) problems.push(`city ${i}: no restaurants`);
    const vibes = (Array.isArray(c?.vibes) ? c.vibes : []).filter((v: any) => VIBES.includes(v));
    if (vibes.length === 0) problems.push(`city ${i}: no valid vibes`);
    let transportOut = c?.transportOut;
    if (last) transportOut = undefined;
    else if (!transportOut || !(Number(transportOut.price) > 0) || !['flight', 'train'].includes(transportOut.mode)) {
      problems.push(`city ${i}: missing/invalid transportOut`);
    } else if (!(Number(transportOut.price) >= 5 && Number(transportOut.price) <= 1500)) {
      problems.push(`city ${i}: implausible transport price ${transportOut.price}`);
    } else {
      const mismatch = operatorModeProblem(transportOut.mode, String(transportOut.operator ?? ''));
      if (mismatch) problems.push(`city ${i}: ${mismatch}`);
    }
    return {
      name: String(c?.name ?? ''),
      country: String(c?.country ?? ''),
      nights: Math.round(Number(c?.nights ?? 0)),
      hotel: {
        name: String(c?.hotel?.name ?? ''),
        rating: Math.min(10, Math.max(0, Number(c?.hotel?.rating ?? 8))),
        pricePerNight: Math.round(ppn),
        area: String(c?.hotel?.area ?? ''),
      },
      activities: (c?.activities ?? []).slice(0, 5).map(String),
      restaurants: (c?.restaurants ?? []).slice(0, 3).map((r: any) => ({
        name: String(r?.name ?? ''),
        cuisine: String(r?.cuisine ?? ''),
        priceRange: ['$', '$$', '$$$', '$$$$'].includes(r?.priceRange) ? r.priceRange : '$$',
      })),
      vibes,
      ...(transportOut
        ? {
            transportOut: {
              mode: transportOut.mode,
              operator: String(transportOut.operator ?? ''),
              duration: String(transportOut.duration ?? ''),
              price: Math.round(Number(transportOut.price)),
            },
          }
        : {}),
    };
  });

  const preset: PresetData = {
    slug: slugify(title),
    title,
    tagline: String(raw.tagline ?? '').trim(),
    description: String(raw.description ?? '').trim(),
    searchTags: (Array.isArray(raw.searchTags) ? raw.searchTags : []).slice(0, 10).map((t: any) => String(t).toLowerCase()),
    coverGradient: GRADIENTS[index % GRADIENTS.length],
    flags: '',
    scope: '',
    travelers: 2,
    cities: cleanCities,
  };

  if (cleanCities.length > 0) {
    const nights = presetNights(preset);
    if (durationBucket(nights) !== combo.duration) {
      problems.push(`nights ${nights} outside the ${combo.duration} bucket`);
    }
    const f = presetFacts(preset);
    if (f.region !== combo.region) problems.push(`region ${f.region} ≠ requested ${combo.region}`);
    const order: BudgetTier[] = ['$', '$$', '$$$', '$$$$'];
    if (Math.abs(order.indexOf(f.budgetTier) - order.indexOf(combo.tier)) > 1) {
      problems.push(`priced ${f.budgetTier}/person, requested ${combo.tier}`);
    }
    // Claude's own budget estimate. Recorded, NOT used to accept/reject:
    // measured on real generations, the model's arithmetic over its own
    // itemized prices swings 0.5×–3× run to run, so gating on it rejected
    // sound trips at random. Acceptance rests on the itemized prices
    // (plausibility-checked above) and the computed tier; a large mismatch
    // is surfaced as a warning for the human review step.
    const est = Number(raw.budgetEstimateTotal);
    if (!(est > 0)) problems.push('missing budget estimate');
    else {
      preset.budgetEstimate = Math.round(est / preset.travelers);
      if (est < f.estCost * 0.5 || est > f.estCost * 2) {
        warnings.push(`AI budget estimate $${Math.round(est)} vs priced $${f.estCost} total`);
      }
    }
    const countries = cleanCities.map((c: any) => c.country);
    preset.flags = flagsFor(countries);
    preset.scope = scopeFor(countries, f.region);
  }
  if (!preset.slug) problems.push('empty slug');

  return problems.length ? { problems, warnings } : { preset, problems, warnings };
}

/**
 * True when a Commons file is unusable as a trip hero photo: vector
 * graphics, logos, maps, flags, crests, diagrams. (A photo of a real
 * person can't be detected from the name — the generator prefers the
 * landmark/city articles, and generated output is reviewed before seeding.)
 */
export function isUnsuitableHeroImage(url: string): boolean {
  const file = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '').toLowerCase();
  if (/\.svg(\.png)?$/.test(file)) return true;
  return /(logo|map|flag|coat[_ ]of[_ ]arms|seal|emblem|locator|diagram|insignia|location)/.test(file);
}

/**
 * Hero photo for a trip: the lead image of the first Wikipedia article in
 * `titles` that yields a real, suitable photograph, normalized to a
 * verified 1280px Commons thumbnail. Undefined if none qualifies.
 */
export async function coverImageFor(titles: string[]): Promise<string | undefined> {
  for (const t of titles.filter(Boolean)) {
    try {
      const res = await fetch(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, '_'))}`,
        { headers: { 'User-Agent': 'BlueMurr/1.0 (preset generator)' } },
      );
      if (!res.ok) continue;
      const j: any = await res.json();
      const src: string | undefined = j?.originalimage?.source ?? j?.thumbnail?.source;
      if (!src || !/\.(jpe?g|png|webp)(\/|\?|$)/i.test(src) || isUnsuitableHeroImage(src)) continue;
      const thumb = wikimediaThumb(src);
      if (isUnsuitableHeroImage(thumb)) continue;
      const head = await fetch(thumb, { method: 'HEAD', headers: { 'User-Agent': 'BlueMurr/1.0' } });
      if (head.ok && (head.headers.get('content-type') ?? '').startsWith('image/')) return thumb;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
