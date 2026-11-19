/**
 * The city guide's hotel list window ("Find more hotels") and its hotel map
 * ("Open map").
 *
 * The guide lists four of a city's hotels at a time. "Find more hotels" moves
 * the window on to the next four the trip already holds and, once those run
 * out, asks the hotel search for its next page. The traveller's pick never
 * changes on its own: when it is not in the window it is shown above it.
 *
 * The map pins each listed hotel where Booking says it is. Hotels saved before
 * the search carried coordinates get them from a repeat of the same search,
 * and failing that from a name lookup that has to agree with the name (see
 * `sameHotelName`) — a pin is only placed for a lodging near the city whose
 * name is the hotel's own, never a pub, an office, or a sibling of the chain.
 */

import type { City, Hotel, ScheduledEvent } from './types';
import type { GeoPoint } from './geocode';
import { cityCentre } from './landmarks';
import { distanceKm } from './citySpots';
import { searchHotels } from './api';

/** Hotels the guide lists at a time. */
export const HOTELS_PER_SET = 4;

/** A hotel as the guide shows it: its slot in `city.hotels` and whether it is the pinned pick. */
export type HotelEntry = { hotel: Hotel; index: number; pinned?: boolean };

/**
 * The rows for one window of the list. The pick (when the stay is not a
 * custom hotel) leads when the window does not already hold it, so the trip's
 * hotel is always in view and never changes behind the traveller's back.
 */
export function hotelWindow(city: Pick<City, 'hotels' | 'selectedHotelIndex' | 'customHotel'>, offset: number): HotelEntry[] {
  const hotels = city.hotels ?? [];
  const start = Math.max(0, Math.min(offset, Math.max(0, hotels.length - 1)));
  const rows: HotelEntry[] = hotels
    .slice(start, start + HOTELS_PER_SET)
    .map((hotel, k) => ({ hotel, index: start + k }));
  const sel = city.selectedHotelIndex;
  if (!city.customHotel && hotels[sel] && !rows.some((r) => r.index === sel)) {
    rows.unshift({ hotel: hotels[sel], index: sel, pinned: true });
  }
  return rows;
}

