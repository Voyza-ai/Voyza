/**
 * City "spots" — the individual places inside one city of a trip: the airport
 * you fly into, the hotel you sleep in, the restaurants you eat at, and the
 * activities / sights you've planned.
 *
 * Why this is fuzzy work: a trip stores activities as free text
 * ("Louvre early-entry morning", "Seine walk from Notre-Dame to the Eiffel
 * Tower") with no coordinates. So each spot is turned into a geocoder query
 * and looked up live. Two safeguards keep the map honest:
 *
 *   1. Queries are cleaned of time-of-day filler ("morning", "at sunset")
 *      that hurts geocoding, and scoped with ", <city>, <country>" so
 *      "Central Park" resolves in the right place.
 *   2. Any result further than MAX_SPOT_KM from the city centre is DROPPED
 *      rather than pinned — without this, a vague activity can resolve to a
 *      same-named street on another continent.
 *
 * Everything here is pure except `geocodeSpots`, which delegates to
 * lib/geocode (localStorage-cached, rate-limited to Nominatim's 1 req/sec).
 */

import { geocodeCities, GeoPoint, GeoPlace } from './geocode';
import type { City, Trip } from './types';

export type SpotKind = 'airport' | 'hotel' | 'restaurant' | 'sightseeing' | 'activity';

/** A spot before geocoding: what to look up and how to label it. */
export type SpotSeed = {
  kind: SpotKind;
  /** Display name, e.g. "Hôtel Malte Opéra". */
  name: string;
  /** Secondary line, e.g. "French · $$" or "Hotel". */
  detail?: string;
  /** Full geocoder query, city/country-scoped. */
  query: string;
};

/** A spot that resolved to real coordinates. */
export type Spot = SpotSeed & { point: GeoPoint };

/**
 * Beyond this from the city centre, a geocode hit is treated as wrong.
 *
 * Generous on purpose: day trips are a normal part of an itinerary (the Blue
 * Lagoon is ~50km from Reykjavik, Gullfoss ~120km), and a tight radius threw
 * them away as if they were errors. It still rejects the failures this guard
 * exists for, which are wrong by thousands of km — a Frankfurt hotel on a
 * Tokyo trip, or "Central Park, Paris" resolving in New York.
 */
export const MAX_SPOT_KM = 150;

/**
 * Spots further than this from the centre are left out of the map's opening
 * frame. They're still pinned — this only stops one far-flung day trip from
 * zooming the view out until the in-town spots collapse into a blob.
 */
export const CITY_FRAME_KM = 25;

/**
 * Words that describe WHEN or HOW an activity happens rather than WHERE it is.
 * They actively mislead the geocoder, so they're stripped from the query while
 * the display name keeps them.
 */
const FILLER =
  /\b(early[- ]entry|self[- ]guided|guided|optional|morning|afternoon|evening|sunset|sunrise|overnight|at night|night|day\s?trip|half[- ]day|full[- ]day|tickets?|reservation|entry)\b/gi;

/**
 * Landmark-ish words. Anything matching reads as sightseeing (a place you go
 * look at); everything else is an activity (something you do).
 */
const SIGHTSEEING =
  /\b(museum|gallery|cathedral|basilica|church|chapel|temple|shrine|mosque|synagogue|castle|palace|fort|fortress|tower|monument|memorial|ruins|colosseum|forum|pantheon|acropolis|abbey|dome|observatory|zoo|aquarium|gardens?|botanical|bridge|square|piazza|plaza|statue|library|opera house|theatre|theater)\b/i;

/**
 * OSM categories that mean "a place you go to look at". Checked against the
 * geocoder's own class/type, which is far more reliable than the wording: the
 * text "Louvre early-entry morning" contains no landmark word, but OSM knows
 * the resolved place is tourism=museum.
 */
const SIGHT_CLASSES = new Set(['historic', 'tourism']);
const SIGHT_TYPES = new Set([
  'museum',
  'gallery',
  'attraction',
  'artwork',
  'viewpoint',
  'monument',
  'memorial',
  'castle',
  'palace',
  'ruins',
  'archaeological_site',
  'fort',
  'city_gate',
  'place_of_worship',
  'cathedral',
  'church',
  'temple',
  'shrine',
  'park',
  'garden',
  'zoo',
  'theme_park',
  'aquarium',
]);

/**
 * Keyword guess from the itinerary wording. Used when the geocoder gives no
 * category (or before the lookup happens).
 */
