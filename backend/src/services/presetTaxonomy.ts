/**
 * Browse taxonomy — the locked Phase 1 decisions, as code.
 *
 * Vibes: the app-wide 8 (beach, food, history, art, nature, city,
 *   nightlife, romance). The roadmap's draft names map onto them —
 *   "adventure" → nature, "culture" → history + art, "food+wine" → food —
 *   so a preset, a planned trip, and a filter chip all speak one language.
 * Duration buckets: weekend (≤4 nights) · one-week (5–8) · two-weeks
 *   (9–15) · month (16+).
 * Budget tiers ($–$$$$): per-person estimated cost, so a solo trip and a
 *   group trip of the same style land in the same tier.
 * Origin regions (locked list, ORIGIN_REGIONS below): US-East, US-West,
 *   Europe, Asia — each with a hub airport. Every catalog preset is
 *   generated and priced from US-East (New York, JFK — the same default
 *   Browse saves with); "Plan a similar trip" re-prices from the traveler's
 *   own detected origin, so other regions get live prices there.
 * "family" (from the roadmap draft) is deliberately NOT a vibe: nothing in
 *   a trip's data can tell whether it's kid-friendly, and a tag we can't
 *   verify would mislead. Revisit with an explicit editorial flag.
 * Categories: a fixed, editorially-named set (below) gets dedicated SEO
 *   landing pages; everything else stays a dynamic filter on /browse.
 */

export type PresetVibe =
  | 'beach'
  | 'food'
  | 'history'
  | 'art'
  | 'nature'
  | 'city'
  | 'nightlife'
  | 'romance';

/** Minimal structural view of a preset (frontend PresetItinerary shape). */
export type PresetData = {
  slug: string;
  title: string;
  tagline: string;
  description: string;
  searchTags?: string[];
  coverGradient: string;
  coverImage?: string;
  flags: string;
  scope: string;
  travelers: number;
  /** Generator's own estimate, per person (hotels + inter-city transport).
   *  Validated against the priced trip; absent on curated presets. */
  budgetEstimate?: number;
  cities: Array<{
    name: string;
    country: string;
    nights: number;
    hotel: { name: string; rating: number; pricePerNight: number; area: string };
    activities: string[];
    restaurants: Array<{ name: string; cuisine: string; priceRange: string }>;
    vibes: PresetVibe[];
    transportOut?: { mode: 'flight' | 'train'; operator: string; duration: string; price: number };
  }>;
};

export type Region = 'europe' | 'asia' | 'americas' | 'africa-middle-east' | 'oceania';

/** Where travelers fly FROM. Presets are priced from the US-East hub. */
export type OriginRegion = 'us-east' | 'us-west' | 'europe' | 'asia';

export const ORIGIN_REGIONS: Record<OriginRegion, { label: string; hubCity: string; hubAirport: string }> = {
  'us-east': { label: 'US East Coast', hubCity: 'New York', hubAirport: 'JFK' },
  'us-west': { label: 'US West Coast', hubCity: 'Los Angeles', hubAirport: 'LAX' },
  europe: { label: 'Europe', hubCity: 'London', hubAirport: 'LHR' },
  asia: { label: 'Asia', hubCity: 'Singapore', hubAirport: 'SIN' },
};

/** Origin every catalog preset is generated and priced from. */
export const PRESET_ORIGIN_REGION: OriginRegion = 'us-east';
export type DurationBucket = 'weekend' | 'one-week' | 'two-weeks' | 'month';
export type BudgetTier = '$' | '$$' | '$$$' | '$$$$';

