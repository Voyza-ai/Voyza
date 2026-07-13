import { PresetItinerary } from '@/data/presetItineraries';

/**
 * Instant client-side search over the Browse marketplace presets.
 *
 * Users type natural language ("I'm looking for a trip in Italy where I
 * can see a lot of architecture"), so the scorer:
 *   - drops filler words ("i'm", "looking", "trip", "where"…),
 *   - prefix-matches word variants (italy ↔ italian, architect ↔
 *     architecture),
 *   - expands travel concepts to related terms (architecture → cathedral,
 *     palace, temple, history, art…) so intent matches even when the
 *     literal word never appears in a preset,
 *   - weights matches by where they hit (country/city > vibe > title >
 *     activities/description).
 *
 * Pure functions, no network — filtering happens on every keystroke.
 */

// Filler words common in natural-language trip requests. Query tokens in
// this set carry no signal, so they're dropped before scoring.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'i', 'im', 'me', 'my', 'we', 'our', 'you',
  'is', 'are', 'was', 'be', 'being', 'been', 'am',
  'want', 'wants', 'wanted', 'like', 'love', 'need', 'looking', 'look',
  'searching', 'search', 'find', 'show', 'give', 'get', 'go', 'going',
  'visit', 'visiting', 'travel', 'traveling', 'travelling',
  'trip', 'trips', 'vacation', 'holiday', 'itinerary', 'itineraries',
  'tour', 'tours', 'somewhere', 'place', 'places',
  'in', 'on', 'at', 'to', 'for', 'of', 'with', 'and', 'or', 'but',
  'where', 'when', 'that', 'this', 'there', 'can', 'could', 'would',
  'will', 'see', 'sees', 'do', 'does', 'lot', 'lots', 'really', 'very',
  'some', 'much', 'many', 'more',
]);

// Travel concepts → related terms that appear in preset content. Expanded
// matches score slightly below direct matches so literal hits rank first.
const CONCEPTS: Record<string, string[]> = {
  architecture: ['history', 'art', 'cathedral', 'palace', 'temple', 'castle', 'church', 'basilica', 'monument', 'gothic', 'renaissance', 'shrine', 'pavilion', 'duomo', 'gates'],
  architectural: ['architecture'],
  buildings: ['architecture'],
  history: ['historic', 'ancient', 'temple', 'castle', 'ruins', 'museum', 'palace', 'monument', 'heritage', 'old'],
  historic: ['history'],
  culture: ['history', 'art', 'museum', 'temple', 'market', 'traditional'],
  cultural: ['culture'],
  art: ['museum', 'gallery', 'renaissance', 'painting'],
  museums: ['art', 'museum', 'history'],
  beach: ['beaches', 'island', 'coast', 'sea', 'ocean', 'surf', 'snorkel'],
  beaches: ['beach'],
  island: ['beach', 'islands'],
  food: ['foodie', 'eat', 'eating', 'cuisine', 'restaurant', 'street', 'market', 'ramen', 'sushi', 'pasta', 'tapas', 'culinary', 'dining'],
  foodie: ['food'],
  eat: ['food'],
  culinary: ['food'],
  nightlife: ['bars', 'clubs', 'party', 'night', 'tango', 'samba'],
  party: ['nightlife'],
  nature: ['hiking', 'mountains', 'park', 'forest', 'lake', 'outdoors', 'valley', 'grove', 'bamboo', 'andes'],
  hiking: ['nature', 'trek', 'mountains'],
  outdoors: ['nature'],
  adventure: ['nature', 'hiking', 'kayak', 'trek', 'explore'],
  romantic: ['romance', 'honeymoon', 'sunset', 'couples'],
  romance: ['romantic'],
  honeymoon: ['romance', 'romantic'],
  relaxing: ['relax', 'onsen', 'spa', 'hot', 'spring', 'beach'],
  relax: ['relaxing'],
  train: ['rail', 'trains', 'railway'],
  trains: ['train'],
  rail: ['train'],
  cheap: ['budget', 'affordable'],
  budget: ['cheap', 'affordable'],
  affordable: ['budget'],
  temples: ['temple', 'shrine', 'history'],
  city: ['urban', 'metropolis'],
  cities: ['city'],
  europe: ['european'],
  asia: ['asian'],
  // Climate & geography — descriptive words users reach for that map to
  // trip traits rather than literal content.
  tropical: ['jungle', 'humid', 'palm', 'island', 'beach', 'surf', 'rice', 'lagoon', 'warm'],
  warm: ['tropical', 'sunny', 'summer', 'beach', 'mediterranean'],
  sunny: ['warm', 'summer', 'beach', 'coastal', 'mediterranean'],
  sunshine: ['sunny'],
  hot: ['warm', 'tropical'],
  cold: ['winter', 'nordic', 'glaciers', 'geothermal', 'northern'],
  winter: ['cold', 'nordic', 'northern', 'lights', 'glaciers'],
  snow: ['winter', 'glaciers', 'nordic'],
  summer: ['warm', 'beach', 'mediterranean', 'islands', 'sunsets'],
  jungle: ['tropical', 'rainforest', 'nature'],
  paradise: ['island', 'beach', 'tropical', 'lagoon'],
  exotic: ['tropical', 'temples', 'markets', 'bazaars'],
  mountains: ['andes', 'hiking', 'volcano', 'nature', 'valley'],
  volcano: ['geothermal', 'glaciers', 'mountains'],
  waterfalls: ['waterfall', 'nature', 'geothermal'],
  coastal: ['coast', 'seaside', 'beach', 'sunny'],
  ocean: ['sea', 'beach', 'coastal', 'island'],
  sea: ['coastal', 'beach', 'mediterranean', 'seaside'],

  // Trip styles & occasions.
  backpacking: ['budget', 'street', 'cheap', 'tropical'],
  luxury: ['premium', 'resort', 'villas', 'fine'],
  weekend: ['break', 'quick', 'escape'],
  quick: ['weekend', 'break', 'escape'],
  getaway: ['weekend', 'escape', 'break'],
  escape: ['weekend', 'getaway', 'break'],
  honeymooning: ['honeymoon'],
  anniversary: ['romance', 'romantic', 'honeymoon'],
  chill: ['relaxing', 'beach', 'sunsets'],
  wellness: ['spa', 'onsen', 'geothermal', 'lagoon', 'relaxing', 'springs'],
  spa: ['wellness', 'onsen', 'geothermal', 'springs'],
  spiritual: ['temple', 'shrine', 'zen', 'blessing'],
  diving: ['snorkel', 'reef', 'beach', 'island'],
  snorkeling: ['snorkel', 'diving', 'beach'],
  surfing: ['surf', 'beach'],
  shopping: ['market', 'bazaar', 'markets'],
  photography: ['sunset', 'sunsets', 'viewpoint', 'scenic', 'lights'],

  // Country adjectives that prefix matching alone can't bridge.
  // (japanese↔japan, german↔germany etc. work via prefix already.)
  dutch: ['netherlands', 'amsterdam'],
  french: ['france'],
  spanish: ['spain'],
  greek: ['greece'],
  czech: ['czechia', 'prague'],
  italian: ['italy'],
};

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');
}