export function classifySpot(text: string): 'sightseeing' | 'activity' {
  return SIGHTSEEING.test(text) ? 'sightseeing' : 'activity';
}

/**
 * Final classification once a place has resolved: trust OSM's category, and
 * fall back to the wording when it has nothing useful to say.
 */
export function classifyResolved(
  text: string,
  osmClass?: string,
  osmType?: string,
): 'sightseeing' | 'activity' {
  if (osmType && SIGHT_TYPES.has(osmType)) return 'sightseeing';
  if (osmClass && SIGHT_CLASSES.has(osmClass)) return 'sightseeing';
  // leisure=park/garden are sights too; amenity=restaurant etc. are not.
  if (osmClass === 'leisure' && osmType && /park|garden/.test(osmType)) return 'sightseeing';
  return classifySpot(text);
}

/** Strip timing/logistics filler so the geocoder sees mostly place words. */
export function cleanSpotQuery(text: string): string {
  return (
    text
      .replace(FILLER, ' ')
      .replace(/\s{2,}/g, ' ')
      // Removing filler can leave dangling connective words ("Sacré-Cœur in
      // the evening" → "Sacré-Cœur in the"), which only muddy the query. The
      // `+` strips a whole run of them, not just the last one.
      .replace(/(\s+\b(?:at|in|on|by|from|to|the|a|an|of|with|for)\b)+\s*$/i, '')
      .replace(/\s*[-–—,]\s*$/, '')
      .trim()
  );
}

/**
 * The leading run of proper-noun words, used as a second-chance query when the
 * full text is too descriptive to geocode. Stops at the first all-lowercase
 * word, which is almost always where the place name ends and the description
 * begins:
 *   "Senso-ji Temple and Asakusa old town" → "Senso-ji Temple"
 *   "TeamLab Planets digital art museum"   → "TeamLab Planets"
 *   "Shibuya Crossing at golden hour"      → "Shibuya Crossing"
 * Returns '' when the text doesn't start with a proper noun ("street food
 * tour"), in which case there's nothing better to try.
 */
export function properNounPrefix(text: string): string {
  const words = text.trim().split(/\s+/);
  const kept: string[] = [];
  for (const w of words) {
    // Keep capitalised words, and numerals that follow one (e.g. "Museum 21").
    const isProper = /^[A-ZÀ-Þ]/.test(w) || (kept.length > 0 && /^\d+$/.test(w));
    if (!isProper) break;
    kept.push(w);
  }
  return kept.join(' ').replace(/[,&]$/, '').trim();
}

/** Great-circle distance in km. */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The hotel actually in effect for a city (custom override → selected → first). */
function effectiveHotelName(city: City): { name: string; area?: string } | null {
  if (city.customHotel?.name) {
    return { name: city.customHotel.name, area: city.customHotel.area };
  }
  const h =
    (city.hotels && (city.hotels[city.selectedHotelIndex] ?? city.hotels[0])) || city.hotel;
  if (!h?.name || /^select hotel$/i.test(h.name)) return null;
  return { name: h.name, area: h.area };
}

/**
 * Everything worth pinning inside one city, in itinerary order:
 * airport (first city only, from the trip's origin airports) → hotel →
 * sights/activities → restaurants.
 */