export const REGION_BY_COUNTRY: Record<string, Region> = {};
/** Lowercase, "&" → "and", collapsed spaces: "Turks & Caicos" = "turks and caicos". */
export const countryKey = (c: string) => c.toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
const add = (region: Region, countries: string[]) => {
  for (const c of countries) REGION_BY_COUNTRY[countryKey(c)] = region;
};
add('europe', [
  'France', 'Italy', 'Spain', 'Portugal', 'Germany', 'Netherlands', 'Belgium', 'Luxembourg',
  'Switzerland', 'Austria', 'Czechia', 'Czech Republic', 'Poland', 'Hungary', 'Slovakia',
  'Slovenia', 'Croatia', 'Greece', 'United Kingdom', 'UK', 'England', 'Scotland', 'Ireland',
  'Iceland', 'Norway', 'Sweden', 'Denmark', 'Finland', 'Estonia', 'Latvia', 'Lithuania',
  'Montenegro', 'Albania', 'Bosnia and Herzegovina', 'Serbia', 'Romania', 'Bulgaria',
  'Malta', 'Cyprus', 'Monaco', 'Turkey', 'Türkiye',
]);
add('asia', [
  'Japan', 'South Korea', 'Korea', 'China', 'Hong Kong', 'Taiwan', 'Thailand', 'Vietnam',
  'Cambodia', 'Laos', 'Malaysia', 'Singapore', 'Indonesia', 'Philippines', 'India',
  'Sri Lanka', 'Nepal', 'Maldives', 'Myanmar', 'Bhutan', 'Mongolia',
]);
add('americas', [
  'United States', 'USA', 'Canada', 'Mexico', 'Guatemala', 'Belize', 'Costa Rica', 'Panama',
  'Cuba', 'Dominican Republic', 'Puerto Rico', 'Jamaica', 'Bahamas', 'Colombia', 'Ecuador',
  'Peru', 'Bolivia', 'Chile', 'Argentina', 'Uruguay', 'Brazil', 'Paraguay',
  'Turks and Caicos', 'Turks and Caicos Islands', 'Aruba', 'Barbados', 'Saint Lucia', 'St Lucia',
  'Cayman Islands', 'Bermuda', 'Curaçao', 'Curacao', 'Antigua and Barbuda', 'Grenada',
  'Trinidad and Tobago', 'US Virgin Islands', 'British Virgin Islands', 'Martinique', 'Guadeloupe',
]);
add('africa-middle-east', [
  'Morocco', 'Egypt', 'Tunisia', 'South Africa', 'Kenya', 'Tanzania', 'Namibia', 'Botswana',
  'Rwanda', 'Uganda', 'Ghana', 'Senegal', 'Mauritius', 'Seychelles', 'United Arab Emirates',
  'UAE', 'Oman', 'Jordan', 'Israel', 'Qatar', 'Saudi Arabia',
]);
add('oceania', ['Australia', 'New Zealand', 'Fiji', 'French Polynesia']);

export const REGION_LABELS: Record<Region, string> = {
  europe: 'Europe',
  asia: 'Asia',
  americas: 'the Americas',
  'africa-middle-east': 'Africa & the Middle East',
  oceania: 'Oceania',
};

export function presetNights(p: PresetData): number {
  return p.cities.reduce((s, c) => s + c.nights, 0);
}

/** Identical to the frontend's presetCostFor (rooms sleep 2; transport
 *  per person) so cards, filters, and SEO pages agree on every number. */
export function presetCostFor(p: PresetData, travelers: number): number {
  const rooms = Math.max(1, Math.ceil(travelers / 2));
  const hotels = p.cities.reduce((s, c) => s + c.hotel.pricePerNight * c.nights, 0) * rooms;
  const transport = p.cities.reduce((s, c) => s + (c.transportOut?.price ?? 0) * travelers, 0);
  return Math.round(hotels + transport);
}

export function presetCost(p: PresetData): number {
  return presetCostFor(p, p.travelers);
}

export function presetVibes(p: PresetData): PresetVibe[] {
  const set = new Set<PresetVibe>();
  for (const c of p.cities) for (const v of c.vibes) set.add(v);
  return Array.from(set);
}

/** Majority region across the preset's cities (first city breaks ties). */
export function presetRegion(p: PresetData): Region {
  const counts = new Map<Region, number>();
  for (const c of p.cities) {
    const r = REGION_BY_COUNTRY[countryKey(c.country)];
    if (r) counts.set(r, (counts.get(r) ?? 0) + c.nights);
  }
  const first = REGION_BY_COUNTRY[countryKey(p.cities[0]?.country ?? '')];
  let best: Region = first ?? 'europe';
  let bestN = -1;
  for (const [r, n] of counts) {
    if (n > bestN || (n === bestN && r === first)) {
      best = r;
      bestN = n;
    }
  }
  return best;
}

export function durationBucket(nights: number): DurationBucket {
  if (nights <= 4) return 'weekend';
  if (nights <= 8) return 'one-week';
  if (nights <= 15) return 'two-weeks';
  return 'month';
}

export function budgetTier(costPerPerson: number): BudgetTier {
  if (costPerPerson < 750) return '$';
  if (costPerPerson < 1500) return '$$';
  if (costPerPerson < 3000) return '$$$';
  return '$$$$';
}

export type PresetFacts = {
  vibes: PresetVibe[];
  region: Region;
  nights: number;
  estCost: number;
  costPerPerson: number;
  durationBucket: DurationBucket;
  budgetTier: BudgetTier;
};

export function presetFacts(p: PresetData): PresetFacts {
  const nights = presetNights(p);
  const estCost = presetCost(p);
  const costPerPerson = Math.round(estCost / Math.max(1, p.travelers));
  return {
    vibes: presetVibes(p),
    region: presetRegion(p),
    nights,
    estCost,
    costPerPerson,
    durationBucket: durationBucket(nights),
    budgetTier: budgetTier(costPerPerson),
  };
}

// ── Categories: dedicated rows + SEO landing pages ──────────────────────

export type CategoryDef = {
  slug: string;
  /** Row heading on /browse and the page <h1>. */
  title: string;
  /** <title> / og:title — the long-tail query this page targets. */
  seoTitle: string;
  /** <meta name="description"> (≤160 chars). */
  metaDescription: string;
  /** Editorial intro paragraph on the landing page. */
  intro: string;
  matches: (f: PresetFacts) => boolean;
};

