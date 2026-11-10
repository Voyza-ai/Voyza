import { createThrottle, Throttle } from './throttle';
import type { LatLng, PoiHit, PoiProvider } from './types';

/**
 * The three POI adapters. Which one runs is decided by `selectProvider` in
 * ./index from the keys present in the environment:
 *
 *   GOOGLE_PLACES_API_KEY → Google Places API (New) Text Search
 *   FOURSQUARE_API_KEY    → Foursquare Places search
 *   neither               → OpenStreetMap Nominatim (keyless)
 *
 * Every adapter takes a text query plus the city centre, and returns ONE
 * best hit or null. All of them time out per request, so a slow provider
 * degrades to "no coordinates" rather than holding the planner.
 */

/** Per-request timeout for every provider call. */
export const PROVIDER_TIMEOUT_MS = 5000;

/** How far from the city centre a provider is asked to look, in metres. */
export const SEARCH_RADIUS_M = 30_000;

function withTimeout(signal: AbortSignal | undefined, ms = PROVIDER_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

const validLatLng = (lat: number | null, lng: number | null): lat is number =>
  lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

// ─── Google Places (New) ─────────────────────────────────────

/** Google `types` that mean "a town or an area", not a venue. */
const GOOGLE_AREA_TYPES = new Set([
  'locality',
  'political',
  'administrative_area_level_1',
  'administrative_area_level_2',
  'administrative_area_level_3',
  'sublocality',
  'sublocality_level_1',
  'neighborhood',
  'country',
  'postal_code',
]);

export function googlePlacesProvider(apiKey: string, fetchImpl: typeof fetch = fetch): PoiProvider {
  return {
    name: 'google',
    async search(query, near, signal) {
      const body: Record<string, unknown> = { textQuery: query, maxResultCount: 1, languageCode: 'en' };
      if (near) {
        body.locationBias = {
          circle: { center: { latitude: near.lat, longitude: near.lng }, radius: SEARCH_RADIUS_M },
        };
      }
      const res = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.types',
        },
        body: JSON.stringify(body),
        signal: withTimeout(signal),
      });
      if (!res.ok) throw new Error(`google places ${res.status}`);
      const data: any = await res.json();
      const hit = data?.places?.[0];
      const lat = num(hit?.location?.latitude);
      const lng = num(hit?.location?.longitude);
      if (!hit?.id || !validLatLng(lat, lng)) return null;
      const types: string[] = Array.isArray(hit.types) ? hit.types : [];
      return {
        lat,
        lng: lng as number,
        placeId: `google:${hit.id}`,
        name: hit.displayName?.text,
        settlement: types.length > 0 && types.every((t) => GOOGLE_AREA_TYPES.has(t)),
      };
    },
  };
}

// ─── Foursquare ──────────────────────────────────────────────

/**
 * Foursquare's current Places API (places-api.foursquare.com, Bearer service
 * key). The response parser also accepts the legacy v3 shape
 * (`fsq_id` + `geocodes.main`) so either generation of key/response works.
 */
export function foursquareProvider(apiKey: string, fetchImpl: typeof fetch = fetch): PoiProvider {
  return {
    name: 'foursquare',
    async search(query, near, signal) {
      const params = new URLSearchParams({ query, limit: '1' });
      if (near) {
        params.set('ll', `${near.lat},${near.lng}`);
        params.set('radius', String(SEARCH_RADIUS_M));
      }
      const res = await fetchImpl(`https://places-api.foursquare.com/places/search?${params}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'X-Places-Api-Version': '2025-06-17',
        },
        signal: withTimeout(signal),
      });
      if (!res.ok) throw new Error(`foursquare ${res.status}`);
      const data: any = await res.json();
      const hit = data?.results?.[0];
      if (!hit) return null;
      const lat = num(hit.latitude ?? hit.geocodes?.main?.latitude);
      const lng = num(hit.longitude ?? hit.geocodes?.main?.longitude);
      const id = hit.fsq_place_id ?? hit.fsq_id;
      if (!id || !validLatLng(lat, lng)) return null;
      return { lat, lng: lng as number, placeId: `fsq:${id}`, name: hit.name };
    },
  };
}

// ─── OpenStreetMap Nominatim (keyless fallback) ──────────────

/**
 * Identifies us to the OSMF servers, as their usage policy requires. A stock
 * HTTP-library UA gets blocked.
 */
export const NOMINATIM_USER_AGENT =
  'BlueMurr/1.0 (multi-city trip planner; +https://bluemurr.com)';

/** 1 request/second is the policy's absolute maximum; 1.1 s leaves margin. */
export const NOMINATIM_GAP_MS = 1100;

/** Backlog beyond which a lookup is refused instead of queued. */
export const NOMINATIM_MAX_QUEUED = 120;

/** Half-width of the search box around the city centre, in degrees (~25-35 km). */
const VIEWBOX_DEG = 0.3;

/** ONE throttle per process — the policy limit is per application, not per caller. */
let sharedNominatimThrottle: Throttle | null = null;
export function nominatimThrottle(): Throttle {
  if (!sharedNominatimThrottle) {
    sharedNominatimThrottle = createThrottle(NOMINATIM_GAP_MS, { maxQueued: NOMINATIM_MAX_QUEUED });
  }
  return sharedNominatimThrottle;
}

export function nominatimProvider(
  opts: { fetchImpl?: typeof fetch; throttle?: Throttle; baseUrl?: string } = {},
): PoiProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? 'https://nominatim.openstreetmap.org';
  return {
    name: 'osm',
    async search(query, near, signal) {
      const throttle = opts.throttle ?? nominatimThrottle();
      const params = new URLSearchParams({
        q: query,
        format: 'jsonv2',
        limit: '1',
        'accept-language': 'en',
      });
      if (near) {
        // left,top,right,bottom; bounded=1 keeps a same-named place on another
        // continent out of the answer entirely.
        params.set(
          'viewbox',
          [near.lng - VIEWBOX_DEG, near.lat + VIEWBOX_DEG, near.lng + VIEWBOX_DEG, near.lat - VIEWBOX_DEG].join(','),
        );
        params.set('bounded', '1');
      }
      return throttle.run(async () => {
        const res = await fetchImpl(`${baseUrl}/search?${params}`, {
          headers: { Accept: 'application/json', 'User-Agent': NOMINATIM_USER_AGENT },
          signal: withTimeout(signal),
        });
        if (!res.ok) throw new Error(`nominatim ${res.status}`);
        const rows: any = await res.json();
        const hit = Array.isArray(rows) ? rows[0] : null;
        if (!hit) return null;
        const lat = num(hit.lat);
        const lng = num(hit.lon);
        if (!validLatLng(lat, lng) || !hit.osm_id) return null;
        const osmType = String(hit.osm_type ?? 'node').charAt(0).toUpperCase();
        const category = hit.category ?? hit.class;
        return {
          lat,
          lng: lng as number,
          placeId: `osm:${osmType}${hit.osm_id}`,
          name: hit.name || undefined,
          settlement:
            category === 'place' || (category === 'boundary' && hit.type === 'administrative'),
        } satisfies PoiHit;
      });
    },
  };
}

export type { LatLng };