export function buildCitySpots(trip: Trip, cityIndex: number): SpotSeed[] {
  const city = trip.cities?.[cityIndex];
  if (!city) return [];
  const scope = [city.name, city.country].filter(Boolean).join(', ');
  const seeds: SpotSeed[] = [];

  // Airport: the one serving THIS city — i.e. where you land or take off. Only
  // on the first/last city, because that's where a trip with a home origin
  // actually flies; pinning an airport beside every city would be noise on a
  // rail itinerary. Deliberately NOT the trip's origin airport: that sits at
  // home (JFK is in New York, not Paris) and would be rejected as too far away.
  const isFirst = cityIndex === 0;
  const isLast = cityIndex === (trip.cities?.length ?? 0) - 1;
  if (trip.origin?.city && (isFirst || isLast)) {
    // Query form matters and was found empirically: "airport, Paris, France"
    // returns nothing, and a bare "Amsterdam airport" resolves to a same-named
    // airfield in South Africa. "<city> airport, <country>" correctly returns
    // Schiphol / Charles de Gaulle / Václav Havel etc.
    seeds.push({
      kind: 'airport',
      name: `${city.name} airport`,
      detail: isFirst ? 'Arrival airport' : 'Departure airport',
      query: [`${city.name} airport`, city.country].filter(Boolean).join(', '),
    });
  }

  const hotel = effectiveHotelName(city);
  if (hotel) {
    seeds.push({
      kind: 'hotel',
      name: hotel.name,
      detail: hotel.area ? `Hotel · ${hotel.area}` : 'Hotel',
      query: `${cleanSpotQuery(hotel.name)}, ${scope}`,
    });
  }

  for (const raw of city.activities ?? []) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const kind = classifySpot(text);
    seeds.push({
      kind,
      name: text,
      detail: kind === 'sightseeing' ? 'Sight' : 'Activity',
      query: `${cleanSpotQuery(text)}, ${scope}`,
    });
  }

  for (const r of city.restaurants ?? []) {
    if (!r?.name) continue;
    seeds.push({
      kind: 'restaurant',
      name: r.name,
      detail: [r.cuisine, r.priceRange].filter(Boolean).join(' · ') || 'Restaurant',
      query: `${cleanSpotQuery(r.name)}, ${scope}`,
    });
  }

  // De-dupe by query so the same place isn't pinned twice.
  const seen = new Set<string>();
  return seeds.filter((s) => {
    const k = s.query.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Geocode seeds and keep only the ones that landed near the city. Returns the
 * resolved spots plus the names that were dropped, so the UI can be honest
 * about what it couldn't place.
 */
export async function geocodeSpots(
  seeds: SpotSeed[],
  cityCenter: GeoPoint,
): Promise<{ spots: Spot[]; dropped: string[] }> {
  if (seeds.length === 0) return { spots: [], dropped: [] };

  /** Turn a geocoder hit into a Spot, or null if it fails the sanity checks. */
  const accept = (seed: SpotSeed, p: GeoPlace | null): Spot | null => {
    if (!p || distanceKm(cityCenter, p) > MAX_SPOT_KM) return null;
    // An airport query that resolved to something that isn't an airport (a bus
    // stop named "Aerodrome", say) is a wrong pin, not a useful one.
    if (seed.kind === 'airport' && p.osmClass !== 'aeroway') return null;
    // Re-classify sights vs activities from what OSM says the place actually
    // is — the wording alone mislabels e.g. "Louvre early-entry morning".
    let kind: SpotKind = seed.kind;
    let detail = seed.detail;
    if (seed.kind === 'sightseeing' || seed.kind === 'activity') {
      kind = classifyResolved(seed.name, p.osmClass, p.osmType);
      // Keep the label in step with the kind — otherwise a pin can show the
      // Sights icon while its tooltip still reads "Activity".
      if (kind !== seed.kind) detail = kind === 'sightseeing' ? 'Sight' : 'Activity';
    }
    return { ...seed, kind, detail, point: { lat: p.lat, lon: p.lon } };
  };

  const resolved: Spot[] = [];
  const dropped: string[] = [];
  const retry: { seed: SpotSeed; query: string }[] = [];

  const first = await geocodeCities(seeds.map((s) => s.query));
  first.forEach((p, i) => {
    const seed = seeds[i];
    const ok = accept(seed, p);
    if (ok) {
      resolved.push(ok);
      return;
    }
    // Second chance: the leading proper noun, scoped to the COUNTRY rather
    // than the city. Two failures share this fix — descriptive text that's too
    // wordy to resolve ("Senso-ji Temple and Asakusa old town"), and day trips
    // that simply aren't inside the city ("Blue Lagoon", 50km from Reykjavik),
    // which can never resolve while the query says ", Reykjavik". The distance
    // guard still bounds how far a country-wide match may land.
    const prefix = properNounPrefix(seed.name);
    const parts = seed.query.split(', ');
    const country = parts.length > 1 ? parts[parts.length - 1] : '';
    const scoped = country ? `${prefix}, ${country}` : prefix;
    if (prefix && scoped.toLowerCase() !== seed.query.toLowerCase()) {
      retry.push({ seed, query: scoped });
    } else {
      dropped.push(seed.name);
    }
  });

  if (retry.length > 0) {
    const second = await geocodeCities(retry.map((r) => r.query));
    second.forEach((p, i) => {
      const { seed } = retry[i];
      const ok = accept(seed, p);
      if (ok) resolved.push(ok);
      else dropped.push(seed.name);
    });
  }

  // The retry pass appends out of sequence — restore itinerary order.
  const order = new Map(seeds.map((s, i) => [s.name, i]));
  resolved.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  return { spots: resolved, dropped };
}
