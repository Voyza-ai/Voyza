/**
 * Geography for the day planner: distances, travel-time estimates between two
 * slots, and "nearest next stop" picking.
 *
 * Coordinates come from the backend's POI provider (Google Places, Foursquare
 * or OpenStreetMap — see backend/src/services/places), never from the AI.
 * Anything without them is simply not geo-aware: every helper here answers
 * null for it and the planner keeps its old queue-order behaviour.
 *
 * Travel time is an ESTIMATE from straight-line distance unless the backend
 * returned measured Google Distance Matrix legs (only with a Google key).
 */

export type Located = { lat?: number | null; lng?: number | null; placeId?: string | null };
export type LatLng = { lat: number; lng: number };

export type TravelMode = 'walk' | 'transit';

/** Travel from the previous slot to this one. */
export type TravelInfo = {
  minutes: number;
  distanceKm: number;
  mode: TravelMode;
  /** 'google' = Distance Matrix; 'estimate' = from straight-line distance. */
  source: 'google' | 'estimate';
  /** The placeId this leg starts from, so a stale leg (events re-ordered by hand) can be spotted. */
  fromPlaceId?: string;
};

/** Measured legs from the backend, keyed "fromPlaceId>toPlaceId". */
export type TravelLegs = Record<string, { minutes: number; distanceKm: number; mode: TravelMode }>;

export const hasCoords = (p: Located | null | undefined): p is Located & LatLng =>
  !!p &&
  typeof p.lat === 'number' &&
  typeof p.lng === 'number' &&
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lng);

/** Great-circle distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** City streets are not straight lines. */
const WALK_DETOUR = 1.25;
const WALK_KMH = 4.8;
/** Past this a walk is offered only if transit would not be quicker. */
export const WALK_MAX_MIN = 20;
const TRANSIT_DETOUR = 1.35;
const TRANSIT_KMH = 18;
/** Walking to the stop, waiting, walking from the stop. */
const TRANSIT_OVERHEAD_MIN = 10;

const ceilTo5 = (m: number) => Math.max(5, Math.ceil(m / 5) * 5);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Walk or transit time between two points, from straight-line distance. */
export function estimateTravel(a: LatLng, b: LatLng): TravelInfo {
  const km = haversineKm(a, b);
  const walkMin = ((km * WALK_DETOUR) / WALK_KMH) * 60;
  const transitMin = TRANSIT_OVERHEAD_MIN + ((km * TRANSIT_DETOUR) / TRANSIT_KMH) * 60;
  if (walkMin <= WALK_MAX_MIN || walkMin <= transitMin) {
    return { minutes: ceilTo5(walkMin), distanceKm: round1(km * WALK_DETOUR), mode: 'walk', source: 'estimate' };
  }
  return { minutes: ceilTo5(transitMin), distanceKm: round1(km * TRANSIT_DETOUR), mode: 'transit', source: 'estimate' };
}

/** Airport ↔ city: express train / taxi on fast roads, plus getting out of the terminal. */
const AIRPORT_DETOUR = 1.3;
const AIRPORT_KMH = 40;
const AIRPORT_OVERHEAD_MIN = 15;

/**
 * Travel between an arrival/departure hub and a stop. Airports get their own
 * estimate — city-transit speed would read FCO → Colosseum as two hours; a
 * station (city-centre stand-in) uses the ordinary one. Always an estimate.
 */
export function estimateHubTravel(hub: LatLng & { kind: 'airport' | 'station' }, stop: LatLng): TravelInfo {
  if (hub.kind === 'station') return estimateTravel(hub, stop);
  const km = haversineKm(hub, stop);
  const walkMin = ((km * WALK_DETOUR) / WALK_KMH) * 60;
  if (walkMin <= WALK_MAX_MIN) {
    return { minutes: ceilTo5(walkMin), distanceKm: round1(km * WALK_DETOUR), mode: 'walk', source: 'estimate' };
  }
  const minutes = AIRPORT_OVERHEAD_MIN + ((km * AIRPORT_DETOUR) / AIRPORT_KMH) * 60;
  return { minutes: ceilTo5(minutes), distanceKm: round1(km * AIRPORT_DETOUR), mode: 'transit', source: 'estimate' };
}

/**
 * Travel between two located things: the measured Google leg when the
 * backend gave one for this exact pair, otherwise the estimate. Null when
 * either end has no coordinates.
 */
export function travelBetween(
  from: Located | null | undefined,
  to: Located | null | undefined,
  legs?: TravelLegs | null,
): TravelInfo | null {
  if (!hasCoords(from) || !hasCoords(to)) return null;
  if (from.placeId && to.placeId && from.placeId === to.placeId) return null;
  const measured = from.placeId && to.placeId ? legs?.[`${from.placeId}>${to.placeId}`] : undefined;
  const info: TravelInfo = measured
    ? { ...measured, source: 'google' }
    : estimateTravel(from, to);
  return from.placeId ? { ...info, fromPlaceId: from.placeId } : info;
}

/**
 * Index of the candidate nearest `anchor`, among those with coordinates.
 * -1 when the anchor or every candidate lacks them — the caller then keeps
 * its queue order. Ties keep the earlier (higher-priority) candidate.
 */
export function nearestIndex<T extends Located>(anchor: Located | null | undefined, candidates: T[]): number {
  if (!hasCoords(anchor)) return -1;
  let best = -1;
  let bestKm = Infinity;
  candidates.forEach((c, i) => {
    if (!hasCoords(c)) return;
    const km = haversineKm(anchor, c);
    if (km < bestKm) {
      bestKm = km;
      best = i;
    }
  });
  return best;
}

/** Human label for a leg: "12 min walk · 0.9 km". */
export function travelLabel(t: TravelInfo): string {
  const how = t.mode === 'walk' ? 'walk' : 'transit';
  return `${t.minutes} min ${how} · ${t.distanceKm} km`;
}

type EventLike = Located & { category?: string; travelFromPrev?: TravelInfo };

/**
 * The leg to show between two consecutive calendar events: the one the
 * planner stored when it still starts from `prev`, else a fresh estimate.
 * Null when either is transport or unlocated — no connector is drawn.
 */
export function legBetweenEvents(prev: EventLike | undefined, evt: EventLike): TravelInfo | null {
  if (!prev || prev.category === 'transport' || evt.category === 'transport') return null;
  const stored = evt.travelFromPrev;
  if (!hasCoords(prev) || !hasCoords(evt)) return null;
  if (stored && stored.fromPlaceId && stored.fromPlaceId === prev.placeId) return stored;
  return travelBetween(prev, evt);
}

/** Copy only the coordinate fields of a located thing (no undefined keys). */
export function coordsOf(p: Located | null | undefined): { lat: number; lng: number; placeId?: string } | null {
  if (!hasCoords(p)) return null;
  return p.placeId ? { lat: p.lat, lng: p.lng, placeId: p.placeId } : { lat: p.lat, lng: p.lng };
}