const has = (f: PresetFacts, ...v: PresetVibe[]) => v.some((x) => f.vibes.includes(x));

export const CATEGORIES: CategoryDef[] = [
  {
    slug: 'romance-in-europe',
    title: 'Romance in Europe',
    seoTitle: 'Romantic Europe Trips from New York — Ready-Made Itineraries',
    metaDescription:
      'Hand-picked romantic European itineraries from NYC: sunset cities, boutique stays, and the routes between them, priced and ready to customize.',
    intro:
      'Golden-hour terraces, candlelit trattorias, and cities made for wandering hand in hand. Every trip below is a complete route — stays, transport, and what to do — that you can open and make your own in a click.',
    matches: (f) => f.region === 'europe' && has(f, 'romance'),
  },
  {
    slug: 'culture-under-2k',
    title: 'Culture under $2k',
    seoTitle: 'Culture Trips Under $2,000 per Person — Museums, History & Art',
    metaDescription:
      'Museum-and-monument itineraries that come in under $2,000 per person, with real hotels and the cheapest routes between cities.',
    intro:
      'History and art without the luxury price tag. These itineraries pack in the museums, old towns, and landmarks worth crossing an ocean for — all estimated under $2,000 per person.',
    matches: (f) => has(f, 'history', 'art') && f.costPerPerson <= 2000,
  },
  {
    slug: 'adventure-trips-from-nyc',
    title: 'Adventure trips from NYC',
    seoTitle: 'Adventure Trips from NYC — Hiking, Volcanoes & Wild Landscapes',
    metaDescription:
      'Outdoor-first itineraries departing New York: hikes, glaciers, jungles, and coastlines, with every leg of the route already worked out.',
    intro:
      'For the trips you come home sunburned and a little sore from. Glaciers, volcanoes, jungle ruins, and coastal trails — each route below starts in New York and handles the logistics so you can chase the views.',
    matches: (f) => has(f, 'nature'),
  },
  {
    slug: 'beach-escapes',
    title: 'Beach escapes',
    seoTitle: 'Beach Vacation Itineraries — Islands & Coastal Trips',
    metaDescription:
      'Island-hopping and coastal itineraries with beachside stays, ferry and flight routes, and the best spots to swim, eat, and watch the sunset.',
    intro:
      'Turquoise water, whitewashed towns, and long lunches by the sea. These itineraries string together the best beaches in each region, with the ferries and flights between them already sorted.',
    matches: (f) => has(f, 'beach'),
  },
  {
    slug: 'food-trips',
    title: 'Trips for food lovers',
    seoTitle: 'Food & Wine Travel Itineraries — Eat Your Way Around the World',
    metaDescription:
      'Itineraries built around markets, street food, and restaurants worth the flight — from ramen counters to tapas bars and trattorias.',
    intro:
      'Plan around your appetite. Each of these routes is built around the markets, street food stalls, and restaurants locals actually queue for — with somewhere great to sleep it off in between.',
    matches: (f) => has(f, 'food'),
  },
  {
    slug: 'weekend-getaways',
    title: 'Weekend getaways',
    seoTitle: 'Long-Weekend Trips from NYC — 4 Nights or Less',
    metaDescription:
      'Short international getaways from New York you can do in a long weekend: one or two cities, four nights or fewer, fully planned.',
    intro:
      "No week off? No problem. These trips are four nights or fewer — one or two cities, tight logistics, and maximum payoff for a long weekend's worth of vacation days.",
    matches: (f) => f.durationBucket === 'weekend',
  },
  {
    slug: 'two-week-epics',
    title: 'Two-week epics',
    seoTitle: 'Two-Week Multi-Country Itineraries — The Big Trip, Planned',
    metaDescription:
      'Multi-city and multi-country itineraries for 9–15 nights: the big trip, with every train, flight, and hotel in the right order.',
    intro:
      'The once-a-year big one. These multi-city routes run nine nights or more, crossing countries by train and short-hop flights in the order that saves you the most time and money.',
    matches: (f) => f.durationBucket === 'two-weeks' || f.durationBucket === 'month',
  },
  {
    slug: 'asia-adventures',
    title: 'Asia adventures',
    seoTitle: 'Asia Travel Itineraries — Japan, Southeast Asia & Beyond',
    metaDescription:
      'Ready-made Asia itineraries from neon Tokyo to Angkor Wat: temples, street food, and island hops, with every leg already routed.',
    intro:
      'From bullet trains to tuk-tuks. These routes cover the best of Asia — temples, night markets, islands, and megacities — with the trickiest part, the order and the connections, already done for you.',
    matches: (f) => f.region === 'asia',
  },
];

export function categoriesFor(f: PresetFacts): string[] {
  return CATEGORIES.filter((c) => c.matches(f)).map((c) => c.slug);
}