export const hotelKey = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The hotels in `fresh` the city does not already list (by name). */
export function newHotelsOnly(existing: Hotel[], fresh: Hotel[]): Hotel[] {
  const seen = new Set(existing.map((h) => hotelKey(h.name)));
  const out: Hotel[] = [];
  for (const h of fresh) {
    const k = hotelKey(h.name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

/** A hotel's own coordinates, when it carries a usable pair. */
export function hotelPoint(h: Hotel): GeoPoint | null {
  return typeof h.lat === 'number' && typeof h.lng === 'number' && Number.isFinite(h.lat) && Number.isFinite(h.lng)
    ? { lat: h.lat, lon: h.lng }
    : null;
}

/** How long the map waits on the repeat search for coordinates. */
const SEARCH_WAIT_MS = 4000;

/** A hotel further than this from the city centre is a wrong match. */
export const MAX_HOTEL_KM = 40;
/** Two different hotels this close resolved to the same building: the second is a wrong match. */
const SAME_SPOT_KM = 0.03;

export type HotelPin = HotelEntry & { point: GeoPoint };

// ─── Finding a hotel by name ─────────────────────────────────────────

/** Words that say nothing about WHICH hotel it is. */
const GENERIC = new Set([
  'hotel', 'hotels', 'the', 'by', 'and', 'de', 'des', 'du', 'la', 'le', 'les', 'l', 'd', 'of', 'at', 'a', 'an',
  'collection', 'aparthotel', 'apartments', 'apartment', 'resort', 'spa',
]);
const SPELLING: Record<string, string> = { st: 'saint', ste: 'sainte' };

/** The words that identify a hotel: its name without the city, the country and filler. */
export function nameTokens(name: string, place: { name: string; country?: string }): Set<string> {
  const words = (t: string) =>
    t
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map((w) => SPELLING[w] ?? w);
  const skip = new Set(Array.from(GENERIC).concat(words(place.name), words(place.country ?? '')));
  return new Set(words(name).filter((w) => !skip.has(w)));
}

/**
 * Whether a place the geocoder found is the hotel Booking named.
 *
 * Every identifying word of the found name has to be in Booking's name, and
 * it has to cover most of Booking's: "ibis Montparnasse Catalogne" is "Ibis
 * Paris Gare Montparnasse Catalogne", "Hôtel Novotel Paris Porte d'Orléans"
 * is "Novotel Paris 14 Porte d'Orléans". Measured on the Paris and London
 * lists (2026-11-19), the fuzzy geocoder also offered "Hôtel Bradford Elysées
 * - Astotel" for "Hotel Monterosa - Astotel", "Ibis Paris Tour Eiffel" for
 * "Pullman Paris Tour Eiffel", "Novotel London Tower Bridge" for "Novotel
 * London Bridge" and a bare "hub" for both hub hotels — each fails here.
 */
export function sameHotelName(booking: string, found: string, place: { name: string; country?: string }): boolean {
  const want = nameTokens(booking, place);
  const got = nameTokens(found, place);
  if (want.size === 0 || got.size === 0) return false;
  const gotList = Array.from(got);
  if (!gotList.every((w) => want.has(w))) return false;
  if (got.size === want.size) return true;
  return got.size >= 2 && got.size / want.size >= 0.6;
}

type Candidate = { name: string; point: GeoPoint };
/** Lodging kinds a hotel from Booking can be mapped as. */
const LODGING = new Set(['hotel', 'hostel', 'guest_house', 'apartment', 'motel']);

const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const LOOKUP_TIMEOUT_MS = 8000;

async function getJson(url: string, fetchImpl: typeof fetch): Promise<any | 'error'> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    return res.ok ? await res.json() : 'error';
  } catch {
    return 'error';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Photon (OpenStreetMap, komoot): fuzzy, limited to tourism places, ranked
 * towards the city centre, and quick (~200 ms) with no one-a-second rule.
 */
async function photonCandidates(name: string, centre: GeoPoint, fetchImpl: typeof fetch): Promise<Candidate[] | 'error'> {
  const url = `${PHOTON}?q=${encodeURIComponent(name)}&lat=${centre.lat}&lon=${centre.lon}&limit=5&lang=en&osm_tag=tourism`;
  const j = await getJson(url, fetchImpl);
  if (j === 'error') return 'error';
  return (j?.features ?? [])
    .filter((f: any) => LODGING.has(f?.properties?.osm_value) && Array.isArray(f?.geometry?.coordinates))
    .map((f: any) => ({ name: String(f.properties.name ?? ''), point: { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] } }));
}

// Nominatim allows one request a second; it is only asked when Photon is down.
let nominatimTail: Promise<unknown> = Promise.resolve();
const NOMINATIM_GAP_MS = 1100;

function nominatimCandidates(name: string, scope: string, fetchImpl: typeof fetch): Promise<Candidate[] | 'error'> {
  const run = nominatimTail.then(async () => {
    const url = `${NOMINATIM}?format=jsonv2&limit=3&accept-language=en&q=${encodeURIComponent(`${name}, ${scope}`)}`;
    const j = await getJson(url, fetchImpl);
    await new Promise((r) => setTimeout(r, NOMINATIM_GAP_MS));
    if (j === 'error' || !Array.isArray(j)) return 'error' as const;
    return j
      .filter((x: any) => x?.category === 'tourism' && LODGING.has(x?.type))
      .map((x: any) => ({ name: String(x.name ?? ''), point: { lat: Number(x.lat), lon: Number(x.lon) } }));
  });
  nominatimTail = run.catch(() => undefined);
  return run;
}

const GEO_STORAGE_KEY = 'voyza.hotelgeo.v1';
const HIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 3 * 24 * 60 * 60 * 1000;
type GeoCacheEntry = { at: number; point: GeoPoint | null };

function readGeoCache(): Record<string, GeoCacheEntry> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(window.localStorage.getItem(GEO_STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function writeGeoCache(key: string, entry: GeoCacheEntry) {
  try {
    const cache = readGeoCache();
    cache[key] = entry;
    window.localStorage.setItem(GEO_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage blocked: the next map asks again.
  }
}

/**
 * Where a hotel is, from its name: Photon first, Nominatim when Photon is
 * down. Only a lodging near the city whose name passes `sameHotelName`
 * counts, the closest such if several do. Answers, including "not found", are
 * kept in localStorage; a lookup that failed is not.
 */
export async function lookupHotelByName(
  name: string,
  place: { name: string; country?: string },
  centre: GeoPoint,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<GeoPoint | null> {
  const key = `${hotelKey(name)}|${hotelKey(place.name)}`;
  const hit = readGeoCache()[key];
  if (hit && Date.now() - hit.at < (hit.point ? HIT_TTL_MS : MISS_TTL_MS)) return hit.point;

  const scope = [place.name, place.country].filter(Boolean).join(', ');
  let found = await photonCandidates(name, centre, fetchImpl);
  if (found === 'error') found = await nominatimCandidates(name, scope, fetchImpl);
  if (found === 'error') return null;

  const ok = found
    .filter((c) => Number.isFinite(c.point.lat) && Number.isFinite(c.point.lon))
    .filter((c) => distanceKm(centre, c.point) <= MAX_HOTEL_KM && sameHotelName(name, c.name, place))
    .sort((a, b) => distanceKm(centre, a.point) - distanceKm(centre, b.point));
  const point = ok[0]?.point ?? null;
  writeGeoCache(key, { at: Date.now(), point });
  return point;
}

/**
 * Coordinates for each entry, from (in order) the hotel itself, a repeat of
 * the stay's hotel search, then a strict name lookup. Entries that none of
 * them place come back in `unplaced`, so the map can say so.
 */
export async function locateHotels(
  city: Pick<City, 'name' | 'country' | 'dates'>,
  travelers: number,
  entries: HotelEntry[],
  deps: {
    search?: typeof searchHotels;
    lookup?: (name: string, place: { name: string; country?: string }, centre: GeoPoint) => Promise<GeoPoint | null>;
    cityCentre?: (query: string) => Promise<GeoPoint | null>;
  } = {},
): Promise<{ centre: GeoPoint | null; pins: HotelPin[]; unplaced: HotelEntry[] }> {
  const search = deps.search ?? searchHotels;
  const lookup = deps.lookup ?? lookupHotelByName;
  const centreOf = deps.cityCentre ?? (() => cityCentre(city));
  const scope = [city.name, city.country].filter(Boolean).join(', ');

  const known = entries.map((e) => hotelPoint(e.hotel));
  let centre = await centreOf(scope).catch(() => null);
  if (!centre) {
    const pts = known.filter((p): p is GeoPoint => !!p);
    if (pts.length > 0) {
      centre = {
        lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
        lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length,
      };
    }
  }
  if (!centre) return { centre: null, pins: [], unplaced: entries };
  const near = (p: GeoPoint | null): p is GeoPoint => !!p && distanceKm(centre!, p) <= MAX_HOTEL_KM;

  const points: (GeoPoint | null)[] = known.map((p) => (near(p) ? p : null));

  // Saved before the search carried coordinates: the same search again,
  // matched by name. One request for the whole set, served from the
  // backend's cache when the stay was searched in the last ten minutes.
  if (points.some((p) => !p)) {
    // Bounded: the map waits on this, and a slow search must not hold it up.
    const rows = await Promise.race([
      search({
        city: city.name,
        checkin: city.dates.arrival,
        checkout: city.dates.departure,
        adults: travelers,
      }).catch(() => []),
      new Promise<[]>((r) => setTimeout(() => r([]), SEARCH_WAIT_MS)),
    ]);
    const byName = new Map<string, GeoPoint>();
    for (const r of rows) {
      if (typeof r.lat === 'number' && typeof r.lng === 'number') byName.set(hotelKey(r.name), { lat: r.lat, lon: r.lng });
    }
    entries.forEach((e, i) => {
      if (points[i]) return;
      const p = byName.get(hotelKey(e.hotel.name)) ?? null;
      if (near(p)) points[i] = p;
    });
  }

  // Last resort: the name (see `lookupHotelByName`), one hotel at a time.
  const byLookup = new Set<number>();
  for (let i = 0; i < entries.length; i++) {
    if (points[i]) continue;
    const hit = await lookup(entries[i].hotel.name, { name: city.name, country: city.country }, centre).catch(() => null);
    if (!near(hit)) continue;
    points[i] = hit;
    byLookup.add(i);
  }
  // A looked-up pin on the same spot as another hotel is a chain sibling
  // matching the name ("hub London - Paddington" answered with hub
  // Marylebone), and nothing says which of the two is right: leave it off.
  const clash = Array.from(byLookup).filter((i) =>
    points.some((p, j) => j !== i && p && distanceKm(p, points[i]!) < SAME_SPOT_KM),
  );
  clash.forEach((i) => {
    points[i] = null;
  });

  const pins: HotelPin[] = [];
  const unplaced: HotelEntry[] = [];
  entries.forEach((e, i) => {
    const p = points[i];
    if (p) pins.push({ ...e, point: p });
    else unplaced.push(e);
  });
  return { centre, pins, unplaced };
}

/** An activity or meal on the city's days that has real coordinates. */
export type ActivitySpot = { name: string; lat: number; lng: number; kind: 'activity' | 'restaurant' };

/**
 * The located activities and meals in a city's schedule, once each — the day
 * planner can place the same museum on two days. Transport, free time and
 * hand-added blocks without coordinates are left out.
 */
export function activitySpots(schedule: Record<string, ScheduledEvent[]> | undefined): ActivitySpot[] {
  const seen = new Set<string>();
  const out: ActivitySpot[] = [];
  for (const day of Object.keys(schedule ?? {}).sort()) {
    for (const e of schedule![day] ?? []) {
      if (e.category !== 'activity' && e.category !== 'restaurant') continue;
      if (typeof e.lat !== 'number' || typeof e.lng !== 'number') continue;
      // By name: a hand-added block and a planner-placed one can both be "British Museum".
      const key = e.title.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: e.title, lat: e.lat, lng: e.lng, kind: e.category });
    }
  }
  return out;
}