function tokenize(s: string): string[] {
  return normalize(s)
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Two tokens match if equal, or one prefixes the other (min 4 chars) —
 *  bridges word forms like italy/italian, architect/architecture. */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const min = Math.min(a.length, b.length);
  if (min < 4) return false;
  return a.startsWith(b) || b.startsWith(a);
}

type IndexedTerm = { term: string; weight: number };

/** Flatten a preset into weighted searchable terms. Higher weight = a hit
 *  there says more about the trip (country beats a word in a description). */
function buildIndex(preset: PresetItinerary): IndexedTerm[] {
  const terms: IndexedTerm[] = [];
  const add = (text: string | undefined, weight: number) => {
    for (const t of tokenize(text ?? '')) terms.push({ term: t, weight });
  };

  // Invisible search tags — curated trip traits ("tropical", "northern
  // lights") that users search for but visible text may not contain.
  for (const tag of preset.searchTags ?? []) add(tag, 4);

  for (const city of preset.cities) {
    add(city.country, 5);
    add(city.name, 5);
    for (const v of city.vibes) add(v, 4);
    for (const a of city.activities) add(a, 2);
    for (const r of city.restaurants) {
      add(r.cuisine, 2);
      add(r.name, 1);
    }
    if (city.transportOut) add(city.transportOut.mode, 2);
  }
  add(preset.title, 3);
  add(preset.scope, 3);
  add(preset.tagline, 2);
  add(preset.description, 2);
  return terms;
}

export type PresetSearchResult = {
  preset: PresetItinerary;
  score: number;
};

/**
 * Rank presets against a natural-language query. Empty/filler-only queries
 * return everything (unfiltered marketplace). Otherwise only presets with
 * at least one meaningful match are returned, best first.
 */
export function searchPresets(
  query: string,
  presets: PresetItinerary[],
): PresetSearchResult[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    return presets.map((preset) => ({ preset, score: 0 }));
  }

  const results: PresetSearchResult[] = [];
  for (const preset of presets) {
    const index = buildIndex(preset);
    let score = 0;

    for (const qt of queryTokens) {
      // Direct match at full strength, concept-expanded at 70%.
      const candidates: Array<{ token: string; factor: number }> = [
        { token: qt, factor: 1 },
        ...(CONCEPTS[qt] ?? []).map((c) => ({ token: c, factor: 0.7 })),
      ];

      let best = 0;
      const evidence = new Set<string>();
      for (const { token, factor } of candidates) {
        for (const { term, weight } of index) {
          if (tokensMatch(token, term)) {
            best = Math.max(best, weight * factor);
            evidence.add(term);
          }
        }
      }
      // Coverage bonus: a trip with many distinct matches for a concept
      // (cathedral + basilica + renaissance + gothic…) genuinely fits it
      // better than one with a single tangential hit — this breaks the
      // flat ties single-word queries otherwise produce.
      if (best > 0) {
        score += best + Math.min(evidence.size - 1, 6) * 0.15;
      }
    }

    if (score > 0) results.push({ preset, score });
  }

  results.sort((a, b) => b.score - a.score);

  // Relevance floor: drop the noise tail — trips scoring far below the
  // best match are barely related and dilute the "filtered" feel. 45%
  // keeps genuinely comparable trips (vague queries score everything
  // similarly) while pruning tangential hits on specific queries, e.g.
  // "Italy architecture" no longer drags along temple trips elsewhere.
  const top = results[0]?.score ?? 0;
  return results.filter((r) => r.score >= top * 0.45);
}
