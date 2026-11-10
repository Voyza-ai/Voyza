/**
 * Points of interest — real coordinates for the AI's activity and restaurant
 * picks, so the day planner can order a day by geography.
 *
 * Coordinates ALWAYS come from a POI provider (Google Places, Foursquare, or
 * OpenStreetMap's Nominatim). The model only names places; it never supplies
 * a latitude or longitude, so a hallucinated venue simply fails to resolve
 * and the item keeps the planner's old, non-geographic behaviour.
 */

export type LatLng = { lat: number; lng: number };

export type ProviderName = 'google' | 'foursquare' | 'osm';

/** One provider answer for a text query. */
export type PoiHit = LatLng & {
  /** Provider-scoped id, prefixed with the provider: "google:ChIJ…", "fsq:4b0…", "osm:N123". */
  placeId: string;
  /** The provider's own display name for the place. */
  name?: string;
  /**
   * True when the hit is a town, district or administrative area rather than
   * a venue. "Explore Paris old town" resolving to Paris itself is a wrong
   * pin, not a useful one, so these are rejected.
   */
  settlement?: boolean;
};

export interface PoiProvider {
  readonly name: ProviderName;
  /**
   * Look one place up near `near`. Resolves null when the provider has no
   * answer; rejects only on transport failure (the caller treats both as
   * "no coordinates").
   */
  search(query: string, near: LatLng | null, signal?: AbortSignal): Promise<PoiHit | null>;
}

/** What the planner asks to place. */
export type PlaceRequestItem = {
  name: string;
  /** The AI's "as it appears on a map" form, when it gave one. Tried first. */
  placeQuery?: string | null;
  kind?: 'activity' | 'restaurant';
};

/** The answer for one requested item. Coordinates absent = unresolved. */
export type ResolvedPlace = {
  name: string;
  lat?: number;
  lng?: number;
  placeId?: string;
  /** Still queued at the provider when the deadline passed. */
  pending?: boolean;
};

export type TravelMode = 'walk' | 'transit';

/** One measured leg between two placeIds (Google Distance Matrix). */
export type TravelLeg = { minutes: number; distanceKm: number; mode: TravelMode };
